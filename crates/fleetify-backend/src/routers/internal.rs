//! Loopback-only dispatch endpoint used by stdio MCP servers
//! (currently `fleet-dispatch-mcp`) to route a sub-task from one
//! fleet agent to another without going back to the user.
//!
//! Wire surface: `POST /api/internal/dispatch` with
//! `X-Fleet-Internal: <secret>` header (the secret is generated at
//! backend startup and injected into the MCP's env via
//! `ClaudeBridge::build_mcp_config`). JWT auth is skipped — the
//! secret is the only authenticator here, and the endpoint is
//! intentionally not in `/api` so missing config can't accidentally
//! expose it to a CORS-allowed renderer call.
//!
//! Faithful with the Python `dispatch_mcp.py` flow:
//!   1. Resolve `agent` (UUID or case-insensitive title) → session_id.
//!   2. Verify ownership (target.user_id == caller.user_id).
//!   3. Reject self-dispatch.
//!   4. Persist the task as a `user` message on the target.
//!   5. Spawn the target's bridge in the background (same path as
//!      the staff `[[DISPATCH:]]` token).
//!   6. Return `{ ok, target_session_id, task_dispatched }` to the MCP.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::models::session::Session;
use crate::routers::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    // Mounted at `/api/internal` by `http::app`; this router just
    // adds the leaf routes so the final paths are
    // `POST /api/internal/dispatch`,
    // `POST /api/internal/permission_prompt`,
    // `POST /api/internal/routing/reload`, and
    // `POST /api/internal/providers/reload`.
    Router::new()
        .route("/dispatch", post(dispatch))
        .route("/spawn", post(spawn))
        .route("/permission_prompt", post(permission_prompt))
        // In-process MCP-over-HTTP permission server. Claude connects here as
        // a Streamable-HTTP MCP server (URL + Bearer baked into --mcp-config
        // by mcp_dispatch::builtin_mcp_config). Replaces the
        // `fleet-permission-mcp` stdio sidecar — no binary to build/bundle.
        .route(
            "/mcp/permission/{sid}",
            post(mcp_permission_post).get(mcp_permission_get),
        )
        .route("/routing/reload", post(routing_reload))
        .route("/providers/reload", post(providers_reload))
        .route("/providers/warm-health", post(providers_warm_health))
        .route("/accounts/http", axum::routing::get(http_accounts))
}

/// Loopback-only: list every HTTP provider account (the ones whose API key
/// lives in the OS keychain). The Tauri shell calls this during
/// `reload_backend` to learn which `(provider_id, account_id)` keychain
/// entries to read and push back as labeled keys. Returns metadata only — no
/// secrets (the shell already holds the keychain). Spans all users; the
/// keychain lookup naturally scopes to what actually exists.
async fn http_accounts(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }
    let rows = sqlx::query_as::<_, crate::models::account::Account>(
        "SELECT * FROM accounts WHERE kind = 'http'",
    )
    .fetch_all(&st.auth.pool)
    .await?;
    // The default ("main") account lives in the per-provider override table, not
    // the account row's is_default column — read it so labeled-key resolution
    // honours the user's main pick.
    let mut accounts: Vec<Value> = Vec::with_capacity(rows.len());
    for a in rows {
        let default_id: Option<String> = sqlx::query_scalar(
            "SELECT account_id FROM provider_default_account WHERE provider_id = ? LIMIT 1",
        )
        .bind(&a.provider_id)
        .fetch_optional(&st.auth.pool)
        .await
        .ok()
        .flatten();
        accounts.push(json!({
            "provider_id": a.provider_id,
            "account_id": a.id,
            "is_default": default_id.as_deref() == Some(a.id.as_str()),
        }));
    }
    Ok(Json(json!({ "accounts": accounts })))
}

