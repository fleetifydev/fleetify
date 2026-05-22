//! Faithful port of `app/routers/chat.py:47-80`'s dispatch-token regexes
//! and their extraction logic. Staff agent emits these tokens as plain
//! text in its assistant turn; the WS dispatcher in `routers/chat.rs`
//! reads them out, drives the side effects (persist user msg on target,
//! spawn target bridge, stop/restart, history injection), and strips
//! them from the saved content so the rendered bubble doesn't leak the
//! raw syntax.
//!
//! Patterns (UUID character class `[a-f0-9-]+`, case-insensitive):
//!
//!   `[[DISPATCH:<sid>|<task>]]`                          — primary route
//!   `[[DISPATCH:<sid>|<task>||<extra>]]`                 — w/ extra ctx
//!   `[[DIRECT_DISPATCH:<sid>|<task>(||<extra>)?]]`       — frontend-injected
//!   `[[STOP:<sid>]]` / `[[RESTART:<sid>]]`               — control
//!   `[[READ_AGENT:<sid>|<N>]]`                           — history inject
//!
//! The task regex uses a non-greedy lazy match terminated by a lookahead
//! for `]]` so single `|` and `]` inside a task body survive intact
//! (e.g. "filter | grep" or "fix the [bug]"). See chat.py:50-54 for the
//! incident motivating that shape.

use regex::Regex;
use std::sync::OnceLock;

/// `[[DISPATCH:<sid>|<body>]]` where `body` is everything up to the
/// first `]]`. The Rust `regex` crate doesn't support lookaround so we
/// can't express "no `]]` and no `||` inside body" purely as a regex —
/// instead we lazily capture until the first `]]` and split on the
/// first `||` in code. Faithful with the Python regex's intent.
fn dispatch_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?is)\[\[DISPATCH:([a-f0-9-]+)\|(.+?)\]\]").expect("DISPATCH_RE"))
}

/// `[[DIRECT_DISPATCH:<sid>|<body>]]` — frontend injects this when the
/// user typed `@AgentName task`. Same shape as DISPATCH but distinct
/// namespace so the dispatcher can apply trust-level differences.
fn direct_dispatch_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?is)\[\[DIRECT_DISPATCH:([a-f0-9-]+)\|(.+?)\]\]").expect("DIRECT_DISPATCH_RE")
    })
}

/// Split a captured DISPATCH body on the first `||` (extra-context
/// separator). Returns `(task, optional extra)`.
fn split_task_and_extra(body: &str) -> (String, Option<String>) {
    if let Some(idx) = body.find("||") {
        let task = body[..idx].trim().to_string();
        let extra = body[idx + 2..].trim().to_string();
        let extra = if extra.is_empty() { None } else { Some(extra) };
        (task, extra)
    } else {
        (body.trim().to_string(), None)
    }
}

/// `[[READ_AGENT:<sid>|<N>]]` — staff requests N recent messages from
/// the target session injected into the next user turn.
fn read_agent_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\[\[READ_AGENT:([a-f0-9-]+)\|(\d+)\]\]").expect("READ_AGENT_RE")
    })
}

fn stop_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\[\[STOP:([a-f0-9-]+)\]\]").expect("STOP_RE"))
}

fn restart_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\[\[RESTART:([a-f0-9-]+)\]\]").expect("RESTART_RE"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dispatch {
    pub target_id: String,
    pub task: String,
    pub extra: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadAgent {
    pub target_id: String,
    pub limit: u32,
}

/// Parse every `[[DISPATCH:id|task(||extra)?]]` token. Match order
/// is preserved so the WS dispatcher can ack in document order.
pub fn parse_dispatches(text: &str) -> Vec<Dispatch> {
    dispatch_re()
        .captures_iter(text)
        .map(|c| {
            let (task, extra) = split_task_and_extra(&c[2]);
            Dispatch {
                target_id: c[1].to_string(),
                task,
                extra,
            }
        })
        .collect()
}

/// Parse every `[[DIRECT_DISPATCH:id|task(||extra)?]]` token. Same shape
/// as `parse_dispatches` but a separate function so callers can apply
/// the ownership-check + ack difference without re-scanning.
pub fn parse_direct_dispatches(text: &str) -> Vec<Dispatch> {
    direct_dispatch_re()
        .captures_iter(text)
        .map(|c| {
            let (task, extra) = split_task_and_extra(&c[2]);
            Dispatch {
                target_id: c[1].to_string(),
                task,
                extra,
            }
        })
        .collect()
}

/// Parse every `[[STOP:id]]` token — list of target session ids.
pub fn parse_stops(text: &str) -> Vec<String> {
    stop_re()
        .captures_iter(text)
        .map(|c| c[1].to_string())
        .collect()
}

/// Parse every `[[RESTART:id]]` token — list of target session ids.
pub fn parse_restarts(text: &str) -> Vec<String> {
    restart_re()
        .captures_iter(text)
        .map(|c| c[1].to_string())
        .collect()
}

/// Parse every `[[READ_AGENT:id|N]]` token. N caps at u32; the WS
/// dispatcher further caps it at 50 to match the Python `min(N, 50)`.
pub fn parse_read_agents(text: &str) -> Vec<ReadAgent> {
    read_agent_re()
        .captures_iter(text)
        .filter_map(|c| {
            let n: u32 = c[2].parse().ok()?;
            Some(ReadAgent {
                target_id: c[1].to_string(),
                limit: n,
            })
        })
        .collect()
}

