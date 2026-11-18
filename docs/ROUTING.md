# Fleetify routing & "Auto" mode

Fleetify ships a full **provider-routing engine** — given a chat/dispatch
turn, it can pick the best `(agent, model)` instead of running whatever the
user pinned. **"Auto"** is the one-click, user-facing front end of that
engine, powered by **Fleet's own Not Diamond key**. This document covers both:
the engine (layers, routers, gateways, persistence) and the Auto feature built
on top of it.

There are two *independent* ways routing happens, and keeping them separate is
a hard design invariant:

| Surface | Which router | Whose key | Code entry point |
|---|---|---|---|
| **Picker → "Auto"** | Not Diamond | **Fleet's own** (`NOTDIAMOND_API_KEY` from `.env`) | `persist::fleet_auto_resolve` |
| **Manual chat / dispatch-to-agent** | User's *active decision router* (builtin / their Not Diamond / Weave), gated on the master toggle | **User's** (OS keychain, via Settings → Routers) | `persist::resolve_routing_for_turn` / `resolve_routing_for_dispatch` → `st.routing` |

Enabling Auto never touches the user's Settings → Routers config; the user's
dispatch routing never uses Fleet's key.

---

## 1. The routing engine (the "how")

All under `crates/fleetify-backend/src/services/routing/`. The engine is a
three-layer pipeline feeding a pluggable decision router, with an offline
router as the immortal fallback.

```
RoutingTask ─▶ Layer 0: IntentClassifier   (heuristic complexity)
            ─▶ Layer 1: AgentSelector       (rank allowed_agents vs CapabilityMatrix)
            ─▶ Layer 2: DecisionRouter       (builtin | notdiamond | weave) ─▶ RouterDecision
                              │
                              └─ orchestrated by RoutingOrchestrator
                                 (2 s timeout on external routers, fallback ▶ builtin, telemetry)
```

### Layer 0 — `IntentClassifier` (`intent.rs`)

Turns a `RoutingTask` into a `ComplexityHint` (`Trivial | Simple | Medium |
Complex`). v1 is rule-based: an explicit `user_hint` wins; otherwise complex
keywords (`refactor`, `migrate`, `architect`, `deadlock`, …) or `>20` files →
`Complex`; simple keywords (`typo`, `rename`, `lint`) on a short, code-block-free
prompt → `Trivial`; then word-count buckets (`<20` Simple, `<100` Medium, else
Complex). (v1.1 plans embedding-based intent clustering — see the spec under
`docs/superpowers/specs/`.)

### Layer 1 — `AgentSelector` + `CapabilityMatrix` (`agent_selector.rs`, `capability_matrix.rs`)

`AgentSelector::rank(task)` filters the task's `allowed_agents` against the
**capability matrix** (loaded from `config/agents.toml`: per-agent
`supports_tool_use`, `supports_vision`, `max_context`, `mcp_support`, `acp`,
`default_model`, `tiers`). Agents lacking tool-use are dropped when the prompt
needs it (code block present or `file_count > 0`); if that empties the list it
falls back to "any allowed agent present in the matrix". Output: a
`Vec<AgentCandidate>` (`{agent, tiers}`) — the candidate set Layer 2 chooses
from.

### Layer 2 — `DecisionRouter` trait + registry (`traits.rs`, `decision/`)

```rust
trait DecisionRouter {
    fn id(&self) -> &'static str;            // "builtin" | "notdiamond" | "weave"
    async fn recommend(&self, task, candidates) -> Result<RouterDecision, RouterError>;
    async fn health_check(&self) -> Result<(), RouterError>;
}
```

A `RouterDecision` is `{agent, model, rationale, source, fallback_chain}`.

| Router | File | Behaviour |
|---|---|---|
| **BuiltInRouter** | `decision/builtin.rs` | Offline, deterministic, capability-matrix based. **Contract: NEVER returns `Err`** given a non-empty candidate set — picks a tier by complexity. The universal fallback. |
| **NotDiamondRouter** | `decision/notdiamond.rs` | `POST /v2/modelRouter/modelSelect` with `{messages, llm_providers:[{provider,model}], tradeoff:"cost"}`. Echoes back **one of the exact `(provider, model)` pairs we send**, so the choice is always dispatchable. Maps `anthropic↔Claude`, `openai↔OpenAI`, `google↔Gemini`. |
| **WeaveDecisionRouter** | `decision/weave.rs` | W&B Weave decision endpoint (self-hosted / managed). |

`DecisionRouterRegistry` (`decision/registry.rs`) holds routers by id with one
`active`. **`builtin` is mandatory and immortal** — it's inserted at
construction, `register("builtin")` is a no-op, `unregister("builtin")` is a
no-op, and removing the active router falls back to builtin.

### The orchestrator — `RoutingOrchestrator` (`orchestrator.rs`)

