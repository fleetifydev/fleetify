//! Feedback bridge — renderer-triggered POST to the Fleetify dashboard
//! API. Faithful port of `frontend/electron/feedback.cjs` from the
//! reference Electron build.
//!
//!   POST <ISSUER>/api/feedback           (multipart/form-data)
//!   ── form fields ──
//!     comment      : text  (required, ≤ 10_000 chars)
//!     email        : text  (optional, ≤ 320 chars — empty = absent)
//!     attachments  : repeated file part(s), image/* only (≤ 8 parts,
//!                                                         ≤ 5 MB each)
//!
//! Wire format: multipart/form-data. The renderer hands us base64
//! data URLs over IPC (modal code stays sandbox-friendly), but we
//! decode them to native bytes here and stream them as proper file
//! parts so the upload stays ~33% smaller than base64-in-JSON.
//!
//! Auth: required. The backend (`apps/backend/src/routes/feedback`)
//! gates POST /api/feedback behind `requireSessionOrOAuthBearer` and
//! rejects unauthenticated requests with 401. We mirror that policy
//! client-side and short-circuit with `NO_BEARER` if no access token
//! is cached — saves an RTT the worker would refuse anyway, and lets
//! the modal render a "Sign in to send feedback" prompt instead of a
//! generic auth error.
//!
//! All non-2xx responses surface as the dashboard's envelope: the
//! IPC reply carries `ok: false` plus the flattened `error`, `code`,
//! `status`, `requestId` fields so the renderer can branch on the
//! stable code (e.g. `NO_BEARER` → sign-in prompt, `VALIDATION` → red
//! inline banner) without re-parsing the message.

use std::time::Duration;

use base64::Engine;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::shell::auth;

const MAX_ATTACHMENTS: usize = 8;
const MAX_BYTES_PER_FILE: usize = 5 * 1024 * 1024;
const MAX_COMMENT_CHARS: usize = 10_000;
const MAX_EMAIL_CHARS: usize = 320;
/// Attachments can stack to ~40 MB on the wire. The Worker streams to
/// R2 so the slow leg is purely client → edge; give the upload room
/// to breathe on hotel-Wi-Fi worst case.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
pub struct FeedbackBody {
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<AttachmentBody>>,
}

#[derive(Debug, Deserialize)]
pub struct AttachmentBody {
    #[serde(default)]
    pub name: Option<String>,
    /// `data:<mime>;base64,<payload>` URL. Anything that doesn't
    /// match an image/* mime or that decodes outside the 0…5 MB
    /// range is silently dropped (matches the Electron build's
    /// "best-effort attach what we can" stance).
    #[serde(default)]
    pub data_url: Option<String>,
}