/// Hot-reload hook for provider state. The Tauri shell walks the OS
/// keychain after every `providers_*` mutation, builds a `{provider_id:
/// api_key}` map, and POSTs it here so the in-process bridge dispatch
/// can read fresh credentials on the very next chat turn. Empty body
/// (or no `keys` field) is accepted as a no-op ping — keeps the wire
/// format flexible for future fields.
async fn providers_reload(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }
    if let Some(Json(v)) = body {
        if let Some(obj) = v.get("keys").and_then(|k| k.as_object()) {
            let map: std::collections::HashMap<String, String> = obj
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect();
            let count = map.len();
            crate::providers::keys::set_keys(map);
            tracing::info!(
                target: "fleet-backend",
                count = count,
                "providers reload: cache hydrated"
            );
        }
        // Multi-account labeled keys (one entry per (provider_id, account_id)).
        // Present-but-empty array ⇒ clear the account-key cache. Absent field
        // leaves it untouched, so legacy single-key reloads keep working.
        if let Some(arr) = v.get("account_keys") {
            let labeled: Vec<crate::providers::keys::LabeledKey> =
                serde_json::from_value(arr.clone()).unwrap_or_default();
            let count = labeled.len();
            crate::providers::keys::set_account_keys(labeled);
            tracing::info!(
                target: "fleet-backend",
                count = count,
                "providers reload: account-key cache hydrated"
            );
        }
        // Cloudflare Workers AI account id (non-secret) rides the same reload
        // as the keys. Present-but-null ⇒ clear (disconnected); an absent
        // field leaves the cached value untouched.
        if let Some(cf) = v.get("cloudflare_account_id") {
            crate::providers::keys::set_cloudflare_account_id(cf.as_str().map(String::from));
        }
    }
    Ok(Json(
        json!({ "ok": true, "cached_keys": crate::providers::keys::len() }),
    ))
}

/// Live reload of the routing orchestrator from a fresh `RoutingSetup`
/// composed by the Tauri IPC layer (after the user connects / disconnects
/// / activates a router). Without this endpoint, the orchestrator would
/// only see new routers after a backend restart — the user's selection
/// in Settings → Routers would be a no-op until they relaunched the app.
async fn routing_reload(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(setup): Json<crate::services::routing::setup::RoutingSetup>,
) -> Result<Json<Value>, ApiError> {
    // Same loopback-secret auth shape as `/dispatch` — constant-time
    // compare so a known-prefix timing attack can't probe the secret.
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }

    st.routing.reload_from_setup(setup);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct DispatchBody {
    /// Caller session id (set from FLEETIFY_SESSION_ID on the MCP side).
    caller_session_id: String,
    /// Target agent — exact UUID or case-insensitive title.
    agent: String,
    /// Task body. The target sees it verbatim as a `user` message.
    task: String,
}

/// Body for `POST /api/internal/spawn` — the `spawn_agent` MCP tool's
/// semi-structured args. Resolved server-side; required fields must resolve.
#[derive(Deserialize)]
struct SpawnBody {
    caller_session_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    agent_template: Option<String>,
    #[serde(default)]
    task: Option<String>,
    /// Git worktree isolation — default OFF (work directly in the folder).
    #[serde(default)]
    use_worktree: Option<bool>,
}

