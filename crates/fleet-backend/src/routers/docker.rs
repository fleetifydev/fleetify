//! Faithful port of `app/routers/docker.py`. Wraps the local `docker`
//! CLI so the Docker tab in the new-session toolbar can probe daemon
//! health, list running containers, and browse a container's
//! filesystem — same shape as the SSH router. Agent execution INSIDE
//! the container stays a follow-up.

use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/docker/status", get(status))
        .route("/docker/containers", get(containers))
        .route("/docker/list-dir", post(list_dir))
}

fn container_id_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").expect("container_id_re")
    })
}

#[derive(Deserialize)]
struct ListDirReq {
    container_id: String,
    #[serde(default = "default_path")]
    path: String,
}
fn default_path() -> String {
    "/".into()
}

fn docker_path() -> Option<std::path::PathBuf> {
    which::which("docker").ok()
}

/// Run a docker subprocess and return `(rc, stdout, stderr)`. Times
/// out at `timeout_secs`; on timeout returns 124 + the same
/// "Timed out talking to the Docker daemon." message Python emits.
async fn run_docker(cmd: &[&str], timeout_secs: u64) -> (i32, String, String) {
    let child = match tokio::process::Command::new("docker")
        .args(cmd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (-1, String::new(), format!("spawn docker failed: {e}")),
    };
    let wait = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await;
    match wait {
        Err(_) => (124, String::new(), "Timed out talking to the Docker daemon.".into()),
        Ok(Err(e)) => (-1, String::new(), e.to_string()),
        Ok(Ok(o)) => (
            o.status.code().unwrap_or(0),
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
    }
}

async fn status() -> Json<Value> {
    if docker_path().is_none() {
        return Json(json!({ "installed": false, "running": false, "error": null }));
    }
    let (rc, _out, err) = run_docker(&["info"], 4).await;
    if rc != 0 {
        let short = last_line(&err).unwrap_or_else(|| "Docker daemon is not reachable".into());
        return Json(json!({ "installed": true, "running": false, "error": short }));
    }
    Json(json!({ "installed": true, "running": true, "error": null }))
}

async fn containers() -> Result<Json<Value>, ApiError> {
    if docker_path().is_none() {
        return Err(ApiError::BadRequest("Docker is not installed.".into()));
    }
    let (rc, out, err) = run_docker(&["ps", "--format", "{{json .}}"], 6).await;
    if rc != 0 {
        let short = last_line(&err)
            .unwrap_or_else(|| format!("docker ps exited with code {rc}"));
        return Err(ApiError::BadRequest(short));
    }
    let mut items: Vec<Value> = Vec::new();
    for raw in out.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        items.push(json!({
            "id":     row.get("ID").and_then(|x| x.as_str()).unwrap_or(""),
            "name":   row.get("Names").and_then(|x| x.as_str()).unwrap_or(""),
            "image":  row.get("Image").and_then(|x| x.as_str()).unwrap_or(""),
            "status": row.get("Status").and_then(|x| x.as_str()).unwrap_or(""),
            "state":  row.get("State").and_then(|x| x.as_str()).unwrap_or("running"),
        }));
    }
    Ok(Json(json!({ "containers": items })))
}

async fn list_dir(Json(req): Json<ListDirReq>) -> Result<Json<Value>, ApiError> {
    if req.container_id.is_empty()
        || req.container_id.len() > 128
        || !container_id_re().is_match(&req.container_id)
    {
        return Err(ApiError::BadRequest("invalid container_id".into()));
    }
    if req.path.len() > 2048 {
        return Err(ApiError::BadRequest("path too long".into()));
    }
    if docker_path().is_none() {
        return Err(ApiError::BadRequest("Docker is not installed.".into()));
    }
    let quoted = sh_quote(&req.path);
    let script = format!(
        "cd {quoted} 2>/dev/null && \
        for f in $(ls -A); do \
          printf '%s\\t' \"$f\"; \
          stat -c '%F\\t%s' -- \"$f\" 2>/dev/null \
          || stat -f '%HT\\t%z' -- \"$f\" 2>/dev/null \
          || printf 'unknown\\t0'; \
          printf '\\n'; \
        done"
    );
    let (rc, out, err) = run_docker(
        &["exec", &req.container_id, "sh", "-c", &script],
        8,
    )
    .await;
    if rc != 0 {
        let short = last_line(&err)
            .unwrap_or_else(|| format!("docker exec exited with code {rc}"));
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
        entries.push(json!({ "name": name, "type": kind, "size": size_v }));
    }
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
    Ok(Json(json!({ "path": req.path, "entries": entries })))
}

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
    fn container_id_charset_rejects_shell_chars_and_leading_dash() {
        assert!(container_id_re().is_match("abc123"));
        assert!(container_id_re().is_match("name_with-stuff.1"));
        assert!(!container_id_re().is_match("-malicious-flag"));
        assert!(!container_id_re().is_match(";rm -rf /"));
        assert!(!container_id_re().is_match(""));
    }

    #[test]
    fn sh_quote_escapes_single_quotes_and_handles_empty() {
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("/path/with spaces"), "'/path/with spaces'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn last_line_drops_blank_trailing_lines() {
        assert_eq!(last_line("a\nb\n\n").as_deref(), Some("b"));
        assert!(last_line("\n\n").is_none());
        assert!(last_line("").is_none());
    }
}
