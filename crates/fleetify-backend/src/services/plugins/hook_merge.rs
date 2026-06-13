//! Reversible lifecycle-hook merging for the four merge-strategy providers:
//! Claude (`settings.json`), Cursor (`hooks.json`), Antigravity/agy
//! (`~/.gemini/config/hooks.json`, named-group), and Kimi (`config.toml`,
//! `[[hooks]]`). Formats are verified against each vendor's docs (see the
//! design spec §6.2).
//!
//! Reversal is **out-of-band**: a merge returns a [`HookMergeRecord`] (stored
//! on the library item), and removal re-reads the config and deletes the
//! matching entry — we never write a foreign marker field into a user's config.
//! Reads parse-fail-propagate (we never overwrite a config we couldn't parse).
//! Merges are idempotent: re-applying the same `(event, matcher, command)` is a
//! no-op.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::providers;

/// A hook authored in the Library form: a lifecycle event (canonical
/// PascalCase, e.g. `PreToolUse`), an optional matcher, and a shell command.
pub struct NormalizedHook<'a> {
    pub event: &'a str,
    pub matcher: Option<&'a str>,
    pub command: &'a str,
}

/// What a merge wrote, sufficient to reverse it precisely. Persisted on the
/// owning library item (NOT in the provider config).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookMergeRecord {
    pub provider: String,
    pub file: String,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub command: String,
}

/// Whether a provider's hooks are merged (vs copied / unsupported). Only these
/// four are handled here; copy strategies (Copilot/OpenCode/Hermes) reuse the
/// plugin materializer's file copy, and codex/gemini have no hook surface.
pub fn is_merge_provider(provider: &str) -> bool {
    matches!(
        provider,
        "claude-code" | "cursor-cli" | "antigravity-cli" | "kimi-code"
    )
}

/// The config file a provider's hooks merge into. Note agy diverges from
/// `provider_home("antigravity-cli")` (`~/.gemini/antigravity-cli`): its hooks live under
/// `~/.gemini/config/hooks.json`.
fn hook_file(provider: &str) -> Option<PathBuf> {
    match provider {
        "claude-code" => Some(providers::provider_home("claude-code")?.join("settings.json")),
        "cursor-cli" => Some(providers::provider_home("cursor-cli")?.join("hooks.json")),
        "kimi-code" => Some(providers::provider_home("kimi-code")?.join("config.toml")),
        // agy: ~/.gemini/config/hooks.json (NOT the antigravity-cli home).
        "antigravity-cli" => Some(
            providers::provider_home("gemini-cli")?
                .join("config")
                .join("hooks.json"),
        ),
        _ => None,
    }
}

/// Merge `hook` into `provider`'s config, returning the reversal record (or
/// `None` if the provider isn't a merge provider).
pub fn materialize_hook_item(
    provider: &str,
    hook: &NormalizedHook,
) -> Result<Option<HookMergeRecord>> {
    let Some(file) = hook_file(provider) else {
        return Ok(None);
    };
    match provider {
        "claude-code" => merge_claude(&file, hook)?,
        "cursor-cli" => merge_cursor(&file, hook)?,
        "antigravity-cli" => merge_agy(&file, hook)?,
        "kimi-code" => merge_kimi(&file, hook)?,
        _ => return Ok(None),
    }
    Ok(Some(HookMergeRecord {
        provider: provider.to_string(),
        file: file.to_string_lossy().into_owned(),
        event: hook.event.to_string(),
        matcher: hook.matcher.map(|s| s.to_string()),
        command: hook.command.to_string(),
    }))
}

/// Reverse one merge by removing the matching entry from the config.
pub fn unmaterialize_hook(rec: &HookMergeRecord) -> Result<()> {
    let file = Path::new(&rec.file);
    if !file.exists() {
        return Ok(());
    }
    match rec.provider.as_str() {
        "claude-code" => unmerge_claude(file, rec),
        "cursor-cli" => unmerge_cursor(file, rec),
        "antigravity-cli" => unmerge_agy(file, rec),
        "kimi-code" => unmerge_kimi(file, rec),
        _ => Ok(()),
    }
}

// ── JSON helpers ────────────────────────────────────────────────────────────

fn read_json(file: &Path) -> Result<Value> {
    match std::fs::read_to_string(file) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).map_err(|e| anyhow!("parse {}: {e}", file.display()))
        }
        _ => Ok(json!({})),
    }
}