/// IPC entry point. Validate, build the multipart form, ship it,
/// flatten the response into the renderer-friendly envelope shape.
pub async fn send_feedback(body: FeedbackBody) -> Value {
    // Defense-in-depth: the renderer disables Send when the comment
    // is empty, but a malformed IPC payload shouldn't reach the
    // network either.
    let comment = body.comment.trim();
    if comment.is_empty() {
        return error_envelope("VALIDATION", -1, "Comment is required", None);
    }

    // Pull the access token from the auth cache. `auth: required` on
    // the backend means an empty bearer would 401 anyway — fail
    // locally so the modal can render the sign-in prompt without
    // burning an RTT.
    let token = match auth::get_access_token(false).await {
        Some(v) => v.get("token").and_then(|t| t.as_str()).map(str::to_string),
        None => None,
    };
    let Some(token) = token.filter(|t| !t.is_empty() && t != "noauth") else {
        return error_envelope(
            "NO_BEARER",
            -1,
            "Fleetify access token unavailable. Sign in and try again.",
            None,
        );
    };

    // Build the multipart body. We `Form` is owned, so we move each
    // part in as we go.
    let mut form = Form::new().text("comment", clip(comment, MAX_COMMENT_CHARS));
    if let Some(email) = body.email.as_deref() {
        let trimmed = email.trim();
        if !trimmed.is_empty() {
            form = form.text("email", clip(trimmed, MAX_EMAIL_CHARS));
        }
    }
    if let Some(atts) = body.attachments {
        for a in atts.into_iter().take(MAX_ATTACHMENTS) {
            let Some(data_url) = a.data_url else { continue };
            let Some((mime, bytes)) = decode_data_url(&data_url) else {
                continue;
            };
            if bytes.is_empty() || bytes.len() > MAX_BYTES_PER_FILE {
                continue;
            }
            let filename = safe_name(a.name.as_deref().unwrap_or("image"));
            let part = match Part::bytes(bytes).file_name(filename).mime_str(&mime) {
                Ok(p) => p,
                Err(_) => continue,
            };
            form = form.part("attachments", part);
        }
    }

    let url = format!("{}/api/feedback", auth::issuer());
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return error_envelope(
                "CLIENT_BUILD",
                -1,
                &format!("HTTP client init failed: {e}"),
                None,
            )
        }
    };

    let res = client
        .post(&url)
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await;

    let res = match res {
        Ok(r) => r,
        Err(e) => {
            let code = if e.is_timeout() {
                "TIMEOUT"
            } else if e.is_connect() {
                "NETWORK"
            } else {
                "REQUEST"
            };
            return error_envelope(code, -1, &format!("Feedback upload failed: {e}"), None);
        }
    };

    let status = res.status().as_u16();
    let request_id = res
        .headers()
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .map(str::to_string);
    let text = res.text().await.unwrap_or_default();

    // 2xx — try to parse the dashboard's `{ data: ... }` envelope but
    // tolerate non-JSON bodies (some endpoints respond 204 No Content
    // or an empty body on success).
    if (200..300).contains(&status) {
        if text.is_empty() {
            return json!({ "ok": true, "data": null });
        }
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        // The Electron `apiFetch` returns `body.data ?? body`; mirror.
        let data = parsed.get("data").cloned().unwrap_or(parsed);
        return json!({ "ok": true, "data": data });
    }

    // Non-2xx — surface the dashboard's envelope if it parsed,
    // otherwise fall back to `HTTP_<status>` with a slice of the
    // raw body for context.
    let parsed: Option<Value> = serde_json::from_str(&text).ok();
    if let Some(b) = &parsed {
        if let Some(err) = b.get("error").and_then(|e| e.as_object()) {
            let code = err
                .get("code")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP_{status}"));
            let message = err
                .get("message")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("Request failed ({status})"));
            let req_id_envelope = b
                .get("requestId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or(request_id);
            return error_envelope(&code, status as i32, &message, req_id_envelope);
        }
    }
    let snippet = text.chars().take(500).collect::<String>();
    let fallback_msg = if snippet.is_empty() {
        format!("Request failed ({status})")
    } else {
        snippet
    };
    error_envelope(
        &format!("HTTP_{status}"),
        status as i32,
        &fallback_msg,
        request_id,
    )
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Sanitise a filename for the multipart Content-Disposition header.
/// Strips control chars + path separators; keeps the original
/// extension so the dashboard / R2 viewer can still infer the file
/// type. Mirrors `frontend/electron/feedback.cjs::safeName`.
fn safe_name(name: &str) -> String {
    if name.is_empty() {
        return "image".into();
    }
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if cleaned.is_empty() {
        "image".into()
    } else {
        cleaned
    }
}

/// Decode a `data:<mime>;base64,<payload>` URL into `(mime, bytes)`.
/// Returns `None` for anything that doesn't look like an image data
/// URL we accept — caller silently drops those.
fn decode_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    let rest = data_url.strip_prefix("data:")?;
    let semi = rest.find(';')?;
    let mime = &rest[..semi];
    if !mime.starts_with("image/") {
        return None;
    }
    let after_semi = &rest[semi + 1..];
    let payload = after_semi.strip_prefix("base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .ok()?;
    Some((mime.to_string(), bytes))
}

fn error_envelope(code: &str, status: i32, message: &str, request_id: Option<String>) -> Value {
    let mut o = json!({
        "ok": false,
        "error": message,
        "code": code,
        "status": status,
    });
    if let Some(rid) = request_id {
        o["requestId"] = Value::String(rid);
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_strips_separators_and_caps_length() {
        assert_eq!(
            safe_name("Screen Shot 2026-05-22.png"),
            "Screen_Shot_2026-05-22.png"
        );
        assert_eq!(safe_name("/etc/passwd"), "_etc_passwd");
        assert_eq!(safe_name(""), "image");
        let huge = "a".repeat(200);
        assert_eq!(safe_name(&huge).len(), 80);
    }

    #[test]
    fn decode_rejects_non_image_mime() {
        assert!(decode_data_url("data:text/plain;base64,aGk=").is_none());
        assert!(decode_data_url("not-a-data-url").is_none());
    }

    #[test]
    fn decode_extracts_image_bytes() {
        // 1x1 transparent PNG, base64-encoded.
        let url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let (mime, bytes) = decode_data_url(url).expect("should decode");
        assert_eq!(mime, "image/png");
        assert!(bytes.len() > 50);
    }

    #[test]
    fn error_envelope_omits_request_id_when_absent() {
        let v = error_envelope("X", 400, "bad", None);
        assert!(v.get("requestId").is_none());
    }
}
