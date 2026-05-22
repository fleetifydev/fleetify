//! Proactive recall — auto-injects relevant prior memory into bridge
//! turns when the user's message contains "remember-aware" trigger
//! phrases. Faithful port of `services/recall_hook.py`.
//!
//! Bridges have `mcp__fleet_memory__recall` available, but Claude
//! doesn't always reach for it. This module front-loads the recall:
//! detect trigger phrases (Turkish + English), run a quick same-project
//! search across `session_memory` + `session_activity`, and append the
//! top hits as a hidden context block in the user message that goes to
//! the bridge. Claude sees the context as part of its prompt without
//! the user needing to ask for it.
//!
//! Best-effort. Failures or empty results return None — the message
//! goes through unchanged.

use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

const RECALL_QUERY_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_MEMORY_HITS: usize = 5;
const MAX_ACTIVITY_HITS: usize = 8;

// Multilingual trigger phrases (Turkish + English) — case-insensitive,
// word-bounded substring match. The Python uses one regex alternation;
// we walk the list because the `regex` crate alternation is allocator-
// heavy and `[^A-Za-z0-9]?` word boundary checks beat the regex
// surrogate dance for ASCII triggers.
const TRIGGER_PHRASES: &[&str] = &[
    "daha önce",
    "geçen sefer",
    "önceden",
    "nasıl yapmıştık",
    "ne demiştik",
    "hatırla",
    "unutma",
    "earlier",
    "before",
    "last time",
    "remember",
    "did we",
    "what did",
    "prior",
    "previously",
];

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "this", "that", "from", "have", "what", "when", "where", "why",
    "how", "did", "does", "are", "was", "were", "you", "your", "into", "about", "than", "then",
    "them", "they", "bir", "bu", "ne", "ben", "için", "ile", "ama", "ya", "da", "de",
];

/// Path-like token check (filename with extension we care about).
fn has_path_token(text: &str) -> bool {
    // Look for ".<ext>" where <ext> is in the known set, then verify
    // the preceding token shape is path-like (alphanumeric + ._/- ).
    const EXTS: &[&str] = &[
        ".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".json", ".yaml", ".yml", ".sh", ".html",
        ".css", ".sql", ".rs", ".go",
    ];
    let lower = text.to_lowercase();
    for ext in EXTS {
        if let Some(pos) = lower.find(ext) {
            // Verify there's at least one path-character before the dot.
            if pos == 0 {
                continue;
            }
            let prev = lower.as_bytes()[pos - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'/' || prev == b'-' {
                // And verify the extension is followed by a non-word
                // boundary (`.py` in `.python` doesn't count).
                let end = pos + ext.len();
                if end == lower.len() {
                    return true;
                }
                let next = lower.as_bytes()[end];
                if !next.is_ascii_alphanumeric() && next != b'_' {
                    return true;
                }
            }
        }
    }
    false
}

pub fn has_recall_trigger(text: &str) -> bool {
    let lower = text.to_lowercase();
    for p in TRIGGER_PHRASES {
        if lower.contains(p) {
            // Cheap word-boundary check on letters around the match.
            if let Some(pos) = lower.find(p) {
                let before_ok = pos == 0 || !lower.as_bytes()[pos - 1].is_ascii_alphanumeric();
                let after = pos + p.len();
                let after_ok =
                    after == lower.len() || !lower.as_bytes()[after].is_ascii_alphanumeric();
                if before_ok && after_ok {
                    return true;
                }
            }
        }
    }
    has_path_token(text)
}

/// Naive keyword extraction — strip stopwords, keep informative tokens
/// (≥4 chars). Cap at 8. The recall MCP tool does fancier search; this
/// is just to seed the proactive surface.
pub fn extract_keywords(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cur = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '/' || c == '-' {
            cur.push(c);
        } else if !cur.is_empty() {
            push_token(std::mem::take(&mut cur), &mut out, &mut seen);
        }
    }
    if !cur.is_empty() {
        push_token(cur, &mut out, &mut seen);
    }
    out.truncate(8);
    out
}
fn push_token(t: String, out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>) {
    if t.chars().count() < 4 {
        return;
    }
    let low = t.to_lowercase();
    if STOPWORDS.iter().any(|s| *s == low) {
        return;
    }
    if seen.contains(&low) {
        return;
    }
    seen.insert(low);
    out.push(t);
}