/// `POST /api/internal/spawn` — create a new agent on behalf of a worker
/// (the `spawn_agent` MCP tool). Resolves the semi-structured args; a gap-free
/// spec creates the session, otherwise returns a structured error the worker
/// can react to. Enforces the K3 permission clamp (spawned mode ≤ caller's).
async fn spawn(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<SpawnBody>,
) -> Result<Json<Value>, ApiError> {
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }

    let SpawnBody {
        caller_session_id,
        title,
        project_path,
        tool,
        model,
        permission_mode,
        agent_template,
        task,
        use_worktree,
    } = b;
    let caller = caller_session_id.trim();
    if caller.is_empty() {
        return Err(ApiError::BadRequest("caller_session_id is required".into()));
    }

    let caller_row: Option<Session> =
        sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(caller)
            .fetch_optional(&st.auth.pool)
            .await?;
    let Some(caller_row) = caller_row else {
        return Err(ApiError::NotFound(format!(
            "caller session {caller} not found"
        )));
    };

    let raw = crate::services::spawn::RawSpawn {
        title,
        project: project_path,
        tool,
        model,
        perm: permission_mode,
        template: agent_template,
        effort: None,
        task,
        worktree: use_worktree,
    };
    let known =
        crate::services::spawn::known_project_paths(&st.auth.pool, caller_row.user_id.as_deref())
            .await;
    let resolved = crate::services::spawn::resolve(&raw, &known);
    if !resolved.gaps.is_empty() {
        let fields: Vec<String> = resolved.gaps.iter().map(|g| g.field.clone()).collect();
        return Err(ApiError::BadRequest(format!(
            "spawn spec incomplete; unresolved fields: {}",
            fields.join(", ")
        )));
    }

    // K3 permission clamp: the spawned agent may not exceed the caller's level.
    let spawned = resolved
        .spec
        .permission_mode
        .as_deref()
        .unwrap_or("default");
    if crate::services::spawn::perm_rank(spawned)
        > crate::services::spawn::perm_rank(&caller_row.permission_mode)
    {
        return Err(ApiError::Forbidden(format!(
            "permission clamp: a `{}` agent cannot spawn a `{spawned}` agent",
            caller_row.permission_mode
        )));
    }

    let session = crate::services::spawn::create(
        &st,
        caller_row.user_id.as_deref(),
        &resolved.spec,
        Some(caller),
    )
    .await
    .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    Ok(Json(json!({ "ok": true, "session_id": session.id })))
}

async fn dispatch(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<DispatchBody>,
) -> Result<Json<Value>, ApiError> {
    // Auth: only the loopback secret. Constant-time string compare so a
    // timing attack against a known-prefix can't probe the secret.
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }

    // Resolve + guard + spawn now live in services::dispatch_exec so the Fleet
    // Hub delegation can reuse the exact same path. This endpoint is a thin
    // secret-gated wrapper that maps DispatchError → ApiError.
    let spec = crate::services::dispatch_exec::DispatchSpec {
        agent_ref: b.agent.trim().to_string(),
        task: b.task.trim().to_string(),
    };
    if b.caller_session_id.trim().is_empty() || spec.agent_ref.is_empty() || spec.task.is_empty() {
        return Err(ApiError::BadRequest(
            "caller_session_id, agent, and task are required".into(),
        ));
    }

    let (target, _join) =
        crate::services::dispatch_exec::dispatch_one(&st, b.caller_session_id.trim(), &spec)
            .await
            .map_err(|e| {
                use crate::services::dispatch_exec::DispatchError as DE;
                match e {
                    DE::CallerNotFound => ApiError::NotFound(format!(
                        "caller session {} not found",
                        b.caller_session_id.trim()
                    )),
                    DE::TargetNotFound(r) => {
                        ApiError::NotFound(format!("no session matches {r:?}"))
                    }
                    DE::SelfDispatch => ApiError::BadRequest("cannot dispatch to self".into()),
                    DE::Cycle(m) => ApiError::BadRequest(format!("dispatch cycle detected: {m}")),
                    DE::DepthExceeded(n) => ApiError::BadRequest(format!(
                        "dispatch chain too deep ({n} hops, max {})",
                        crate::session_manager::SessionManager::MAX_DISPATCH_CHAIN_DEPTH,
                    )),
                }
            })?;

    Ok(Json(json!({
        "ok": true,
        "target_session_id": target.id,
        "task_dispatched": spec.task,
    })))
}

#[derive(Deserialize)]
struct PermissionPromptBody {
    caller_session_id: String,
    tool_name: String,
    #[serde(default)]
    input: Value,
}

/// Legacy loopback REST endpoint for permission decisions — a thin
/// wrapper over `decide_permission`. The Claude permission gate now runs
/// in-process over HTTP (see `mcp_permission_post` below); this route is
/// retained as a stable loopback surface and delegates to the same
/// decision logic. Returns the JSON body whose `behavior` field Claude's
/// CLI obeys (`allow` + `updatedInput`, or `deny` + `message`).
async fn permission_prompt(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<PermissionPromptBody>,
) -> Result<Json<Value>, ApiError> {
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }
    let sid = b.caller_session_id.trim();
    let tool = b.tool_name.trim();
    if sid.is_empty() || tool.is_empty() {
        return Err(ApiError::BadRequest(
            "caller_session_id and tool_name are required".into(),
        ));
    }

    Ok(Json(decide_permission(&st, sid, tool, b.input).await))
}