`route(task, candidates) -> RouteOutcome` — **never returns `Err`**:

1. **Happy path:** if the active router *is* builtin, call it directly (no
   timeout, no fallback bookkeeping).
2. **External primary:** race `recommend()` against a **2 s timeout**
   (`timeout_ms = 2000`). On success, use it (`fallback_used = false`).
3. **Failure/timeout:** categorise into a `RoutingFailureKind`
   (`Timeout | Network | Upstream | InvalidResponse | Auth | NotConfigured`),
   fire a fire-and-forget `routing_failure` telemetry event, then **fall back to
   builtin** (`fallback_used = true`). The fallback is transparent — no user
   banner on day 1.

`enabled()` is the master "intelligent routing" toggle. The orchestrator does
**not** self-enforce it inside `route()`; callers (chat / dispatch) check
`enabled()` first and only route when it's on. `proxy_for(provider)` resolves
`(base_url, extra_headers)` via the active **proxy gateway**.

### Proxy gateways (`proxy/`)

Orthogonal to decision routing: where decision routers pick *what* to run,
proxy gateways change *where the provider HTTP call goes*.

| Gateway | id | base_url |
|---|---|---|
| `DirectGateway` | `direct` | `None` — calls the provider directly (default) |
| `WeaveProxyGateway` | `weave` | W&B Weave router root for every provider |
| `LiteLLMGateway` | `litellm` | a user-supplied LiteLLM proxy root |

`ProxyGatewayRegistry` mirrors the decision registry (Direct is the immortal
default). When a non-Direct gateway is active and routing is enabled, chat.rs
applies its `base_url`/headers to the bridge for the (possibly routed)
provider.

### Configuration & live reload (`setup.rs`)

The Tauri shell composes a `RoutingSetup { enabled, active_decision_router,
active_proxy_gateway, resolved: {id → {api_key, base_url}} }` from
`fleet.config.json` + the OS keychain and hands it to the backend at boot
(`serve`, in its `ServeOptions`) or POSTs it to `/api/internal/routing/reload`
while running. `RoutingOrchestrator::reload_from_setup` wipes external registry
entries and re-hydrates Not Diamond / Weave / LiteLLM **without an app
restart**, so connect/disconnect/activate from Settings → Routers takes effect
live.

---

## 2. Per-turn resolution (`persist.rs`)

`resolve_routing_for_turn(pool, routing, session_id, manual_tool, manual_model,
task)` folds three branches into one `RoutingResolution { agent, model,
decision_id, freshly_routed, base_url_override, extra_headers }`:

1. **Pinned** — session has both `pinned_agent` + `pinned_model` → reuse them.
   Checked **first, regardless of `enabled()`** (toggling routing off
   mid-session must not unpin). A self-heal guard ignores a pin whose agent
   disagrees with `session.tool` (stale data) and re-resolves.
2. **Disabled** — master toggle off and no pin → pass through the user's manual
   `(tool, model)`. No DB write.
3. **Routed** — enabled and no pin → call `orchestrator.route()`, **insert a
   `routing_decisions` row**, **pin the session** (`pinned_agent/model`), emit a
   `routing_decision` telemetry event, return the new id. The pin makes the
   choice sticky for the session lifetime.

`resolve_routing_for_dispatch` is the dispatch-flow analogue (staff → sub-agent)
and additionally computes the proxy `base_url_override`. Both run against the
**user's** `st.routing`.

> **The `"auto"` sentinel.** `str_to_agent_kind("auto")` returns `None`, so an
> Auto session can never satisfy Branch 1's "pin agent == manual_tool" check →
> the pin never sticks → an Auto turn re-resolves *every message*. That's what
> makes Auto pick fresh per turn rather than locking to the first pick.

---

## 3. "Auto" mode (the user-facing feature)

### What the user sees

A first-class **Auto** entry at the top of the model picker's Providers column
(sparkle icon, "Best model per message"). One click puts the session in Auto
mode; the toolbar/composer chip reads a neutral **"Auto"** (not attributed to
any provider).

### Frontend wiring (`src/`)

- **`lib/picker-groups.ts`** — `buildPickerGroups` prepends
  `{ id: "auto", label: "Auto", subtitle: "Best model per message", models: [] }`
  as the first group. `resolveModelChip` short-circuits:
  `if (model === "auto" || tool === "auto") return { dispatchTool: "auto", label: "Auto" }`
  so the chip renders neutrally.
- **`components/ui/provider-logo.tsx`** — `AutoLogo` (gradient sparkle), wired as
  the `"auto"` case.
- **`components/chat/unified-model-picker.tsx`** — the Auto rail row is a
  one-click action (no model sub-list); selecting it calls
  `onPickModel("auto", "auto")`.