/// Strip every dispatch-style token from `text` so the saved
/// assistant content doesn't leak the raw syntax. Order matters:
/// READ_AGENT first (it tokenises around a `|N`), then DIRECT_DISPATCH,
/// then DISPATCH, finally STOP/RESTART. Returns a cleaned `String`.
pub fn strip_all_tokens(text: &str) -> String {
    let s = read_agent_re().replace_all(text, "");
    let s = direct_dispatch_re().replace_all(&s, "");
    let s = dispatch_re().replace_all(&s, "");
    let s = stop_re().replace_all(&s, "");
    let s = restart_re().replace_all(&s, "");
    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "5a99aaaa-0000-0000-0000-bbbbbbbbbbbb";
    const SID2: &str = "deadbeef-1234-5678-9abc-def012345678";

    #[test]
    fn dispatch_extracts_target_and_task() {
        let text = format!("[[DISPATCH:{SID}|Explore makeup_check project structure]] Dispatched.");
        let d = parse_dispatches(&text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].target_id, SID);
        assert_eq!(d[0].task, "Explore makeup_check project structure");
        assert!(d[0].extra.is_none());
    }

    #[test]
    fn dispatch_preserves_single_pipe_and_bracket_in_task() {
        // "filter | grep" and "fix the [bug]" used to truncate with the
        // old `[^\]|]+` pattern. The new shape preserves them.
        let text = format!("[[DISPATCH:{SID}|filter | grep results from fix the [bug] path]]");
        let d = parse_dispatches(&text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].task, "filter | grep results from fix the [bug] path");
    }

    #[test]
    fn dispatch_captures_extra_context() {
        let text = format!("[[DISPATCH:{SID}|main task description||extra trailing context]]");
        let d = parse_dispatches(&text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].task, "main task description");
        assert_eq!(d[0].extra.as_deref(), Some("extra trailing context"));
    }

    #[test]
    fn multiple_dispatches_preserve_order() {
        let text = format!("first: [[DISPATCH:{SID}|task A]] and [[DISPATCH:{SID2}|task B]]");
        let d = parse_dispatches(&text);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].target_id, SID);
        assert_eq!(d[1].target_id, SID2);
    }

    #[test]
    fn case_insensitive_matching() {
        let text = format!("[[dispatch:{SID}|x]] [[Stop:{SID}]] [[RESTART:{SID}]]");
        assert_eq!(parse_dispatches(&text).len(), 1);
        assert_eq!(parse_stops(&text).len(), 1);
        assert_eq!(parse_restarts(&text).len(), 1);
    }

    #[test]
    fn read_agent_parses_limit() {
        let text = format!("[[READ_AGENT:{SID}|10]] please review");
        let r = parse_read_agents(&text);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].target_id, SID);
        assert_eq!(r[0].limit, 10);
    }

    #[test]
    fn stop_and_restart_extract_ids() {
        let text = format!("[[STOP:{SID}]] then [[RESTART:{SID2}]]");
        assert_eq!(parse_stops(&text), vec![SID.to_string()]);
        assert_eq!(parse_restarts(&text), vec![SID2.to_string()]);
    }

    #[test]
    fn direct_dispatch_is_a_separate_namespace() {
        let text = format!("[[DIRECT_DISPATCH:{SID}|user typed @Backend fix the bug]]");
        // DIRECT_DISPATCH must NOT match the plain DISPATCH pattern —
        // the dispatcher routes the two differently (direct = trusted
        // by the renderer, plain = LLM output that needs ownership
        // verification). Mixing them up would double-dispatch.
        let plain = parse_dispatches(&text);
        assert!(
            plain.is_empty(),
            "direct_dispatch leaked into DISPATCH_RE: {plain:?}"
        );
        let direct = parse_direct_dispatches(&text);
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].target_id, SID);
        assert_eq!(direct[0].task, "user typed @Backend fix the bug");
    }

    #[test]
    fn strip_all_tokens_removes_every_pattern() {
        let text = format!(
            "lead text [[DISPATCH:{SID}|task]] middle [[READ_AGENT:{SID}|5]] tail \
             [[STOP:{SID2}]] [[RESTART:{SID}]] [[DIRECT_DISPATCH:{SID}|x||y]] end"
        );
        let cleaned = strip_all_tokens(&text);
        for needle in [
            "[[DISPATCH:",
            "[[READ_AGENT:",
            "[[STOP:",
            "[[RESTART:",
            "[[DIRECT_DISPATCH:",
        ] {
            assert!(
                !cleaned.contains(needle),
                "token leaked: {needle} in {cleaned:?}"
            );
        }
        assert!(cleaned.contains("lead text"));
        assert!(cleaned.contains("end"));
    }

    #[test]
    fn no_token_returns_empty_lists_and_unchanged_text() {
        let text = "Hello — just prose, no tokens here.";
        assert!(parse_dispatches(text).is_empty());
        assert!(parse_stops(text).is_empty());
        assert!(parse_restarts(text).is_empty());
        assert!(parse_read_agents(text).is_empty());
        assert!(parse_direct_dispatches(text).is_empty());
        assert_eq!(strip_all_tokens(text), text);
    }
}