// ── In-process MCP-over-HTTP permission server ──────────────────────────────
//
// Replaces the `fleet-permission-mcp` stdio sidecar. Instead of Claude
// spawning a separate binary that POSTs back to /permission_prompt, Claude
// connects directly to this endpoint as a Streamable-HTTP MCP server. The URL
// (session id as the last path segment) and the `Authorization: Bearer
// <internal_secret>` header are baked into `--mcp-config` by
// `mcp_dispatch::builtin_mcp_config("fleet_permission", …)`. The single
// `permission_prompt` tool runs `decide_permission` — the same WS round-trip
// the stdio shim drove via the REST endpoint above. No binary to build/bundle.

/// Shared permission decision (AskUserQuestion interception + per-session
/// handler lookup + WS round-trip), returning the JSON body whose `behavior`
/// field Claude obeys (`allow`+`updatedInput`, or `deny`+`message`). Mirrors
/// the loopback `permission_prompt` REST handler so both transports agree.
async fn decide_permission(st: &AppState, sid: &str, tool: &str, input: Value) -> Value {
    // AskUserQuestion can't render headlessly, so Claude Code falls back to the
    // permission tool for it in EVERY mode. We hijack that: show the
    // interactive question card and hand the answer back as the tool RESULT.
    // `behavior:"deny"` with the answer as `message` is the verified mechanism.
    if tool.eq_ignore_ascii_case("AskUserQuestion") {
        let ask = {
            let guard = st.ask_registry.lock().await;
            guard.get(sid).cloned()
        };
        let Some(ask) = ask else {
            return json!({
                "behavior": "deny",
                "message": "Fleetify chat is not open for this session — open it to answer questions.",
            });
        };
        let questions = input.get("questions").cloned().unwrap_or_else(|| json!([]));
        let outcome = ask(json!({ "questions": questions }))
            .await
            .unwrap_or_else(|_| json!({ "answered": false }));
        return json!({
            "behavior": "deny",
            "message": format_ask_answer(&outcome),
        });
    }

    // The PermissionSession is registered by chat.rs when the user's WS opens.
    // If it never opened (or already closed) we have nowhere to surface the
    // dialog, so default to deny (safer than silently allow).
    let handler = {
        let guard = st.permission_registry.lock().await;
        guard.get(sid).cloned()
    };
    let Some(handler) = handler else {
        tracing::warn!(
            target: "perm",
            session_id = %sid,
            tool = %tool,
            "permission_prompt for unregistered session — denying"
        );
        return json!({
            "behavior": "deny",
            "message": "Fleetify chat is not open for this session — open it to approve tools.",
        });
    };

    if handler(tool.to_string(), input.clone()).await {
        json!({ "behavior": "allow", "updatedInput": input })
    } else {
        json!({ "behavior": "deny", "message": "User declined this action." })
    }
}

/// The single tool this MCP server advertises.
fn permission_prompt_tool() -> Value {
    json!({
        "name": "permission_prompt",
        "description": "Internal — invoked by Claude CLI via --permission-prompt-tool. Surfaces a per-tool approval prompt to the Fleetify user and returns allow/deny. Not meant for the model to call directly.",
        "inputSchema": {
            "type": "object",
            "properties": { "tool_name": { "type": "string" }, "input": { "type": "object" } },
            "required": ["tool_name", "input"]
        }
    })
}