- **`components/chat/session-toolbar.tsx` + `chat-input.tsx`** — the Auto branch
  of `onPickModel` **only pins the sentinel**:
  `{ tool: "auto", model_name: "auto" }` (persisted for an existing session, or
  staged on the composer for a new one). It deliberately does **not** touch the
  user's routers config — Auto is Fleet-owned.
- **`types/session.ts`** — `AgentTool` union includes `"auto"`.

### Backend: `auto_pool` + `fleet_auto_resolve` (`persist.rs`)

When a turn is Auto (`session.model_name == "auto" || session.tool == "auto"`),
chat.rs calls `fleet_auto_resolve(pool, task, routes)` **instead of**
`resolve_routing_for_turn` — bypassing the user's orchestrator entirely:

1. chat.rs builds the **active-provider-scoped** candidate pool via
   `auto_pool::select_routes(cli_authed, has_key, anthropic_api_available)`,
   reading active state from the agent scan cache (CLI agents) + `providers::keys`
   (API keys). It yields one `AutoRoute { agent, execution_tool, nd_models }` per
   model family the user can actually run, in execution-preference order:

   ```
   Claude → Claude Code CLI, else Anthropic API (Phase 2, gated off)
   OpenAI → Codex CLI,       else OpenAI API
   Gemini → Gemini API       (no CLI path — the gemini-CLI agent was removed)
   ```

   A family with no active path is **omitted**, so Not Diamond can never
   recommend a model Fleet can't execute (the old fixed `[Claude, OpenAI,
   Gemini]` set could). The `nd_models` are a cost↔quality spread in **Not
   Diamond-catalog form** (e.g. `claude-sonnet-4.6`, `claude-opus-4.7`,
   `gpt-5.5`, `gemini-2.5-pro`). On the way back, `auto_pool::nd_model_to_dispatch`
   maps Not Diamond's id to the bridge-dispatch id (dot→dash for the newest
   Claudes: `claude-sonnet-4.6` → `claude-sonnet-4-6`) and the chosen
   `execution_tool` (e.g. `codex`, `gemini-api`) rides on
   `RoutingResolution.tool_override`.
2. Read `NOTDIAMOND_API_KEY` from the environment (loaded from `.env` by
   `dotenvy` at backend startup):
   - **key set** → `NotDiamondRouter::new(key).recommend(...)`; on `Ok`, use it;
     on any error (network / quota / auth), fall back to the offline router.
   - **key unset** → the offline built-in router picks from the same candidates.

   Either way Auto **always resolves** (built-in never errs on a non-empty
   candidate set; a final hard-default to Claude/Sonnet guards the impossible
   case).
3. **Persist a `routing_decisions` row** for cost/telemetry attribution, but do
   **not** pin the session (Auto re-routes every turn — see the sentinel note
   above).

### Bridge-swap (`routers/chat.rs`)

The chat bridge (`any_bridge`) is built from `session.tool`, *before* routing
historically resolved. For Auto we resolve **first**, then rebind
`session.tool` / `session.model_name` to the routed `(agent, model)` so the
existing bridge match builds the **routed provider's** bridge — never a literal
`"auto"` bridge:

```rust
let is_auto = session.model_name.as_deref() == Some("auto") || session.tool == "auto";
// is_auto widens allowed_agents to [Claude, OpenAI, Gemini]; non-auto keeps a single-agent set.
let resolution = if is_auto {
    persist::fleet_auto_resolve(&st.auth.pool, &route_task).await        // Fleet's .env key
} else {
    persist::resolve_routing_for_turn(&st.auth.pool, &st.routing, …).await // user's orchestrator
};
if is_auto {
    session.tool = agent_kind_to_str(resolution.agent).to_string();
    session.model_name = Some(/* routed model, or claude-sonnet-4-6 if empty */);
}
// …existing bridge match builds from the (now routed) session.tool…
```

The two **dispatch-to-agent** sites (`resolve_routing_for_dispatch`, staff →
sub-agent) are untouched and continue to use the user's `st.routing`.

---

## 4. Auto vs the user's Routers — the boundary

| | **Auto** (picker) | **Routers** (Settings → Routers) |
|---|---|---|
| Trigger | Pick "Auto" in the picker | Connect a router + flip the master toggle |
| Not Diamond key | Fleet's `NOTDIAMOND_API_KEY` (`.env`) | User's key (OS keychain) |
| Scope | Per-session, re-routes every turn, never pins | Per-turn for *manual* sessions; pins on first route |
| Candidates | Active-provider-scoped pool (`auto_pool::select_routes`) — only families with a live execution path | The session's single agent family (or dispatch target) |
| Code | `fleet_auto_resolve` | `resolve_routing_for_turn` / `_for_dispatch` via `st.routing` |
| Fallback | Built-in router (key unset / ND error) | Orchestrator's 2 s timeout → built-in |

---

## 5. Configuration

### Auto (Fleet-owned)

`.env` (gitignored; `.env.example` is the committed template):

```
# Read at runtime by the backend (std::env::var, dotenvy-loaded). Fleet's own
# key — independent of any Not Diamond a user connects in Settings → Routers.
NOTDIAMOND_API_KEY=sk-...
```

Unset ⇒ Auto silently falls back to the offline built-in router (still routes,
just without Not Diamond's cross-provider intelligence). The key is **never**
committed — it lives only in `.env`.

### Routers (user-owned)

Driven from the renderer via `src/lib/routers-api.ts` → IPC:
`routers.connect(id, secret, metadata)` / `disconnect(id)` /
`setActive("decision" | "proxy", id)` / `setMasterToggle(enabled)` /
`testRouter` / `getKeyPreview`. Keys are stored in the OS keychain; the active
selections + master toggle live in `fleet.config.json` and flow to the backend
as a `RoutingSetup` (boot or live reload).

---

## 6. Data & telemetry

- **`routing_decisions` table** — one row per fresh route (incl. every Auto
  turn): `{id, ts, task_flow, task_ref, agent, model, source, rationale,
  latency_ms, fallback_used, primary_router_if_fallback, candidates_json}`.
  `source` is `builtin | notdiamond | weave | pinned`.
- **`sessions.pinned_agent / pinned_model / routing_decision_id`** — the sticky
  pin for *manually-routed* sessions (Auto does not pin).
- **Telemetry events** (opt-in/out per `docs/ANALYTICS.md`): `routing_decision`
  on a fresh route, `routing_failure` when an external router falls back. No
  prompt content is sent.

To confirm Auto is reaching Not Diamond (not just the built-in fallback), look
for `routing_decisions` rows with `source = notdiamond`, or the backend log
`fleetify.routing: routing decision … router_source=notdiamond`.

---

## 7. File map

| File | Responsibility |
|---|---|
| `services/routing/intent.rs` | Layer 0 — heuristic complexity classifier |
| `services/routing/agent_selector.rs` | Layer 1 — capability-matched agent ranking |
| `services/routing/capability_matrix.rs` | `config/agents.toml` loader (per-agent caps + tiers) |
| `services/routing/traits.rs` | `DecisionRouter` / `ProxyGateway` traits + core types |
| `services/routing/decision/builtin.rs` | Offline router (never errs) — the fallback |
| `services/routing/decision/notdiamond.rs` | Not Diamond `modelSelect` client |
| `services/routing/decision/weave.rs` | Weave decision router |
| `services/routing/decision/registry.rs` | Decision-router registry (builtin immortal) |
| `services/routing/proxy/*` | Proxy gateways (direct / weave / litellm) + registry |
| `services/routing/orchestrator.rs` | `route()` (timeout + fallback + telemetry), `proxy_for()` |
| `services/routing/setup.rs` | `RoutingSetup` boot/reload bundle |
| `services/routing/persist.rs` | `resolve_routing_for_turn` / `_for_dispatch`, **`fleet_auto_resolve`**, pin + decision persistence |
| `routers/chat.rs` | Per-turn resolution + **Auto bridge-swap**; dispatch sites |
| `src/lib/picker-groups.ts` | `buildPickerGroups` (Auto entry) + `resolveModelChip` |
| `src/components/chat/unified-model-picker.tsx` | Picker UI (Auto rail row) |
| `src/components/chat/{session-toolbar,chat-input}.tsx` | `onPickModel` Auto branch (pins the sentinel) |
| `src/lib/routers-api.ts` | Settings → Routers IPC surface |

---

## 8. Limitations & future work

- **Candidate pool is scoped to active providers** (`auto_pool`), so Auto only
  routes to a family with a live execution path. Claude runs via the Claude
  Code CLI; the **Anthropic API** fallback (for when Claude Code is off) is a
  **Phase 2** item — a native Anthropic adapter — currently gated off.
- **Models we have that Not Diamond doesn't know** (e.g. `claude-opus-4-8`,
  bare `gpt-5.4`) stay **manually selectable only** — they're excluded from the
  Auto pool. Adding them to *routing* would need a trained Not Diamond *custom
  router* (`train_custom_router` → `preference_id`), which isn't wired up.
- **The candidate model ids are tunable.** They must remain both Not
  Diamond-recognised and dispatchable on each bridge; revisit as provider model
  catalogs evolve.
- **Cost.** Each Auto turn with a key set is one paid Not Diamond call
  (recommend-only; execution is on the user's own provider keys).
- **`tradeoff` is hard-coded to `"cost"`.** Exposing `latency` / `quality` as a
  user preference is a natural extension.
- **Classifier v1 is heuristic.** v1.1 plans embedding-based intent clustering
  (Semantic Router) — see `docs/superpowers/specs/`.
