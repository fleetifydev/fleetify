//! Faithful port of `app/routers/ssh.py`. SSH connection probe +
//! remote directory browse, used by the new-session toolbar's Remote
//! tab. Wraps the system `ssh` binary with BatchMode/ConnectTimeout/
//! StrictHostKeyChecking=accept-new so first contact registers a key
//! without an interactive prompt.

use std::path::PathBuf;

use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::{ApiError, AppState};

// Field-validation regexes — pin out characters that could be
// interpreted as ssh option flags or shell metacharacters. Matches
// chat.py's Pydantic patterns exactly.
fn host_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$").expect("host_re"))
}
fn user_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"^[A-Za-z0-9._-]+$").expect("user_re"))
}
fn ident_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"^[A-Za-z0-9/_.~-]+$").expect("ident_re"))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ssh/known-hosts", get(known_hosts))
        .route("/ssh/test", post(test_target))
        .route("/ssh/list-dir", post(list_dir))
}

#[derive(Deserialize, Debug, Clone)]
struct SshTarget {
    host: String,
    user: String,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    identity_file: Option<String>,
}
fn default_port() -> u16 {
    22
}

#[derive(Deserialize, Debug)]
struct ListDirReq {
    #[serde(flatten)]
    target: SshTarget,
    #[serde(default = "default_path")]
    path: String,
}
fn default_path() -> String {
    ".".into()
}

fn validate(target: &SshTarget) -> Result<(), ApiError> {
    if target.host.is_empty() || target.host.len() > 253 || !host_re().is_match(&target.host) {
        return Err(ApiError::BadRequest("invalid host".into()));
    }
    if target.user.is_empty() || target.user.len() > 64 || !user_re().is_match(&target.user) {
        return Err(ApiError::BadRequest("invalid user".into()));
    }
    if target.port == 0 {
        return Err(ApiError::BadRequest("invalid port".into()));
    }
    if let Some(idf) = target.identity_file.as_deref() {
        if idf.len() > 512 || !ident_re().is_match(idf) {
            return Err(ApiError::BadRequest("invalid identity_file".into()));
        }
    }
    Ok(())
}

fn home() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into()),
    )
}

fn build_ssh_args(t: &SshTarget) -> Vec<String> {
    let mut args = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=5".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-p".into(),
        t.port.to_string(),
    ];
    if let Some(idf) = t.identity_file.as_deref().filter(|s| !s.is_empty()) {
        // Expand ~ so the user can paste "~/.ssh/id_ed25519" without
        // the shell interpreting it.
        let expanded = if let Some(rest) = idf.strip_prefix("~/") {
            home().join(rest).to_string_lossy().into_owned()
        } else if idf == "~" {
            home().to_string_lossy().into_owned()
        } else {
            idf.to_string()
        };
        args.push("-i".into());
        args.push(expanded);
    }
    args.push(format!("{}@{}", t.user, t.host));
    args
}

