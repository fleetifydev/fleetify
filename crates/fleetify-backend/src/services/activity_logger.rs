//! Activity ledger writer. Faithful port of
//! `services/activity_logger.py`.
//!
//! Bridges call `record_tool_event()` whenever a tool finishes. We
//! classify the tool name to a stable `kind` (file_edit / command /
//! web_fetch / etc.), build a one-line summary, write a session_activity
//! row, and fire telemetry::emit_activity off into the outbox.
//!
//! Best-effort: a failing INSERT logs and returns Ok(()) so the
//! streaming event loop is never broken by ledger writes.

use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use super::telemetry;

/// Map a tool name to a stable activity kind. Unknown tools fall through
/// to the generic 'tool' bucket.
pub fn classify_tool(name: &str) -> &'static str {
    match name {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "file_edit",
        "Read" => "file_read",
        "Bash" => "command",
        "WebFetch" | "WebSearch" => "web_fetch",
        "ExitPlanMode" | "EnterPlanMode" => "plan",
        _ => "tool",
    }
}

/// Build the one-line summary the UI shows next to the kind icon —
/// picks the most informative field for each tool family.
pub fn summarise_tool_input(name: &str, tool_input: &Value) -> String {
    let pick_str = |key: &str| -> Option<String> {
        tool_input
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let cap = |s: String, n: usize| -> String {
        if s.chars().count() <= n {
            s
        } else {
            s.chars().take(n).collect()
        }
    };

    match name {
        "Bash" => cap(
            pick_str("command").unwrap_or_else(|| "(empty command)".into()),
            200,
        ),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Read" => cap(
            pick_str("file_path").unwrap_or_else(|| format!("({name})")),
            200,
        ),
        "WebFetch" => cap(pick_str("url").unwrap_or_else(|| "(WebFetch)".into()), 200),
        "WebSearch" => cap(
            pick_str("query").unwrap_or_else(|| "(WebSearch)".into()),
            200,
        ),
        "Grep" | "Glob" => cap(
            pick_str("pattern").unwrap_or_else(|| format!("({name})")),
            200,
        ),
        "Agent" | "Task" => cap(
            pick_str("prompt").unwrap_or_else(|| format!("({name})")),
            160,
        ),
        _ => {
            // Generic fallback — first informative string field.
            for k in ["description", "path", "query", "command"] {
                if let Some(s) = pick_str(k) {
                    return cap(s, 200);
                }
            }
            name.to_string()
        }
    }
}

