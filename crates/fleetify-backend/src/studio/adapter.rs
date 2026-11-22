use crate::routers::ApiError;
use fleetify_core::process::tokio_command;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfModel {
    pub display_name: String,
    pub job_set_type: String,
    #[serde(rename = "type")]
    pub media_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfModelParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub required: bool,
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfModelDetail {
    pub display_name: String,
    pub job_set_type: String,
    #[serde(rename = "type")]
    pub media_type: String,
    #[serde(default)]
    pub params: Vec<HfModelParam>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfAccount {
    pub email: String,
    pub credits: f64,
    #[serde(default)]
    pub subscription_plan_type: String,
}

/// `hf` prints errors as plain text on stdout with exit 0. Treat empty or a
/// body that doesn't begin with JSON ('[' or '{') as failure.
pub fn hf_failed(stdout: &str) -> bool {
    let t = stdout.trim_start();
    !(t.starts_with('[') || t.starts_with('{'))
}

pub fn parse_model_list(stdout: &str) -> Result<Vec<HfModel>, ApiError> {
    if hf_failed(stdout) {
        return Err(ApiError::Internal(format!(
            "hf model list: {}",
            stdout.trim()
        )));
    }
    serde_json::from_str(stdout).map_err(|e| ApiError::Internal(format!("parse model list: {e}")))
}

pub fn parse_model_detail(stdout: &str) -> Result<HfModelDetail, ApiError> {
    if hf_failed(stdout) {
        return Err(ApiError::Internal(format!(
            "hf model get: {}",
            stdout.trim()
        )));
    }
    serde_json::from_str(stdout).map_err(|e| ApiError::Internal(format!("parse model detail: {e}")))
}

pub fn parse_account(stdout: &str) -> Result<HfAccount, ApiError> {
    if hf_failed(stdout) {
        return Err(ApiError::Internal(format!("hf account: {}", stdout.trim())));
    }
    serde_json::from_str(stdout).map_err(|e| ApiError::Internal(format!("parse account: {e}")))
}

/// Resolve the `hf` binary on PATH (absolute path so Windows shims resolve).
pub async fn hf_path() -> Option<String> {
    let p = which::which("hf").ok()?;
    Some(p.to_string_lossy().into_owned())
}

/// Run `hf <args>` and capture (exit_code, stdout, stderr).
pub async fn run_hf(args: &[&str], timeout_secs: u64) -> (i32, String, String) {
    let bin = match hf_path().await {
        Some(b) => b,
        None => return (-1, String::new(), "hf not found on PATH".into()),
    };
    let child = match tokio_command(&bin)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (-1, String::new(), format!("spawn hf failed: {e}")),
    };
    match tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Err(_) => (124, String::new(), "hf timed out".into()),
        Ok(Err(e)) => (-1, String::new(), e.to_string()),
        Ok(Ok(o)) => (
            o.status.code().unwrap_or(0),
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
    }
}

/// Authenticated iff `hf auth token` prints an `hf_` token on stdout.
pub async fn hf_authenticated() -> bool {
    let (_c, out, _e) = run_hf(&["auth", "token"], 10).await;
    out.trim().starts_with("hf_")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfCost {
    pub credits: f64,
    #[serde(default)]
    pub credits_exact: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfJob {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub result_url: Option<String>,
    #[serde(default)]
    pub result_urls: Option<Vec<String>>,
    #[serde(default)]
    pub job_set_type: String,
    /// Failure detail when hf marks a job failed/cancelled. Best-effort —
    /// hf doesn't always populate these, so both are tolerated absent.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl HfJob {
    /// All result URLs (prefers the multi-result array, falls back to the single url).
    pub fn urls(&self) -> Vec<String> {
        if let Some(list) = &self.result_urls {
            if !list.is_empty() {
                return list.clone();
            }
        }
        self.result_url.clone().into_iter().collect()
    }

    pub fn is_done(&self) -> bool {
        self.status == "completed"
    }

    pub fn is_failed(&self) -> bool {
        matches!(self.status.as_str(), "failed" | "error" | "cancelled")
    }

    /// Human-readable failure reason, if hf provided one.
    pub fn failure_reason(&self) -> Option<&str> {
        self.error
            .as_deref()
            .or(self.reason.as_deref())
            .filter(|s| !s.is_empty())
    }
}

/// Build `["--<k>", "<v>", ...]` from a params object. Skips nulls. Owned Strings.
pub fn params_to_args(params: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    let mut out = Vec::new();
    for (k, v) in params {
        let val = match v {
            serde_json::Value::Null => continue,
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Bool(b) => b.to_string(),
            other => other.to_string(),
        };
        out.push(format!("--{k}"));
        out.push(val);
    }
    out
}

pub fn parse_cost(stdout: &str) -> Result<HfCost, ApiError> {
    if hf_failed(stdout) {
        return Err(ApiError::Internal(format!(
            "hf generate cost: {}",
            stdout.trim()
        )));
    }
    serde_json::from_str(stdout).map_err(|e| ApiError::Internal(format!("parse cost: {e}")))
}

pub fn parse_job(stdout: &str) -> Result<HfJob, ApiError> {
    if hf_failed(stdout) {
        return Err(ApiError::Internal(format!(
            "hf generate get: {}",
            stdout.trim()
        )));
    }
    serde_json::from_str(stdout).map_err(|e| ApiError::Internal(format!("parse job: {e}")))
}

/// Heuristic: a result URL is video if its path (ignoring query/fragment) ends
/// with a known video extension. Used to tag persisted artifacts so the UI
/// renders <video> vs <img>.
pub fn is_video_url(url: &str) -> bool {
    let base = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();
    [".mp4", ".webm", ".mov", ".m4v"]
        .iter()
        .any(|ext| base.ends_with(ext))
}

/// File name for a result URL: its last path segment (hf names files
/// `hf_<ts>_<uuid>.<ext>`), ignoring query/fragment. Falls back to `asset`.
pub fn asset_filename(url: &str) -> String {
    url.split(['?', '#'])
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("asset")
        .to_string()
}

/// Download `url` into `dir`, returning the saved path. Best-effort from the
/// caller's view: a failure just means "no local copy" and the remote URL is
/// still shown. The folder is created if missing.
pub async fn download_asset(
    url: &str,
    dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| e.to_string())?;
    let path = dir.join(asset_filename(url));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Extract a job id from a create-response JSON value. Higgsfield's
/// `hf generate create --json` returns a JSON array of id strings — `["<uuid>"]`
/// — but we also tolerate an object carrying an `id` or a bare id string.
fn job_id_from_value(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Array(items) => {
            items.iter().find_map(|x| x.as_str().map(str::to_string))
        }
        serde_json::Value::Object(_) => v.get("id").and_then(|x| x.as_str()).map(str::to_string),
        serde_json::Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// Turn `hf`'s error stdout into a clear, user-facing message. hf prints
/// `Error: {json}` (exit 0) where the json carries an `error_type`; map the
/// known ones to friendly text and fall back to the raw error otherwise.
pub fn hf_error_message(stdout: &str) -> String {
    let trimmed = stdout.trim();
    let body = trimmed
        .strip_prefix("Error:")
        .or_else(|| trimmed.strip_prefix("error:"))
        .unwrap_or(trimmed)
        .trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(t) = v.get("error_type").and_then(|x| x.as_str()) {
            return match t {
                "not_enough_credits" => "Not enough Higgsfield credits for this generation.".into(),
                "unauthorized" | "unauthenticated" | "not_authenticated" => {
                    "Not connected to Higgsfield — run `hf auth login`.".into()
                }
                other => format!("Higgsfield error: {}", other.replace('_', " ")),
            };
        }
    }
    if body.is_empty() {
        return "Higgsfield returned no result.".into();
    }
    let raw: String = body.chars().take(200).collect();
    format!("Higgsfield error: {raw}")
}

/// Parse the job id out of `hf generate create --json` output.
///
/// The canonical shape is a JSON array of one id string (`["<uuid>"]`), but we
/// also tolerate progress lines followed by a final JSON object that carries an
/// `id`. Non-JSON output means a CLI error (hf prints errors on stdout, exit 0).
pub fn parse_job_id(stdout: &str) -> Result<String, ApiError> {
    // Whole-body first (handles pretty-printed multi-line arrays/objects)…
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if let Some(id) = job_id_from_value(&v) {
            return Ok(id);
        }
    }
    // …then individual lines bottom-up (a final JSON object after progress text).
    for line in stdout.lines().rev() {
        let t = line.trim();
        if t.starts_with('{') || t.starts_with('[') {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                if let Some(id) = job_id_from_value(&v) {
                    return Ok(id);
                }
            }
        }
    }
    // No id anywhere → hf reported an error (it prints `Error: {json}` on
    // stdout with exit 0). Surface a clear, user-facing reason as a 400.
    Err(ApiError::BadRequest(hf_error_message(stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hf_failed_detects_errors_and_empty() {
        assert!(hf_failed("Error: Job not found"));
        assert!(hf_failed(""));
        assert!(hf_failed("  No workspace selected."));
        assert!(!hf_failed("[]"));
        assert!(!hf_failed("  [ {} ]"));
        assert!(!hf_failed("{\"x\":1}"));
    }

    #[test]
    fn parse_model_list_ok() {
        let raw = r#"[{"display_name":"FLUX.2","job_set_type":"flux_2","type":"image"},
                      {"display_name":"Google Veo 3","job_set_type":"veo3","type":"video"}]"#;
        let v = parse_model_list(raw).expect("ok");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].job_set_type, "flux_2");
        assert_eq!(v[0].media_type, "image");
        assert_eq!(v[1].media_type, "video");
    }

    #[test]
    fn parse_model_list_err_on_error_text() {
        assert!(parse_model_list("Error: nope").is_err());
    }

    #[test]
    fn parse_model_detail_ok() {
        let raw = r#"{"display_name":"Nano Banana Pro","job_set_type":"nano_banana_2","type":"image",
            "params":[
              {"name":"aspect_ratio","type":"string","default":"1:1","required":false,"enum":["1:1","16:9"]},
              {"name":"prompt","type":"string","default":null,"required":true}
            ]}"#;
        let d = parse_model_detail(raw).expect("ok");
        assert_eq!(d.job_set_type, "nano_banana_2");
        assert_eq!(d.params.len(), 2);
        let ar = &d.params[0];
        assert_eq!(ar.name, "aspect_ratio");
        assert!(!ar.required);
        assert_eq!(ar.enum_values.as_ref().unwrap().len(), 2);
        let prompt = &d.params[1];
        assert!(prompt.required);
        assert!(prompt.enum_values.is_none());
    }

    #[test]
    fn parse_account_ok() {
        let raw = r#"{"email":"a@b.com","credits":3,"subscription_plan_type":"free"}"#;
        let a = parse_account(raw).expect("ok");
        assert_eq!(a.email, "a@b.com");
        assert_eq!(a.credits, 3.0);
        assert_eq!(a.subscription_plan_type, "free");
    }

    #[test]
    fn parse_cost_ok() {
        let raw = r#"{"credits":2,"credits_exact":2}"#;
        let c = parse_cost(raw).expect("ok");
        assert_eq!(c.credits, 2.0);
        assert_eq!(c.credits_exact, 2.0);
    }

    #[test]
    fn parse_cost_err_on_error_text() {
        assert!(parse_cost("Error: no model").is_err());
    }

    #[test]
    fn parse_job_completed_single_url() {
        let raw = r#"{"id":"job123","status":"completed","result_url":"https://example.com/out.png","job_set_type":"flux_2"}"#;
        let j = parse_job(raw).expect("ok");
        assert!(j.is_done());
        assert!(!j.is_failed());
        assert_eq!(j.urls(), vec!["https://example.com/out.png"]);
    }

    #[test]
    fn parse_job_completed_multi_urls() {
        let raw = r#"{"id":"job456","status":"completed","result_urls":["https://example.com/a.png","https://example.com/b.png"],"job_set_type":"flux_2"}"#;
        let j = parse_job(raw).expect("ok");
        assert!(j.is_done());
        assert_eq!(
            j.urls(),
            vec!["https://example.com/a.png", "https://example.com/b.png"]
        );
    }

    #[test]
    fn parse_job_failed_status() {
        let raw = r#"{"id":"job789","status":"failed","job_set_type":"flux_2"}"#;
        let j = parse_job(raw).expect("ok");
        assert!(!j.is_done());
        assert!(j.is_failed());
    }

    #[test]
    fn parse_job_cancelled_is_failed() {
        let raw = r#"{"id":"jobabc","status":"cancelled","job_set_type":"flux_2"}"#;
        let j = parse_job(raw).expect("ok");
        assert!(j.is_failed());
    }

    #[test]
    fn parse_job_err_on_error_text() {
        assert!(parse_job("Error: job not found").is_err());
    }

    #[test]
    fn parse_job_id_from_single_json() {
        let raw = r#"{"id":"abc","status":"queued"}"#;
        let id = parse_job_id(raw).expect("ok");
        assert_eq!(id, "abc");
    }

    #[test]
    fn parse_job_id_from_multiline() {
        let raw = "Created job\n{\"id\":\"xyz\",\"status\":\"queued\"}";
        let id = parse_job_id(raw).expect("ok");
        assert_eq!(id, "xyz");
    }

    #[test]
    fn parse_job_id_err_on_error_text() {
        assert!(parse_job_id("Error: x").is_err());
    }

    #[test]
    fn parse_job_id_from_string_array() {
        // hf generate create --json returns ["<uuid>"] (the real shape).
        let raw = "[\n  \"540f9619-4967-4e5e-bc58-04417b35cb0b\"\n]";
        let id = parse_job_id(raw).expect("ok");
        assert_eq!(id, "540f9619-4967-4e5e-bc58-04417b35cb0b");
    }

    #[test]
    fn parse_job_id_from_compact_string_array() {
        assert_eq!(parse_job_id(r#"["abc-123"]"#).expect("ok"), "abc-123");
    }

    #[test]
    fn parse_job_id_err_on_empty_array() {
        // An empty array carries no id → Err (not a panic, not a false id).
        assert!(parse_job_id("[]").is_err());
    }

    #[test]
    fn hf_error_message_maps_credits() {
        let raw = r#"Error: {"billing_period":null,"error_type":"not_enough_credits","plan_type":"free"}"#;
        let msg = hf_error_message(raw);
        assert!(msg.to_lowercase().contains("credit"), "got: {msg}");
    }

    #[test]
    fn hf_error_message_humanizes_unknown_type() {
        let raw = r#"Error: {"error_type":"some_weird_thing"}"#;
        assert_eq!(hf_error_message(raw), "Higgsfield error: some weird thing");
    }

    #[test]
    fn hf_error_message_falls_back_to_raw() {
        assert_eq!(hf_error_message("Error: boom"), "Higgsfield error: boom");
    }

    #[test]
    fn parse_job_id_credit_error_is_friendly() {
        let raw = r#"Error: {"error_type":"not_enough_credits","plan_type":"free"}"#;
        match parse_job_id(raw).unwrap_err() {
            ApiError::BadRequest(m) => assert!(m.to_lowercase().contains("credit"), "got: {m}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn asset_filename_extracts_segment() {
        assert_eq!(
            asset_filename("https://cdn/u/hf_20260607_161039_540f9619.png"),
            "hf_20260607_161039_540f9619.png"
        );
        assert_eq!(
            asset_filename("https://cdn/a/out.mp4?sig=xyz&e=1"),
            "out.mp4"
        );
        assert_eq!(asset_filename("https://cdn/trailing/"), "asset");
    }

    #[test]
    fn is_video_url_detects_extensions() {
        assert!(is_video_url("https://x/out.mp4"));
        assert!(is_video_url("https://x/OUT.MOV?sig=abc"));
        assert!(is_video_url("https://x/a.webm#t"));
        assert!(!is_video_url("https://x/out.png"));
        assert!(!is_video_url("https://x/out.jpg?x=1"));
    }

    #[test]
    fn params_to_args_basic() {
        let mut map = serde_json::Map::new();
        map.insert("prompt".into(), serde_json::Value::String("hi".into()));
        map.insert(
            "aspect_ratio".into(),
            serde_json::Value::String("16:9".into()),
        );
        map.insert("folder_id".into(), serde_json::Value::Null);
        let args = params_to_args(&map);
        // Check --folder_id is absent
        assert!(!args.contains(&"--folder_id".to_string()));
        // Check prompt and aspect_ratio are present
        let prompt_pos = args.iter().position(|a| a == "--prompt");
        assert!(prompt_pos.is_some());
        assert_eq!(args[prompt_pos.unwrap() + 1], "hi");
        let ar_pos = args.iter().position(|a| a == "--aspect_ratio");
        assert!(ar_pos.is_some());
        assert_eq!(args[ar_pos.unwrap() + 1], "16:9");
    }
}