fn write_json(file: &Path, v: &Value) -> Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(file, serde_json::to_string_pretty(v)?)?;
    Ok(())
}

/// Compare matchers, treating `None` and `Some("")` as equivalent.
fn matcher_eq(a: Option<&str>, b: Option<&str>) -> bool {
    fn norm(m: Option<&str>) -> Option<&str> {
        m.filter(|s| !s.is_empty())
    }
    norm(a) == norm(b)
}

/// `obj[key]` as a mutable array, creating `[]` if absent. Errors if present
/// but not an array (don't clobber a user's unexpected shape).
fn array_at<'a>(
    obj: &'a mut serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a mut Vec<Value>> {
    obj.entry(key.to_string())
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| anyhow!("`{key}` is not an array"))
}

// ── Claude: settings.json → {"hooks":{"<Event>":[{matcher?,hooks:[{type,command}]}]}} ──

fn claude_group_has(group: &Value, command: &str) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .is_some_and(|arr| {
            arr.iter()
                .any(|h| h.get("command").and_then(|c| c.as_str()) == Some(command))
        })
}

fn merge_claude(file: &Path, h: &NormalizedHook) -> Result<()> {
    let mut root = read_json(file)?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| anyhow!("settings.json is not an object"))?;
    let hooks = obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow!("`hooks` is not an object"))?;
    let arr = array_at(hooks, h.event)?;
    let already = arr.iter().any(|g| {
        matcher_eq(g.get("matcher").and_then(|m| m.as_str()), h.matcher)
            && claude_group_has(g, h.command)
    });
    if already {
        return Ok(());
    }
    let mut group = serde_json::Map::new();
    if let Some(m) = h.matcher {
        group.insert("matcher".into(), json!(m));
    }
    group.insert(
        "hooks".into(),
        json!([{ "type": "command", "command": h.command }]),
    );
    arr.push(Value::Object(group));
    write_json(file, &root)
}

fn unmerge_claude(file: &Path, rec: &HookMergeRecord) -> Result<()> {
    let mut root = read_json(file)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(());
    };
    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(());
    };
    if let Some(arr) = hooks.get_mut(&rec.event).and_then(|a| a.as_array_mut()) {
        arr.retain(|g| {
            !(matcher_eq(
                g.get("matcher").and_then(|m| m.as_str()),
                rec.matcher.as_deref(),
            ) && claude_group_has(g, &rec.command))
        });
        if arr.is_empty() {
            hooks.remove(&rec.event);
        }
    }
    write_json(file, &root)
}

// ── Cursor: hooks.json → {"version":1,"hooks":{"<camelEvent>":[{command,matcher?}]}} ──

fn to_camel(event: &str) -> String {
    let mut c = event.chars();
    match c.next() {
        Some(f) => f.to_ascii_lowercase().to_string() + c.as_str(),
        None => String::new(),
    }
}

fn merge_cursor(file: &Path, h: &NormalizedHook) -> Result<()> {
    let mut root = read_json(file)?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| anyhow!("hooks.json is not an object"))?;
    obj.entry("version".to_string()).or_insert_with(|| json!(1));
    let hooks = obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow!("`hooks` is not an object"))?;
    let event = to_camel(h.event);
    let arr = array_at(hooks, &event)?;
    let already = arr
        .iter()
        .any(|e| e.get("command").and_then(|c| c.as_str()) == Some(h.command));
    if already {
        return Ok(());
    }
    let mut entry = serde_json::Map::new();
    entry.insert("command".into(), json!(h.command));
    if let Some(m) = h.matcher {
        entry.insert("matcher".into(), json!(m));
    }
    arr.push(Value::Object(entry));
    write_json(file, &root)
}

fn unmerge_cursor(file: &Path, rec: &HookMergeRecord) -> Result<()> {
    let mut root = read_json(file)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(());
    };
    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(());
    };
    let event = to_camel(&rec.event);
    if let Some(arr) = hooks.get_mut(&event).and_then(|a| a.as_array_mut()) {
        arr.retain(|e| e.get("command").and_then(|c| c.as_str()) != Some(rec.command.as_str()));
        if arr.is_empty() {
            hooks.remove(&event);
        }
    }
    write_json(file, &root)
}

// ── agy: ~/.gemini/config/hooks.json → {"fleetify":{"<Event>":[{matcher?,hooks:[{type,command}]}]}} ──

const AGY_GROUP: &str = "fleetify";