/// Run a subprocess capturing stdout/stderr. Returns `(rc, out, err)`.
/// `timeout_secs` defaults to 8s; on timeout returns 124, "",
/// "Timed out while contacting the host." (faithful with Python).
async fn run_ssh_cmd(cmd: &[String], timeout_secs: u64) -> (i32, String, String) {
    let child = match tokio::process::Command::new("ssh")
        .args(cmd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (-1, String::new(), format!("spawn ssh failed: {e}")),
    };
    let wait = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await;
    match wait {
        Err(_) => (124, String::new(), "Timed out while contacting the host.".into()),
        Ok(Err(e)) => (-1, String::new(), e.to_string()),
        Ok(Ok(o)) => (
            o.status.code().unwrap_or(0),
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
    }
}

async fn known_hosts() -> Json<Value> {
    let cfg = home().join(".ssh").join("config");
    if !cfg.is_file() {
        return Json(json!({ "hosts": [] }));
    }
    let text = match std::fs::read_to_string(&cfg) {
        Ok(t) => t,
        Err(_) => return Json(json!({ "hosts": [] })),
    };
    Json(json!({ "hosts": parse_ssh_config(&text) }))
}

/// Parse a subset of `~/.ssh/config` into Fleet's host shape.
/// Only Host/HostName/User/Port/IdentityFile keys are surfaced;
/// wildcards / pattern lists / Match blocks are ignored.
fn parse_ssh_config(text: &str) -> Vec<Value> {
    #[derive(Default)]
    struct Block {
        alias: String,
        host: String,
        user: String,
        port: u16,
        identity_file: Option<String>,
    }
    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Option<Block> = None;
    let flush = |out: &mut Vec<Block>, b: Option<Block>| {
        if let Some(mut b) = b {
            if !b.user.is_empty() {
                // No HostName declared → fall back to alias so the
                // user's saved alias still resolves via their own ssh.
                if b.host.is_empty() {
                    b.host = b.alias.clone();
                }
                if !b.host.is_empty() {
                    out.push(b);
                }
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let Some(key) = parts.next() else { continue };
        let Some(value) = parts.next() else { continue };
        let key = key.to_lowercase();
        let value = value.trim();
        if key == "host" {
            flush(&mut blocks, current.take());
            // Skip wildcards / pattern lists.
            if value.chars().any(|c| c == '*' || c == '?') || value.contains(' ') {
                current = None;
                continue;
            }
            current = Some(Block {
                alias: value.to_string(),
                port: 22,
                ..Default::default()
            });
            continue;
        }
        let Some(b) = current.as_mut() else { continue };
        match key.as_str() {
            "hostname" => b.host = value.to_string(),
            "user" => b.user = value.to_string(),
            "port" => {
                if let Ok(p) = value.parse::<u16>() {
                    b.port = p;
                }
            }
            "identityfile" => {
                let v = value.trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    b.identity_file = Some(v.to_string());
                }
            }
            _ => {}
        }
    }
    flush(&mut blocks, current.take());
    blocks
        .into_iter()
        .map(|b| {
            json!({
                "label": if b.alias.is_empty() { &b.host } else { &b.alias },
                "host": b.host,
                "user": b.user,
                "port": b.port,
                "identity_file": b.identity_file,
            })
        })
        .collect()
}

async fn test_target(Json(t): Json<SshTarget>) -> Result<Json<Value>, ApiError> {
    validate(&t)?;
    let mut cmd = build_ssh_args(&t);
    cmd.push("echo".into());
    cmd.push("ok".into());
    let (rc, out, err) = run_ssh_cmd(&cmd, 8).await;
    if rc == 0 && out.trim() == "ok" {
        return Ok(Json(json!({ "ok": true })));
    }
    let short = last_line(&err).unwrap_or_else(|| format!("ssh exited with code {rc}"));
    Ok(Json(json!({ "ok": false, "error": short })))
}

async fn list_dir(Json(req): Json<ListDirReq>) -> Result<Json<Value>, ApiError> {
    validate(&req.target)?;
    let remote_path = if req.path.is_empty() {
        ".".to_string()
    } else {
        req.path.clone()
    };
    // Tilde expansion is shell-side (the remote shell needs to do it).
    // Quote any user-supplied suffix so spaces / weird chars don't
    // break the round-trip.
    let cd_target = if remote_path == "~" {
        "$HOME".to_string()
    } else if let Some(rest) = remote_path.strip_prefix("~/") {
        format!("$HOME/{}", sh_quote(rest))
    } else {
        sh_quote(&remote_path)
    };
    let script = format!(
        "cd {cd_target} 2>/dev/null && \
        for f in $(ls -A); do \
          printf '%s\\t' \"$f\"; \
          stat -c '%F\\t%s' -- \"$f\" 2>/dev/null \
          || stat -f '%HT\\t%z' -- \"$f\" 2>/dev/null \
          || printf 'unknown\\t0'; \
          printf '\\n'; \
        done"
    );
    let mut cmd = build_ssh_args(&req.target);
    cmd.push("sh".into());
    cmd.push("-c".into());
    cmd.push(script);
    let (rc, out, err) = run_ssh_cmd(&cmd, 10).await;
    if rc != 0 {
        let short = last_line(&err).unwrap_or_else(|| format!("ssh exited with code {rc}"));
        return Err(ApiError::BadRequest(short));
    }
    let mut entries: Vec<Value> = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0];
        let kind_raw = parts[1].to_lowercase();
        let size_raw = parts[2];
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let kind = if kind_raw.contains("directory") {
            "folder"
        } else {
            "file"
        };
        let size: i64 = size_raw.parse().unwrap_or(0);
        let size_v: Value = if kind == "file" {
            json!(size)
        } else {
            Value::Null
        };
        entries.push(json!({
            "name": name,
            "type": kind,
            "size": size_v,
        }));
    }
    // Folders first, then files — simple alpha within each group.
    entries.sort_by(|a, b| {
        let a_folder = a["type"] == "folder";
        let b_folder = b["type"] == "folder";
        let a_name = a["name"].as_str().unwrap_or("").to_lowercase();
        let b_name = b["name"].as_str().unwrap_or("").to_lowercase();
        match (a_folder, b_folder) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a_name.cmp(&b_name),
        }
    });
    Ok(Json(json!({ "path": remote_path, "entries": entries })))
}

