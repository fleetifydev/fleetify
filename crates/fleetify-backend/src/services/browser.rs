//! Backend-owned headless Chromium for the shared, interactive Browser
//! panel. ONE browser + page for the app: both the agent (via the thin
//! `fleet-browser-mcp` sidecar → `/api/internal/browser/action`) and the
//! user (via the panel's `/ws/browser`) drive the SAME page. A background
//! loop JPEG-screenshots the page a few times a second and broadcasts
//! frames to whichever panels are connected (and skips the work when none
//! are).
//!
//! This replaces the earlier model where each MCP sidecar owned its own
//! Chromium — the panel couldn't send input to a stdio MCP, so the user
//! could only watch. Centralising the browser here makes it controllable
//! from both sides, like Cursor's browser.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::input::{
    DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams, DispatchMouseEventType,
    InsertTextParams, MouseButton,
};
use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;
use chromiumoxide::page::ScreenshotParams;
use chromiumoxide::Page;
use futures_util::StreamExt as _;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

/// Logical viewport the page renders at. The panel scales mouse coords
/// from its on-screen `<img>` size back into this space before sending.
pub const VIEW_W: u32 = 1280;
pub const VIEW_H: u32 = 800;

/// ~5.5 fps — smooth enough for a control panel without pinning a core.
const FRAME_INTERVAL: Duration = Duration::from_millis(180);

struct Inner {
    #[allow(dead_code)]
    browser: Browser,
    page: Page,
    #[allow(dead_code)]
    handler: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    frames: tokio::task::JoinHandle<()>,
}

fn state() -> &'static Mutex<Option<Inner>> {
    static S: OnceLock<Mutex<Option<Inner>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn frame_tx() -> &'static broadcast::Sender<Arc<Vec<u8>>> {
    static TX: OnceLock<broadcast::Sender<Arc<Vec<u8>>>> = OnceLock::new();
    TX.get_or_init(|| broadcast::channel(8).0)
}

/// Subscribe to the live JPEG frame stream (panel WS).
pub fn subscribe() -> broadcast::Receiver<Arc<Vec<u8>>> {
    frame_tx().subscribe()
}