fn merge_agy(file: &Path, h: &NormalizedHook) -> Result<()> {
    let mut root = read_json(file)?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| anyhow!("hooks.json is not an object"))?;
    let group = obj
        .entry(AGY_GROUP.to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow!("`{AGY_GROUP}` is not an object"))?;
    let arr = array_at(group, h.event)?;
    let already = arr.iter().any(|g| {
        matcher_eq(g.get("matcher").and_then(|m| m.as_str()), h.matcher)
            && claude_group_has(g, h.command)
    });
    if already {
        return Ok(());
    }
    let mut g = serde_json::Map::new();
    if let Some(m) = h.matcher {
        g.insert("matcher".into(), json!(m));
    }
    g.insert(
        "hooks".into(),
        json!([{ "type": "command", "command": h.command }]),
    );
    arr.push(Value::Object(g));
    write_json(file, &root)
}

fn unmerge_agy(file: &Path, rec: &HookMergeRecord) -> Result<()> {
    let mut root = read_json(file)?;
    let Some(obj) = root.as_object_mut() else {
        return Ok(());
    };
    let Some(group) = obj.get_mut(AGY_GROUP).and_then(|g| g.as_object_mut()) else {
        return Ok(());
    };
    if let Some(arr) = group.get_mut(&rec.event).and_then(|a| a.as_array_mut()) {
        arr.retain(|g| {
            !(matcher_eq(
                g.get("matcher").and_then(|m| m.as_str()),
                rec.matcher.as_deref(),
            ) && claude_group_has(g, &rec.command))
        });
        if arr.is_empty() {
            group.remove(&rec.event);
        }
    }
    write_json(file, &root)
}

// ── Kimi: config.toml → [[hooks]] {event,command,matcher?} ──

fn read_toml(file: &Path) -> Result<toml::Table> {
    match std::fs::read_to_string(file) {
        Ok(s) if !s.trim().is_empty() => {
            toml::from_str(&s).map_err(|e| anyhow!("parse {}: {e}", file.display()))
        }
        _ => Ok(toml::Table::new()),
    }
}

fn write_toml(file: &Path, t: &toml::Table) -> Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(file, toml::to_string_pretty(t)?)?;
    Ok(())
}

fn kimi_entry_matches(t: &toml::Value, event: &str, matcher: Option<&str>, command: &str) -> bool {
    let get = |k: &str| t.get(k).and_then(|v| v.as_str());
    get("event") == Some(event)
        && matcher_eq(get("matcher"), matcher)
        && get("command") == Some(command)
}

fn merge_kimi(file: &Path, h: &NormalizedHook) -> Result<()> {
    let mut root = read_toml(file)?;
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| toml::Value::Array(vec![]));
    let arr = hooks
        .as_array_mut()
        .ok_or_else(|| anyhow!("`hooks` is not an array"))?;
    if arr
        .iter()
        .any(|t| kimi_entry_matches(t, h.event, h.matcher, h.command))
    {
        return Ok(());
    }
    let mut entry = toml::Table::new();
    entry.insert("event".into(), toml::Value::String(h.event.to_string()));
    if let Some(m) = h.matcher {
        entry.insert("matcher".into(), toml::Value::String(m.to_string()));
    }
    entry.insert("command".into(), toml::Value::String(h.command.to_string()));
    arr.push(toml::Value::Table(entry));
    write_toml(file, &root)
}