/// Model-facing interactive-question tool — the headless-safe replacement for
/// Claude Code's built-in AskUserQuestion (which errors out, and whose
/// `--permission-prompt-tool` hook was removed in 2.1.x). The model calls it
/// directly; we render the card and return the user's pick as the tool result.
fn ask_user_tool() -> Value {
    json!({
        "name": "ask_user",
        "description": "Ask the Fleetify user to choose between options or clarify an ambiguous decision. Renders an interactive multiple-choice card in the app and returns the user's selection as text. Use this instead of AskUserQuestion, which is disabled.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "1-4 questions; each has a question, a short header, and 2-4 options.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string" },
                            "header": { "type": "string" },
                            "multiSelect": { "type": "boolean" },
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": { "type": "string" },
                                        "description": { "type": "string" }
                                    },
                                    "required": ["label"]
                                }
                            }
                        },
                        "required": ["question", "header", "options"]
                    }
                }
            },
            "required": ["questions"]
        }
    })
}

/// Surface the interactive question card via the session's `ask_registry` and
/// return the user's selection as plain text (the model reads it as the tool
/// result). Shares the WS round-trip + `format_ask_answer` rendering with the
/// legacy AskUserQuestion interception in `decide_permission`.
async fn run_ask_user(st: &AppState, sid: &str, questions: Value) -> String {
    let ask = {
        let guard = st.ask_registry.lock().await;
        guard.get(sid).cloned()
    };
    let Some(ask) = ask else {
        return "Fleetify chat is not open for this session, so the question could not be shown. Proceed with your best judgment.".to_string();
    };
    let questions = if questions.is_array() {
        questions
    } else {
        json!([])
    };
    let outcome = ask(json!({ "questions": questions }))
        .await
        .unwrap_or_else(|_| json!({ "answered": false }));
    format_ask_answer(&outcome)
}

/// `Authorization: Bearer <internal_secret>` check. Claude forwards the
/// configured `--mcp-config` headers on every request to the server.
fn mcp_bearer_ok(headers: &HeaderMap, secret: &str) -> bool {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = presented.strip_prefix("Bearer ").unwrap_or(presented);
    constant_time_eq(token.as_bytes(), secret.as_bytes())
}

/// One MCP JSON-RPC message → its reply, or `None` for notifications (no `id`).
async fn mcp_permission_dispatch(st: &AppState, sid: &str, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = msg.get("id").cloned()?; // notifications get no response
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let reply = match method {
        "initialize" => json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("2025-06-18"),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "fleet-permission", "version": env!("CARGO_PKG_VERSION") }
            }
        }),
        "tools/list" => json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": [ permission_prompt_tool(), ask_user_tool() ] }
        }),
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match name {
                "permission_prompt" => {
                    let tool = args
                        .get("tool_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
                    let decision = if tool.is_empty() {
                        json!({ "behavior": "deny", "message": "tool_name is required" })
                    } else {
                        decide_permission(st, sid, tool, input).await
                    };
                    // Claude reads the decision from the first text content block.
                    json!({ "jsonrpc": "2.0", "id": id, "result": {
                        "content": [{ "type": "text", "text": decision.to_string() }],
                        "isError": false
                    }})
                }
                "ask_user" => {
                    let questions = args.get("questions").cloned().unwrap_or_else(|| json!([]));
                    let answer = run_ask_user(st, sid, questions).await;
                    json!({ "jsonrpc": "2.0", "id": id, "result": {
                        "content": [{ "type": "text", "text": answer }],
                        "isError": false
                    }})
                }
                other => json!({ "jsonrpc": "2.0", "id": id, "result": {
                    "content": [{ "type": "text", "text": format!("unknown tool: {other}") }],
                    "isError": true
                }}),
            }
        }
        other => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("method not handled: {other}") }
        }),
    };
    Some(reply)
}