/// Launch Chromium on first use + start the frame loop. Idempotent.
async fn ensure() -> Result<()> {
    let mut g = state().lock().await;
    if g.is_some() {
        return Ok(());
    }
    // Dedicated, per-process profile dir. chromiumoxide's default is a
    // FIXED `temp/chromiumoxide-runner`, whose `SingletonLock` survives a
    // hard-killed Chrome and then aborts every later launch
    // ("Failed to create a ProcessSingleton"). A per-PID dir wiped up front
    // guarantees a clean slate.
    let profile = std::env::temp_dir().join(format!("fleetify-browser-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&profile);
    let _ = std::fs::create_dir_all(&profile);

    // Chrome 132+ dropped the old `--headless`; it hangs the CDP handshake
    // on Chrome 149. The new headless mode (`--headless=new`) connects.
    let config = BrowserConfig::builder()
        .new_headless_mode()
        .user_data_dir(&profile)
        .window_size(VIEW_W, VIEW_H)
        .build()
        .map_err(|e| anyhow!("browser config: {e}"))?;
    tracing::info!(target: "browser", "launching headless Chromium…");
    let (browser, mut handler) = Browser::launch(config).await.map_err(|e| {
        tracing::error!(target: "browser", "launch failed: {e}");
        anyhow!("could not launch Chrome ({e}) — is Google Chrome / Chromium installed?")
    })?;
    tracing::info!(target: "browser", "Chromium launched");
    let handler = tokio::spawn(async move { while handler.next().await.is_some() {} });
    let page = browser
        .new_page("about:blank")
        .await
        .map_err(|e| anyhow!("open page: {e}"))?;

    // Frame loop — only screenshots while at least one panel is attached.
    let fpage = page.clone();
    let frames = tokio::spawn(async move {
        loop {
            tokio::time::sleep(FRAME_INTERVAL).await;
            let tx = frame_tx();
            if tx.receiver_count() == 0 {
                continue;
            }
            // The very first capture after launch can hang until the page
            // paints its first frame; the timeout keeps the loop alive so
            // it recovers on the next tick instead of wedging forever.
            let shot = tokio::time::timeout(
                Duration::from_secs(3),
                fpage.screenshot(
                    ScreenshotParams::builder()
                        .format(CaptureScreenshotFormat::Jpeg)
                        .quality(55)
                        .capture_beyond_viewport(false)
                        .build(),
                ),
            )
            .await;
            if let Ok(Ok(bytes)) = shot {
                let _ = tx.send(Arc::new(bytes));
            }
        }
    });

    *g = Some(Inner {
        browser,
        page,
        handler,
        frames,
    });
    Ok(())
}

/// Clone the live page handle (lazy-launching the browser first).
async fn page() -> Result<Page> {
    ensure().await?;
    let g = state().lock().await;
    Ok(g.as_ref().expect("ensured").page.clone())
}

async fn snapshot(p: &Page) -> Value {
    let url = p.url().await.ok().flatten().unwrap_or_default();
    let title = p.get_title().await.ok().flatten().unwrap_or_default();
    json!({ "url": url, "title": title })
}

pub async fn navigate(url: &str) -> Result<Value> {
    tracing::info!(target: "browser", "navigate -> {url}");
    let p = page().await?;
    p.goto(url).await.map_err(|e| {
        tracing::error!(target: "browser", "goto failed: {e}");
        anyhow!("navigate: {e}")
    })?;
    let _ = p.wait_for_navigation().await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let snap = snapshot(&p).await;
    tracing::info!(target: "browser", "navigated: {snap}");
    Ok(snap)
}

pub async fn back() -> Result<Value> {
    let p = page().await?;
    let _ = p.evaluate("history.back()").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(snapshot(&p).await)
}

pub async fn forward() -> Result<Value> {
    let p = page().await?;
    let _ = p.evaluate("history.forward()").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(snapshot(&p).await)
}

pub async fn reload() -> Result<Value> {
    let p = page().await?;
    p.reload().await.map_err(|e| anyhow!("reload: {e}"))?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    Ok(snapshot(&p).await)
}

pub async fn read(format: &str) -> Result<Value> {
    let p = page().await?;
    let raw = if format == "html" {
        p.content().await.map_err(|e| anyhow!("content: {e}"))?
    } else {
        p.evaluate("document.body ? document.body.innerText : ''")
            .await
            .map_err(|e| anyhow!("read text: {e}"))?
            .into_value::<String>()
            .unwrap_or_default()
    };
    let content: String = raw.chars().take(40_000).collect();
    let truncated = content.len() < raw.len();
    Ok(json!({ "format": format, "content": content, "truncated": truncated }))
}

pub async fn click_selector(selector: &str) -> Result<Value> {
    let p = page().await?;
    let el = p
        .find_element(selector)
        .await
        .map_err(|e| anyhow!("no element for selector {selector:?}: {e}"))?;
    el.click().await.map_err(|e| anyhow!("click: {e}"))?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(json!({ "clicked": selector }))
}

pub async fn fill_selector(selector: &str, value: &str) -> Result<Value> {
    let p = page().await?;
    let el = p
        .find_element(selector)
        .await
        .map_err(|e| anyhow!("no element for selector {selector:?}: {e}"))?;
    let _ = el.click().await;
    el.type_str(value).await.map_err(|e| anyhow!("type: {e}"))?;
    Ok(json!({ "filled": selector }))
}

pub async fn eval(script: &str) -> Result<Value> {
    let p = page().await?;
    let v = p
        .evaluate(script)
        .await
        .map_err(|e| anyhow!("eval: {e}"))?
        .into_value::<Value>()
        .unwrap_or(Value::Null);
    Ok(json!({ "result": v }))
}

pub async fn screenshot_b64() -> Result<String> {
    let p = page().await?;
    let bytes = p
        .screenshot(
            ScreenshotParams::builder()
                .format(CaptureScreenshotFormat::Png)
                .build(),
        )
        .await
        .map_err(|e| anyhow!("screenshot: {e}"))?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// ── User input forwarding (panel → CDP) ──────────────────────────────

pub async fn click_xy(x: f64, y: f64) -> Result<()> {
    let p = page().await?;
    for ty in [
        DispatchMouseEventType::MousePressed,
        DispatchMouseEventType::MouseReleased,
    ] {
        let ev = DispatchMouseEventParams::builder()
            .r#type(ty)
            .x(x)
            .y(y)
            .button(MouseButton::Left)
            .click_count(1)
            .build()
            .map_err(|e| anyhow!("mouse event: {e}"))?;
        p.execute(ev).await.map_err(|e| anyhow!("dispatch: {e}"))?;
    }
    Ok(())
}

pub async fn scroll(x: f64, y: f64, delta_y: f64) -> Result<()> {
    let p = page().await?;
    let ev = DispatchMouseEventParams::builder()
        .r#type(DispatchMouseEventType::MouseWheel)
        .x(x)
        .y(y)
        .delta_x(0.0)
        .delta_y(delta_y)
        .build()
        .map_err(|e| anyhow!("wheel event: {e}"))?;
    p.execute(ev).await.map_err(|e| anyhow!("dispatch: {e}"))?;
    Ok(())
}

pub async fn type_text(text: &str) -> Result<()> {
    let p = page().await?;
    let ev = InsertTextParams::builder()
        .text(text)
        .build()
        .map_err(|e| anyhow!("insert text: {e}"))?;
    p.execute(ev).await.map_err(|e| anyhow!("dispatch: {e}"))?;
    Ok(())
}

/// A handful of named keys the panel forwards (Enter / Backspace / Tab /
/// arrows). Plain characters go through `type_text`.
pub async fn key(name: &str) -> Result<()> {
    let (key, code, vk) = match name {
        "Enter" => ("Enter", "Enter", 13),
        "Backspace" => ("Backspace", "Backspace", 8),
        "Tab" => ("Tab", "Tab", 9),
        "ArrowLeft" => ("ArrowLeft", "ArrowLeft", 37),
        "ArrowUp" => ("ArrowUp", "ArrowUp", 38),
        "ArrowRight" => ("ArrowRight", "ArrowRight", 39),
        "ArrowDown" => ("ArrowDown", "ArrowDown", 40),
        _ => return Ok(()),
    };
    let p = page().await?;
    for ty in [DispatchKeyEventType::KeyDown, DispatchKeyEventType::KeyUp] {
        let ev = DispatchKeyEventParams::builder()
            .r#type(ty)
            .key(key)
            .code(code)
            .windows_virtual_key_code(vk)
            .build()
            .map_err(|e| anyhow!("key event: {e}"))?;
        p.execute(ev)
            .await
            .map_err(|e| anyhow!("key dispatch: {e}"))?;
    }
    Ok(())
}

/// Dispatch one named action (agent tool path → `/api/internal/browser/action`).
pub async fn action(name: &str, args: &Value) -> Result<Value> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "navigate" => navigate(s("url")).await,
        "read_page" => {
            read(if s("format").is_empty() {
                "text"
            } else {
                s("format")
            })
            .await
        }
        "click" => click_selector(s("selector")).await,
        "fill" => fill_selector(s("selector"), s("value")).await,
        "back" => back().await,
        "forward" => forward().await,
        "reload" => reload().await,
        "eval" => eval(s("script")).await,
        "screenshot" => Ok(json!({ "format": "png", "image_base64": screenshot_b64().await? })),
        other => Err(anyhow!("unknown action: {other}")),
    }
}