/// Same-project search across session_memory + session_activity, with
/// keyword filtering applied client-side. Bounded by
/// `RECALL_QUERY_TIMEOUT`. Returns the rendered `[RECALL CONTEXT]`
/// block ready to splice into the user message, or None if nothing
/// useful surfaced.
pub async fn maybe_build_recall_context(
    pool: &SqlitePool,
    user_text: &str,
    session_id: &str,
    project_path: Option<&str>,
) -> Option<String> {
    let Some(pp) = project_path.filter(|s| !s.is_empty()) else {
        return None;
    };
    if user_text.trim().is_empty() {
        return None;
    }
    if !has_recall_trigger(user_text) {
        return None;
    }
    let keywords = extract_keywords(user_text);
    if keywords.is_empty() {
        return None;
    }

    // Same-project OR same-session OR fall-through to the broader project
    // hit — matches the Python OR'd WHERE clause.
    let mem_fut = sqlx::query_as::<_, MemRow>(
        "SELECT title, content, kind, created_at, session_id, project_path \
         FROM session_memory \
         WHERE session_id = ? OR (project_path IS NOT NULL AND project_path = ?) \
         ORDER BY created_at DESC LIMIT 60",
    )
    .bind(session_id)
    .bind(pp)
    .fetch_all(pool);

    let act_fut = sqlx::query_as::<_, ActRow>(
        "SELECT summary, kind, ts \
         FROM session_activity \
         WHERE session_id = ? OR (project_path IS NOT NULL AND project_path = ?) \
         ORDER BY ts DESC LIMIT 120",
    )
    .bind(session_id)
    .bind(pp)
    .fetch_all(pool);

    let res = tokio::time::timeout(RECALL_QUERY_TIMEOUT, async move {
        let (mems, acts) = tokio::join!(mem_fut, act_fut);
        (mems, acts)
    })
    .await;
    let (mems, acts) = match res {
        Ok((Ok(m), Ok(a))) => (m, a),
        Ok(_) | Err(_) => {
            tracing::warn!(target: "recall_hook", "recall_hook.query_failed_or_timeout");
            return None;
        }
    };

    let lower_keywords: Vec<String> = keywords.iter().map(|k| k.to_lowercase()).collect();
    let matches = |haystack: &str| -> bool {
        let low = haystack.to_lowercase();
        lower_keywords.iter().any(|k| low.contains(k))
    };

    let mem_hits: Vec<&MemRow> = mems
        .iter()
        .filter(|m| matches(&format!("{}\n{}\n{}", m.title, m.content, m.kind)))
        .take(MAX_MEMORY_HITS)
        .collect();
    let act_hits: Vec<&ActRow> = acts
        .iter()
        .filter(|a| matches(&format!("{}\n{}", a.summary, a.kind)))
        .take(MAX_ACTIVITY_HITS)
        .collect();

    if mem_hits.is_empty() && act_hits.is_empty() {
        return None;
    }

    let now = chrono::Utc::now();
    let mut lines: Vec<String> =
        vec!["[RECALL CONTEXT — prior work on this project that may be relevant]".to_string()];
    if !mem_hits.is_empty() {
        lines.push("Memory items:".into());
        for m in &mem_hits {
            let ts_age = ago(parse_ts(&m.created_at), now);
            let cross = if m.session_id == session_id {
                ""
            } else {
                " (other session)"
            };
            let snippet = {
                let s = m.content.replace('\n', " ").trim().to_string();
                if s.chars().count() > 200 {
                    let truncated: String = s.chars().take(200).collect();
                    format!("{truncated}…")
                } else {
                    s
                }
            };
            lines.push(format!("  - [{}] {}{} · {ts_age}", m.kind, m.title, cross));
            lines.push(format!("    {snippet}"));
        }
    }
    if !act_hits.is_empty() {
        lines.push("Recent activity:".into());
        for a in &act_hits {
            let ts_age = ago(parse_ts(&a.ts), now);
            let trimmed: String = a.summary.chars().take(160).collect();
            lines.push(format!("  - [{}] {trimmed} · {ts_age}", a.kind));
        }
    }
    lines.push("[END RECALL CONTEXT]".into());
    Some(lines.join("\n"))
}

fn parse_ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

pub fn ago(ts: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let delta = (now - ts).num_seconds().max(0);
    if delta < 60 {
        return format!("{delta}s ago");
    }
    if delta < 3600 {
        return format!("{}m ago", delta / 60);
    }
    if delta < 86_400 {
        return format!("{}h ago", delta / 3600);
    }
    format!("{}d ago", delta / 86_400)
}

#[derive(sqlx::FromRow)]
struct MemRow {
    title: String,
    content: String,
    kind: String,
    created_at: String,
    session_id: String,
    #[allow(dead_code)]
    project_path: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ActRow {
    summary: String,
    kind: String,
    ts: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_detects_english_and_turkish_phrases() {
        assert!(has_recall_trigger("Do you remember what we did last time?"));
        assert!(has_recall_trigger("Daha önce nasıl yapmıştık?"));
        assert!(has_recall_trigger("What did the user say earlier?"));
        // Plain message → no trigger.
        assert!(!has_recall_trigger("Hello, how are you?"));
        // Substring inside a word doesn't trip.
        assert!(!has_recall_trigger("Remembering all of this"));
    }

    #[test]
    fn trigger_detects_path_tokens() {
        assert!(has_recall_trigger("update src/main.rs to use the new API"));
        assert!(has_recall_trigger("look at index.tsx"));
        assert!(has_recall_trigger("config.json broke something"));
        // Bare extension without filename doesn't count.
        assert!(!has_recall_trigger("the .json format is great"));
    }

    #[test]
    fn extract_keywords_strips_stopwords_and_dedups() {
        let k = extract_keywords("the worktree config does not work for this session");
        assert!(k.iter().any(|s| s == "worktree"));
        assert!(k.iter().any(|s| s == "config"));
        assert!(k.iter().any(|s| s == "session"));
        // "does"/"not"/"this"/"for"/"the" dropped.
        assert!(!k.iter().any(|s| s == "the"));
        assert!(!k.iter().any(|s| s == "not"));
    }

    #[test]
    fn extract_keywords_caps_at_8() {
        let k = extract_keywords("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda");
        assert!(k.len() <= 8);
    }

    #[test]
    fn ago_handles_each_bucket() {
        let now = Utc::now();
        assert_eq!(ago(now - chrono::Duration::seconds(10), now), "10s ago");
        assert_eq!(ago(now - chrono::Duration::seconds(120), now), "2m ago");
        assert_eq!(ago(now - chrono::Duration::seconds(7200), now), "2h ago");
        assert_eq!(ago(now - chrono::Duration::seconds(172_800), now), "2d ago");
    }
}