/// POST half of the Streamable-HTTP MCP server — handles initialize /
/// tools/list / tools/call / ping (single message or JSON-RPC batch).
async fn mcp_permission_post(
    State(st): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !mcp_bearer_ok(&headers, &st.internal_secret) {
        return (StatusCode::FORBIDDEN, "internal-secret mismatch").into_response();
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid json-rpc body").into_response();
    };
    let is_batch = parsed.is_array();
    let msgs = if is_batch {
        parsed.as_array().cloned().unwrap_or_default()
    } else {
        vec![parsed]
    };
    let mut replies = Vec::new();
    for m in &msgs {
        if let Some(r) = mcp_permission_dispatch(&st, &sid, m).await {
            replies.push(r);
        }
    }
    if replies.is_empty() {
        return StatusCode::ACCEPTED.into_response(); // notifications only
    }
    let payload = if is_batch {
        Value::Array(replies)
    } else {
        replies.into_iter().next().unwrap_or(Value::Null)
    };
    (
        axum::response::AppendHeaders([("mcp-session-id", "fleet-permission")]),
        Json(payload),
    )
        .into_response()
}

/// GET half — the optional server→client SSE channel. We never push; keep it
/// open with keep-alives. All tool replies travel on the POST responses.
async fn mcp_permission_get(
    State(st): State<AppState>,
    Path(_sid): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !mcp_bearer_ok(&headers, &st.internal_secret) {
        return (StatusCode::FORBIDDEN, "internal-secret mismatch").into_response();
    }
    let stream = futures_util::stream::pending::<Result<Event, std::convert::Infallible>>();
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// Render the renderer's AskUserQuestion answer into the plain-text result
/// Claude Code feeds back to the model. Outcome shape (set by the WS
/// `ask_user_question_response` arm):
///   `{ "answered": bool, "answers": [ { "header"|"question", "selected": ["label", …] } ] }`
fn format_ask_answer(outcome: &Value) -> String {
    let answered = outcome
        .get("answered")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if !answered {
        return "The user skipped the question without answering.".into();
    }
    let answers = outcome.get("answers").and_then(|x| x.as_array());
    let Some(answers) = answers else {
        return "The user answered, but no selection was captured.".into();
    };
    let mut lines = Vec::new();
    for a in answers {
        let label = a
            .get("header")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| a.get("question").and_then(|x| x.as_str()))
            .unwrap_or("Answer");
        let selected: Vec<String> = a
            .get("selected")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let value = if selected.is_empty() {
            "(no selection)".to_string()
        } else {
            selected.join(", ")
        };
        lines.push(format!("{label}: {value}"));
    }
    if lines.is_empty() {
        return "The user answered, but no selection was captured.".into();
    }
    format!("The user answered:\n{}", lines.join("\n"))
}

async fn providers_warm_health(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }
    crate::services::providers_health::warm_all(&st.http_health_cache).await;
    let cached = st.http_health_cache.get().await.unwrap_or_default();
    Ok(Json(json!({ "ok": true, "warmed": cached.len() })))
}