/// POSIX-style single-quote shell quoter. Wraps `value` in `'…'` and
/// escapes embedded single quotes via the classic `'\''` trick.
fn sh_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".into();
    }
    let escaped = value.replace('\'', r"'\''");
    format!("'{escaped}'")
}

fn last_line(text: &str) -> Option<String> {
    text.trim()
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_config_handles_alias_only_block_with_fallback_to_alias_as_host() {
        let cfg = "Host my-prod-box\n    User loseu\n    Port 2222\n";
        let parsed = parse_ssh_config(cfg);
        assert_eq!(parsed.len(), 1);
        // No HostName declared → host falls back to the alias.
        assert_eq!(parsed[0]["host"], "my-prod-box");
        assert_eq!(parsed[0]["user"], "loseu");
        assert_eq!(parsed[0]["port"], 2222);
    }

    #[test]
    fn parse_ssh_config_drops_wildcard_and_match_blocks() {
        let cfg = "\
            Host github.com gitlab.com\n    User git\n\
            Host *\n    User wildcard\n\
            Host actual\n    HostName real.example.com\n    User loseu\n\
        ";
        let parsed = parse_ssh_config(cfg);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["host"], "real.example.com");
        assert_eq!(parsed[0]["user"], "loseu");
        assert_eq!(parsed[0]["label"], "actual");
    }

    #[test]
    fn parse_ssh_config_keeps_identity_file_and_strips_quotes() {
        let cfg = "\
            Host box\n    HostName 1.2.3.4\n    User u\n    IdentityFile \"~/.ssh/id_ed25519\"\n\
        ";
        let parsed = parse_ssh_config(cfg);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["identity_file"], "~/.ssh/id_ed25519");
    }

    #[test]
    fn validate_rejects_leading_dash_host_and_shell_chars() {
        let bad = SshTarget {
            host: "-oProxyCommand=bad".into(),
            user: "u".into(),
            port: 22,
            identity_file: None,
        };
        assert!(validate(&bad).is_err());
        let bad2 = SshTarget {
            host: "good".into(),
            user: "u".into(),
            port: 22,
            identity_file: Some("/etc/key; rm -rf /".into()),
        };
        assert!(validate(&bad2).is_err());
    }

    #[test]
    fn build_ssh_args_expands_tilde_in_identity_file() {
        let t = SshTarget {
            host: "h".into(),
            user: "u".into(),
            port: 22,
            identity_file: Some("~/.ssh/id_ed25519".into()),
        };
        let args = build_ssh_args(&t);
        // -i argument is the home-expanded path, not the literal "~".
        let idx = args.iter().position(|a| a == "-i").unwrap();
        let path = &args[idx + 1];
        assert!(path.contains(".ssh"));
        assert!(!path.contains('~'));
    }

    #[test]
    fn sh_quote_wraps_value_and_escapes_embedded_single_quote() {
        assert_eq!(sh_quote("hello"), "'hello'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn last_line_returns_last_nonempty_trimmed() {
        let txt = "first\nsecond\n\n  \n";
        assert_eq!(last_line(txt).as_deref(), Some("second"));
        assert!(last_line("").is_none());
    }

}