fn unmerge_kimi(file: &Path, rec: &HookMergeRecord) -> Result<()> {
    let mut root = read_toml(file)?;
    if let Some(arr) = root.get_mut("hooks").and_then(|h| h.as_array_mut()) {
        arr.retain(|t| !kimi_entry_matches(t, &rec.event, rec.matcher.as_deref(), &rec.command));
        if arr.is_empty() {
            root.remove("hooks");
        }
    }
    write_toml(file, &root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn with_home<R>(home: &Path, f: impl FnOnce() -> R) -> R {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // Pin both HOME and USERPROFILE (provider_home reads USERPROFILE first;
        // sibling modules leak it without restoring).
        let saved: Vec<(&str, Option<String>)> = ["HOME", "USERPROFILE"]
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        std::env::set_var("HOME", home);
        std::env::set_var("USERPROFILE", home);
        let r = f();
        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        r
    }

    fn hook<'a>(event: &'a str, matcher: Option<&'a str>, command: &'a str) -> NormalizedHook<'a> {
        NormalizedHook {
            event,
            matcher,
            command,
        }
    }

    #[test]
    fn claude_merge_is_idempotent_preserves_existing_and_reverses() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        with_home(&home, || {
            let file = home.join(".claude/settings.json");
            // A user already has a hand-written hook + an unrelated setting.
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(
                &file,
                r#"{"theme":"dark","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"user-thing"}]}]}}"#,
            )
            .unwrap();

            let rec =
                materialize_hook_item("claude-code", &hook("PreToolUse", Some("Edit"), "fmt.sh"))
                    .unwrap()
                    .unwrap();
            // Idempotent: second apply is a no-op.
            materialize_hook_item("claude-code", &hook("PreToolUse", Some("Edit"), "fmt.sh"))
                .unwrap();

            let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            let groups = v["hooks"]["PreToolUse"].as_array().unwrap();
            assert_eq!(groups.len(), 2, "user hook preserved + ours added once");
            assert_eq!(v["theme"], "dark", "unrelated settings untouched");

            unmaterialize_hook(&rec).unwrap();
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            let groups = v["hooks"]["PreToolUse"].as_array().unwrap();
            assert_eq!(groups.len(), 1, "ours removed, user hook intact");
            assert_eq!(groups[0]["matcher"], "Bash");
        });
    }

    #[test]
    fn cursor_uses_camel_events_and_flat_entries() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        with_home(&home, || {
            let rec = materialize_hook_item("cursor-cli", &hook("PreToolUse", None, "guard.sh"))
                .unwrap()
                .unwrap();
            let file = home.join(".cursor/hooks.json");
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            assert_eq!(v["version"], 1);
            // camelCase event key, flat {command} entry (no inner hooks array).
            let arr = v["hooks"]["preToolUse"].as_array().unwrap();
            assert_eq!(arr[0]["command"], "guard.sh");
            assert!(arr[0].get("hooks").is_none());

            unmaterialize_hook(&rec).unwrap();
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            assert!(v["hooks"].get("preToolUse").is_none());
        });
    }

    #[test]
    fn agy_writes_named_group_under_gemini_config() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        with_home(&home, || {
            let rec = materialize_hook_item(
                "antigravity-cli",
                &hook("PostToolUse", Some("run_command"), "lint.sh"),
            )
            .unwrap()
            .unwrap();
            // NOT under antigravity-cli — under ~/.gemini/config/.
            let file = home.join(".gemini/config/hooks.json");
            assert!(file.is_file());
            assert_eq!(rec.file, file.to_string_lossy());
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            let arr = v["fleetify"]["PostToolUse"].as_array().unwrap();
            assert_eq!(arr[0]["matcher"], "run_command");
            assert_eq!(arr[0]["hooks"][0]["command"], "lint.sh");

            unmaterialize_hook(&rec).unwrap();
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            assert!(v["fleetify"].get("PostToolUse").is_none());
        });
    }

    #[test]
    fn kimi_toml_array_of_tables_roundtrip() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        with_home(&home, || {
            let file = home.join(".kimi/config.toml");
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "model = \"kimi\"\n").unwrap();

            let rec = materialize_hook_item(
                "kimi-code",
                &hook("PreToolUse", Some("WriteFile"), "protect.sh"),
            )
            .unwrap()
            .unwrap();
            let parsed: toml::Table =
                toml::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            assert_eq!(parsed.get("model").and_then(|v| v.as_str()), Some("kimi"));
            let arr = parsed.get("hooks").and_then(|v| v.as_array()).unwrap();
            assert_eq!(arr.len(), 1);
            assert_eq!(
                arr[0].get("event").and_then(|v| v.as_str()),
                Some("PreToolUse")
            );
            assert_eq!(
                arr[0].get("command").and_then(|v| v.as_str()),
                Some("protect.sh")
            );

            unmaterialize_hook(&rec).unwrap();
            let parsed: toml::Table =
                toml::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            assert!(parsed.get("hooks").is_none(), "empty hooks array removed");
            assert_eq!(parsed.get("model").and_then(|v| v.as_str()), Some("kimi"));
        });
    }

    #[test]
    fn non_merge_provider_returns_none() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            assert!(
                materialize_hook_item("github-copilot", &hook("PreToolUse", None, "x"))
                    .unwrap()
                    .is_none()
            );
            assert!(
                materialize_hook_item("codex-cli", &hook("PreToolUse", None, "x"))
                    .unwrap()
                    .is_none()
            );
        });
    }
}