/// Constant-time byte-slice equality. Tiny implementation — fine for
/// 32-byte secrets like the loopback token.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[allow(dead_code)]
fn _silence_unused_status_code(_: StatusCode) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthConfig, AuthState};
    use crate::db::init_pool;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    #[test]
    fn format_ask_answer_single_question() {
        let outcome = json!({
            "answered": true,
            "answers": [{"header":"Color","question":"Pick a color","selected":["Green"]}],
        });
        assert_eq!(
            super::format_ask_answer(&outcome),
            "The user answered:\nColor: Green"
        );
    }

    #[test]
    fn format_ask_answer_multi_select_and_fallback_to_question() {
        let outcome = json!({
            "answered": true,
            "answers": [{"question":"Pick toppings","selected":["A","B"]}],
        });
        // No header → falls back to the question text; multi-select joins.
        assert_eq!(
            super::format_ask_answer(&outcome),
            "The user answered:\nPick toppings: A, B"
        );
    }

    #[test]
    fn format_ask_answer_skipped() {
        let outcome = json!({ "answered": false });
        assert_eq!(
            super::format_ask_answer(&outcome),
            "The user skipped the question without answering."
        );
    }

    async fn build_app(
        secret: &str,
    ) -> (
        axum::Router,
        sqlx::SqlitePool,
        &'static crate::session_manager::SessionManager,
    ) {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        // Insert two sessions owned by the same user so the ownership
        // scoping inside dispatch() resolves the target.
        for (id, title) in [
            ("aaaaaaaa-0000-0000-0000-000000000001", "Caller"),
            ("bbbbbbbb-0000-0000-0000-000000000002", "Backend Agent"),
        ] {
            sqlx::query(
                "INSERT INTO sessions \
                 (id,title,project_path,group_path,tool,command,status,\
                  use_worktree,permission_mode,session_mode,pinned,order_idx,\
                  budget_used,created_at,user_id) \
                 VALUES (?,?,?,'','claude-code','','idle',1,'default','new',0,0,0.0,?,?)",
            )
            .bind(id)
            .bind(title)
            .bind(format!("/tmp/{id}"))
            .bind(chrono::Utc::now().to_rfc3339())
            .bind("user-1")
            .execute(&pool)
            .await
            .unwrap();
        }
        let cfg = Arc::new(crate::config::AppConfig::load(None).expect("config/default.toml"));
        let auth_cfg = Arc::new(AuthConfig::from_env());
        let jwks = crate::auth::default_jwks_cache(&auth_cfg.jwks_url);
        // Per-test SessionManager so dispatch_chain state from one
        // test doesn't bleed into another. Box::leak gives us the
        // `&'static` lifetime AppState demands without sharing the
        // process-wide singleton across the test suite.
        let sm: &'static crate::session_manager::SessionManager =
            Box::leak(Box::new(crate::session_manager::SessionManager::for_tests()));
        let routing = crate::services::routing::RoutingOrchestrator::with_empty_defaults(false);
        let state = AppState {
            auth: AuthState {
                pool: pool.clone(),
                cfg: auth_cfg,
                jwks,
            },
            app_cfg: cfg,
            sm,
            internal_secret: Arc::new(secret.to_string()),
            routing,
            permission_registry: Arc::new(
                tokio::sync::Mutex::new(std::collections::HashMap::new()),
            ),
            ask_registry: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            agent_scan_cache: crate::routers::providers::AgentScanCache::default(),
            http_health_cache: crate::routers::providers::HttpHealthCache::default(),
        };
        let app = axum::Router::new()
            .nest("/api/internal", router())
            .with_state(state);
        (app, pool, sm)
    }

    #[tokio::test]
    async fn mcp_permission_rejects_missing_bearer() {
        let (app, _pool, _sm) = build_app("sek").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/mcp/permission/aaaaaaaa-0000-0000-0000-000000000001")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 403, "missing Bearer must 403");
    }

    #[tokio::test]
    async fn mcp_permission_initialize_and_tools_list() {
        let (app, _pool, _sm) = build_app("sek").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/mcp/permission/sid1")
            .header("content-type", "application/json")
            .header("authorization", "Bearer sek")
            .body(Body::from(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
            ))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], "fleet-permission");

        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/mcp/permission/sid1")
            .header("content-type", "application/json")
            .header("authorization", "Bearer sek")
            .body(Body::from(
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["result"]["tools"][0]["name"], "permission_prompt");
        assert_eq!(
            v["result"]["tools"][1]["name"], "ask_user",
            "ask_user must be advertised so the model can call it instead of the disabled AskUserQuestion"
        );
    }

    #[tokio::test]
    async fn mcp_permission_ask_user_unregistered_session_falls_back() {
        // No chat WS open for the session → ask_user returns graceful guidance
        // text (not an error), so the turn keeps going.
        let (app, _pool, _sm) = build_app("sek").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/mcp/permission/sid-no-chat")
            .header("content-type", "application/json")
            .header("authorization", "Bearer sek")
            .body(Body::from(
                r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask_user","arguments":{"questions":[{"question":"x?","header":"h","options":[{"label":"a"}]}]}}}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["result"]["isError"], false);
        let text = v["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            text.contains("not open"),
            "expected chat-not-open fallback, got: {text}"
        );
    }

    #[tokio::test]
    async fn mcp_permission_tools_call_unregistered_session_denies() {
        let (app, _pool, _sm) = build_app("sek").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/mcp/permission/unregistered-sid")
            .header("content-type", "application/json")
            .header("authorization", "Bearer sek")
            .body(Body::from(
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"permission_prompt","arguments":{"tool_name":"Write","input":{"file_path":"/tmp/x"}}}}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        // The decision is JSON-stringified inside the first text content block.
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "deny");
    }

    #[tokio::test]
    async fn dispatch_rejects_missing_or_wrong_secret() {
        let (app, _pool, _sm) = build_app("correct-secret").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"x"}"#,
            ))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 403, "missing header must 403");

        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "wrong")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"x"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 403, "wrong header must 403");
    }

    #[tokio::test]
    async fn dispatch_refuses_self_dispatch() {
        let (app, _pool, _sm) = build_app("s").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Caller","task":"loop"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn dispatch_persists_user_message_on_target_and_returns_session_id() {
        let (app, pool, _sm) = build_app("s").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"do the thing"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(
            v["target_session_id"],
            "bbbbbbbb-0000-0000-0000-000000000002"
        );
        // User message landed on the target.
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT role, content FROM messages WHERE session_id = ?")
                .bind("bbbbbbbb-0000-0000-0000-000000000002")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "user");
        assert!(rows[0].1.contains("do the thing"));
    }

    #[tokio::test]
    async fn dispatch_returns_404_for_unknown_agent_ref() {
        let (app, _pool, _sm) = build_app("s").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"NonexistentAgent","task":"x"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn dispatch_refuses_when_target_already_in_caller_chain() {
        // Set up the caller's chain so it already references the
        // target — the endpoint must refuse with a cycle error.
        let (app, _pool, sm) = build_app("s").await;
        sm.set_dispatch_chain(
            "aaaaaaaa-0000-0000-0000-000000000001",
            vec![
                "ffffffff-0000-0000-0000-000000000099".into(),
                "bbbbbbbb-0000-0000-0000-000000000002".into(), // target — must refuse
            ],
        );
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"cycle"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn dispatch_refuses_when_chain_at_max_depth() {
        let (app, _pool, sm) = build_app("s").await;
        // Pad the chain to MAX so depth check fires before cycle check.
        let max = crate::session_manager::SessionManager::MAX_DISPATCH_CHAIN_DEPTH;
        let chain: Vec<String> = (0..max)
            .map(|i| format!("cccccccc-0000-0000-0000-{i:012}"))
            .collect();
        sm.set_dispatch_chain("aaaaaaaa-0000-0000-0000-000000000001", chain);
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"deep"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[test]
    fn constant_time_eq_handles_length_mismatch_and_match() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    #[tokio::test]
    async fn warm_health_writes_cache_for_every_keyed_provider() {
        use crate::routers::providers::{HealthSnapshot, HttpHealthCache};
        crate::providers::keys::_reset_for_tests();
        let mut keys = std::collections::HashMap::new();
        keys.insert("openai".to_string(), "sk-stub-openai".to_string());
        keys.insert("gemini-api".to_string(), "stub-gemini-key".to_string());
        crate::providers::keys::set_keys(keys);

        let cache = HttpHealthCache::default();
        crate::services::providers_health::warm_all(&cache).await;
        let snap = cache.get().await.expect("cache populated");
        assert!(snap.contains_key("openai"));
        assert!(snap.contains_key("gemini-api"));
        // Providers with no key written as NoKey explicitly.
        assert!(matches!(snap.get("deepseek"), Some(HealthSnapshot::NoKey)));
    }

    #[tokio::test]
    async fn providers_reload_rejects_missing_or_wrong_secret() {
        let (app, _pool, _sm) = build_app("correct-secret").await;
        // Missing header.
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/providers/reload")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 403, "missing header must 403");
        // Wrong header value.
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/providers/reload")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "wrong")
            .body(Body::from("{}"))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 403, "wrong header must 403");
    }

    #[tokio::test]
    async fn providers_reload_acks_with_correct_secret() {
        let (app, _pool, _sm) = build_app("s").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/providers/reload")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from("{}"))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["ok"], true);
    }
}
