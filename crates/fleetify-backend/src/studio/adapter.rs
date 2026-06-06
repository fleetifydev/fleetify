use crate::routers::ApiError;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;

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
    let child = match Command::new(&bin)
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

/// `hf generate create --json` may print one or more JSON objects (progress).
/// Extract the job id from the last JSON object that has an `id`.
pub fn parse_job_id(stdout: &str) -> Result<String, ApiError> {
    // `hf generate create` may emit mixed output: progress lines followed by
    // a final JSON object. First try to find an `id` in any JSON line scanning
    // from the bottom up (covers both single-JSON and multi-line cases).
    // Only treat the whole output as "failed" when no JSON line exists at all.
    let has_json_line = stdout.lines().any(|l| l.trim().starts_with('{'));
    if !has_json_line && hf_failed(stdout) {
        return Err(ApiError::Internal(format!(
            "hf generate create: {}",
            stdout.trim()
        )));
    }
    for line in stdout.lines().rev() {
        let t = line.trim();
        if t.starts_with('{') {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    return Ok(id.to_string());
                }
            }
        }
    }
    let v: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|e| ApiError::Internal(format!("parse create: {e}")))?;
    v.get("id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ApiError::Internal("create response had no id".into()))
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
    fn parse_job_id_err_on_bare_array() {
        // A bare-array response (no object) must yield Err, not "no id" via an array path.
        assert!(parse_job_id("[]").is_err());
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