/// Direct write into the activity ledger. Best-effort: write failures
/// log + return Ok so streaming isn't broken.
pub async fn record_activity(
    pool: &SqlitePool,
    session_id: &str,
    project_path: Option<&str>,
    kind: &str,
    summary: &str,
    payload: Option<&Value>,
) -> Result<()> {
    let row_id = uuid::Uuid::new_v4().to_string();
    let row_ts = Utc::now();
    // Cap summary + payload defensively (matches Python's 500/4000 caps).
    let summary_capped: String = summary.chars().take(500).collect();
    let payload_str: Option<String> = payload.and_then(|p| {
        serde_json::to_string(p)
            .ok()
            .map(|s| s.chars().take(4000).collect::<String>())
    });

    let write_res = sqlx::query(
        "INSERT INTO session_activity \
         (id, session_id, project_path, kind, summary, payload_json, ts) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row_id)
    .bind(session_id)
    .bind(project_path)
    .bind(kind)
    .bind(&summary_capped)
    .bind(payload_str.as_deref())
    .bind(row_ts.to_rfc3339())
    .execute(pool)
    .await;
    if let Err(e) = write_res {
        tracing::warn!(
            target: "activity",
            "activity.write_failed session_id={session_id} kind={kind} err={e}"
        );
    }

    // Fire-and-forget telemetry. Truncation handled inside emit_activity.
    let session_id_owned = session_id.to_string();
    let kind_owned = kind.to_string();
    let summary_for_telemetry = summary.to_string();
    tokio::spawn(async move {
        let _ = telemetry::emit_activity(
            &session_id_owned,
            &kind_owned,
            Some(&summary_for_telemetry),
            row_ts,
        )
        .await;
    });

    Ok(())
}

/// Persist one tool-end event from the bridge's stream loop. Special-
/// cases `TodoWrite` to explode each todo into its own row + an
/// umbrella `tool` row, matching the renderer's Tasks panel contract.
pub async fn record_tool_event(
    pool: &SqlitePool,
    session_id: &str,
    project_path: Option<&str>,
    tool_name: &str,
    tool_input: Option<&Value>,
    output: Option<&str>,
    is_error: bool,
    duration_ms: Option<u64>,
) -> Result<()> {
    let empty = Value::Object(Default::default());
    let inp = tool_input.unwrap_or(&empty);

    // Special-case TodoWrite: explode items + record umbrella row.
    if tool_name == "TodoWrite" {
        if let Some(todos) = inp.get("todos").and_then(|v| v.as_array()) {
            for todo in todos {
                let Some(obj) = todo.as_object() else {
                    continue;
                };
                let content = obj
                    .get("content")
                    .and_then(|v| v.as_str())
                    .or_else(|| obj.get("text").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if content.is_empty() {
                    continue;
                }
                let status = obj
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("pending")
                    .to_string();
                let summary: String = format!("[{status}] {content}").chars().take(500).collect();
                let mut payload = json!({ "status": status });
                if let Some(af) = obj.get("activeForm") {
                    payload["activeForm"] = af.clone();
                }
                record_activity(
                    pool,
                    session_id,
                    project_path,
                    "todo",
                    &summary,
                    Some(&payload),
                )
                .await?;
            }
            let count = todos.len();
            let summary = format!("TodoWrite · {count} items");
            let payload = json!({ "tool": "TodoWrite" });
            return record_activity(
                pool,
                session_id,
                project_path,
                "tool",
                &summary,
                Some(&payload),
            )
            .await;
        }
    }

    let kind: &str = if is_error {
        "error"
    } else {
        classify_tool(tool_name)
    };
    let summary = summarise_tool_input(tool_name, inp);

    let mut payload = json!({ "tool": tool_name });
    if let Some(d) = duration_ms {
        if d > 0 {
            payload["duration_ms"] = json!(d);
        }
    }
    if is_error {
        payload["error"] = Value::Bool(true);
    }
    if let Some(o) = output {
        let excerpt: String = o.chars().take(600).collect();
        if !excerpt.is_empty() {
            payload["output"] = Value::String(excerpt);
        }
    }

    record_activity(
        pool,
        session_id,
        project_path,
        kind,
        &summary,
        Some(&payload),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_tool_maps_to_stable_kinds() {
        assert_eq!(classify_tool("Edit"), "file_edit");
        assert_eq!(classify_tool("Write"), "file_edit");
        assert_eq!(classify_tool("NotebookEdit"), "file_edit");
        assert_eq!(classify_tool("Read"), "file_read");
        assert_eq!(classify_tool("Bash"), "command");
        assert_eq!(classify_tool("WebFetch"), "web_fetch");
        assert_eq!(classify_tool("WebSearch"), "web_fetch");
        assert_eq!(classify_tool("EnterPlanMode"), "plan");
        // Unknown → generic 'tool' bucket.
        assert_eq!(classify_tool("SomethingWeird"), "tool");
    }

    #[test]
    fn summarise_tool_input_picks_informative_field() {
        assert_eq!(
            summarise_tool_input("Bash", &json!({ "command": "ls -la" })),
            "ls -la"
        );
        assert_eq!(
            summarise_tool_input("Edit", &json!({ "file_path": "src/x.rs" })),
            "src/x.rs"
        );
        assert_eq!(summarise_tool_input("Read", &json!({})), "(Read)");
        assert_eq!(
            summarise_tool_input("WebSearch", &json!({ "query": "rust async" })),
            "rust async"
        );
        // Generic fallback hits the description field.
        assert_eq!(
            summarise_tool_input(
                "WeirdTool",
                &json!({ "description": "do a thing", "other": 1 })
            ),
            "do a thing"
        );
        // Bash with empty command surfaces the placeholder.
        assert_eq!(
            summarise_tool_input("Bash", &json!({ "command": "" })),
            "(empty command)"
        );
    }

    #[test]
    fn summarise_caps_long_strings_at_200() {
        let long = "x".repeat(500);
        let s = summarise_tool_input("Bash", &json!({ "command": long }));
        assert_eq!(s.chars().count(), 200);
    }
}
