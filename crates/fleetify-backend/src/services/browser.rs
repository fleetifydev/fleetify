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

/// ~20 fps — smooth-enough scroll/typing while keeping retina-sharp
/// screenshots cheap on localhost. Skipped entirely when no panel watches.
const FRAME_INTERVAL: Duration = Duration::from_millis(50);

// Idle-shutdown: headless Chromium holds ~300-600 MB resident even when no
// panel is open and no agent is driving it. The watchdog wakes every
// IDLE_CHECK and closes the browser once it has gone IDLE_SHUTDOWN with no
// panel watching AND no CDP op touching it; the next `page()` re-launches.
const IDLE_CHECK: Duration = Duration::from_secs(20);
const IDLE_SHUTDOWN: Duration = Duration::from_secs(180);

/// Real desktop-Chrome UA. The backend browser IS Chrome, but new-headless
/// stamps "HeadlessChrome" into the UA, which sites read as a bot and serve
/// the stripped page to. Overriding with the matching non-headless Chrome
/// string (engine + UA agree, so no fingerprint mismatch) gets the full
/// modern site.
const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

struct Inner {
    #[allow(dead_code)]
    browser: Browser,
    page: Page,
    #[allow(dead_code)]
    handler: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    frames: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    urls: tokio::task::JoinHandle<()>,
}

fn state() -> &'static Mutex<Option<Inner>> {
    static S: OnceLock<Mutex<Option<Inner>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Wall-clock of the last browser touch — a CDP op via `page()` or a launch.
/// The idle watchdog reads this so a browser that's actively driven by an
/// agent over CDP but has no panel attached (receiver_count == 0) is never
/// torn down mid-task. A brief sync lock (no await held), poison-recovering.
fn last_activity() -> &'static std::sync::Mutex<std::time::Instant> {
    static A: OnceLock<std::sync::Mutex<std::time::Instant>> = OnceLock::new();
    A.get_or_init(|| std::sync::Mutex::new(std::time::Instant::now()))
}
fn touch_activity() {
    *last_activity().lock().unwrap_or_else(|e| e.into_inner()) = std::time::Instant::now();
}
fn idle_for() -> Duration {
    last_activity()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .elapsed()
}

fn frame_tx() -> &'static broadcast::Sender<Arc<Vec<u8>>> {
    static TX: OnceLock<broadcast::Sender<Arc<Vec<u8>>>> = OnceLock::new();
    TX.get_or_init(|| broadcast::channel(8).0)
}

/// Subscribe to the live JPEG frame stream (panel WS).
pub fn subscribe() -> broadcast::Receiver<Arc<Vec<u8>>> {
    frame_tx().subscribe()
}

/// Current-URL change broadcast — drives the panel's native-webview URL
/// mirroring (agent navigates the CDP page ⇒ panel follows, and vice versa).
fn url_tx() -> &'static broadcast::Sender<String> {
    static U: OnceLock<broadcast::Sender<String>> = OnceLock::new();
    U.get_or_init(|| broadcast::channel(16).0)
}

/// Subscribe to current-URL changes.
pub fn subscribe_url() -> broadcast::Receiver<String> {
    url_tx().subscribe()
}

/// Current page URL IF the browser is already launched — never launches it
/// (so a panel polling for the URL doesn't spin up Chromium unprompted).
pub async fn current_url_opt() -> Option<String> {
    let p = { state().lock().await.as_ref()?.page.clone() };
    p.url().await.ok().flatten()
}

/// A snapshot read from the panel's NATIVE webview — the exact page the user
/// is looking at. The Tauri shell supplies the reader (it owns the webview);
/// the backend stays Tauri-agnostic and just calls the boxed closure.
#[derive(Clone)]
pub struct EmbeddedPage {
    pub url: String,
    pub title: String,
    pub text: String,
}
type EmbeddedReader =
    Box<dyn Fn() -> futures_util::future::BoxFuture<'static, Option<EmbeddedPage>> + Send + Sync>;
fn embedded_reader() -> &'static OnceLock<EmbeddedReader> {
    static R: OnceLock<EmbeddedReader> = OnceLock::new();
    &R
}
/// Register the shell-provided reader for the native panel webview.
pub fn set_embedded_reader(r: EmbeddedReader) {
    let _ = embedded_reader().set(r);
}
async fn read_embedded() -> Option<EmbeddedPage> {
    let r = embedded_reader().get()?;
    let p = r().await?;
    if p.text.trim().is_empty() {
        return None;
    }
    Some(p)
}

/// Navigate the panel's NATIVE webview (the shell drives it; returns the loaded
/// URL + title). Lets the agent browse like the user — a real browser engine,
/// so it reaches pages a headless Chromium gets WAF-blocked on.
type EmbeddedNavigator = Box<
    dyn Fn(String) -> futures_util::future::BoxFuture<'static, Option<(String, String)>>
        + Send
        + Sync,
>;
fn embedded_navigator() -> &'static OnceLock<EmbeddedNavigator> {
    static N: OnceLock<EmbeddedNavigator> = OnceLock::new();
    &N
}
pub fn set_embedded_navigator(n: EmbeddedNavigator) {
    let _ = embedded_navigator().set(n);
}
async fn navigate_embedded(url: &str) -> Option<(String, String)> {
    let n = embedded_navigator().get()?;
    n(url.to_string()).await
}

/// Last frame seen — sent to a panel the moment it connects so it shows the
/// current page immediately instead of waiting for the next paint.
fn last_frame() -> &'static Mutex<Option<Arc<Vec<u8>>>> {
    static LF: OnceLock<Mutex<Option<Arc<Vec<u8>>>>> = OnceLock::new();
    LF.get_or_init(|| Mutex::new(None))
}

/// Snapshot of the most recent frame, if any.
pub async fn last_frame_snapshot() -> Option<Arc<Vec<u8>>> {
    last_frame().lock().await.clone()
}

/// Match the page's render size to the panel's on-screen size (CSS px) at
/// the display's pixel ratio. This makes the frame FILL the panel (no
/// letterbox) and capture at retina resolution (sharp, not the blurry
/// downscale of a fixed 1280×800). Mouse coords from the panel are then in
/// this same CSS space, so they map 1:1.
pub async fn set_viewport(width: u32, height: u32, dpr: f64) -> Result<()> {
    if width < 2 || height < 2 {
        return Ok(());
    }
    ensure().await?;
    let g = state().lock().await;
    if let Some(inner) = g.as_ref() {
        use chromiumoxide::cdp::browser_protocol::emulation::SetDeviceMetricsOverrideParams;
        if let Ok(p) = SetDeviceMetricsOverrideParams::builder()
            .width(width as i64)
            .height(height as i64)
            .device_scale_factor(dpr.clamp(1.0, 3.0))
            .mobile(false)
            .build()
        {
            let _ = inner.page.execute(p).await;
        }
    }
    Ok(())
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

    // Present as dark + non-automated: emulate prefers-color-scheme:dark so
    // sites with a dark theme (Google, GitHub, …) render dark like Cursor's
    // browser, and scrub the residual `navigator.webdriver` flag on every
    // document. Both are best-effort — a failure here just means a lighter /
    // slightly more bot-detectable page, never a broken browser.
    {
        use chromiumoxide::cdp::browser_protocol::emulation::{
            MediaFeature, SetEmulatedMediaParams,
        };
        use chromiumoxide::cdp::browser_protocol::network::SetUserAgentOverrideParams;
        use chromiumoxide::cdp::browser_protocol::page::AddScriptToEvaluateOnNewDocumentParams;
        let _ = page
            .execute(
                SetEmulatedMediaParams::builder()
                    .features(vec![MediaFeature {
                        name: "prefers-color-scheme".to_string(),
                        value: "dark".to_string(),
                    }])
                    .build(),
            )
            .await;
        if let Ok(p) = AddScriptToEvaluateOnNewDocumentParams::builder()
            .source("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
            .build()
        {
            let _ = page.execute(p).await;
        }
        // Override the "HeadlessChrome" UA with the matching desktop-Chrome
        // string so bot-detecting sites serve the full page instead of a
        // stripped one (see CHROME_UA). Best-effort, like the emulation above.
        if let Ok(ua) = SetUserAgentOverrideParams::builder()
            .user_agent(CHROME_UA.to_string())
            .build()
        {
            let _ = page.execute(ua).await;
        }
    }

    // Sharp retina frames: screenshot the page at its panel-matched device
    // surface (× dpr). A CDP screencast only streams CSS-px frames, which the
    // retina panel then upscales × dpr → blurry; a screenshot captures the
    // full device-pixel surface → crisp, and fills the panel (the device
    // metrics already match the panel aspect). ~20 fps keeps scroll/typing
    // reasonably smooth; idle ticks (no panel watching) are skipped.
    let fpage = page.clone();
    let frames = tokio::spawn(async move {
        loop {
            tokio::time::sleep(FRAME_INTERVAL).await;
            if frame_tx().receiver_count() == 0 {
                continue;
            }
            // The first capture after launch can hang until the first paint;
            // the timeout keeps the loop alive instead of wedging forever.
            let shot = tokio::time::timeout(
                Duration::from_secs(3),
                fpage.screenshot(
                    ScreenshotParams::builder()
                        .format(CaptureScreenshotFormat::Jpeg)
                        .quality(88)
                        .capture_beyond_viewport(false)
                        .build(),
                ),
            )
            .await;
            if let Ok(Ok(bytes)) = shot {
                let b = Arc::new(bytes);
                *last_frame().lock().await = Some(b.clone());
                let _ = frame_tx().send(b);
            }
        }
    });

    // URL poller — broadcasts whenever the page's URL changes (agent
    // navigate / link click / redirect) so the panel can mirror it. Skips the
    // CDP round-trip when nothing is subscribed to URL changes (idle panel),
    // mirroring the frames loop's receiver-count gate.
    let upage = page.clone();
    let urls = tokio::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if url_tx().receiver_count() == 0 {
                continue;
            }
            if let Ok(Some(mut u)) = upage.url().await {
                // Defensive: never broadcast a panel-internal sentinel fragment.
                if let Some(i) = u.find("#__fleet") {
                    u.truncate(i);
                }
                if !u.is_empty() && u != "about:blank" && u != last {
                    last = u.clone();
                    let _ = url_tx().send(u);
                }
            }
        }
    });

    *g = Some(Inner {
        browser,
        page,
        handler,
        frames,
        urls,
    });
    touch_activity();
    drop(g); // release the state lock before spawning the watchdog

    // Idle-shutdown watchdog. Reclaims Chrome's ~300-600 MB once the panel is
    // closed AND no agent has driven the page for IDLE_SHUTDOWN. It holds the
    // state lock across teardown so a concurrent `ensure()` can't launch a
    // second Chrome into the shared per-PID profile dir mid-close. Exactly one
    // runs at a time: `ensure()` only builds `Inner` (and this task) when state
    // was None, and the task returns after tearing down — the next `page()`
    // re-launches lazily.
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_CHECK).await;
            if frame_tx().receiver_count() > 0
                || url_tx().receiver_count() > 0
                || idle_for() < IDLE_SHUTDOWN
            {
                continue;
            }
            let mut g = state().lock().await;
            // Re-check under the lock: a panel may have attached or an op may
            // have touched the browser between waking and acquiring the lock.
            if frame_tx().receiver_count() > 0
                || url_tx().receiver_count() > 0
                || idle_for() < IDLE_SHUTDOWN
            {
                continue;
            }
            if let Some(inner) = g.take() {
                // Stop the pollers first (they reference the page), then close
                // gracefully — bounded by a timeout so an unresponsive Chrome
                // can't wedge the watchdog (and every later op) holding the lock.
                inner.frames.abort();
                inner.urls.abort();
                let mut browser = inner.browser;
                let _ = tokio::time::timeout(Duration::from_secs(5), browser.close()).await;
                inner.handler.abort();
                drop(browser); // chromiumoxide's Drop kills the child if close() timed out
                tracing::info!(
                    target: "browser",
                    "idle {IDLE_SHUTDOWN:?} with no watchers — closed headless Chromium to reclaim memory"
                );
            }
            return;
        }
    });
    Ok(())
}

/// Clone the live page handle (lazy-launching the browser first).
async fn page() -> Result<Page> {
    ensure().await?;
    touch_activity();
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
    // Prefer the panel's native webview (real engine ⇒ reaches WAF-protected
    // pages a headless Chromium is blocked on). Falls back to CDP when no
    // panel page is open.
    if let Some((u, t)) = navigate_embedded(url).await {
        tracing::info!(target: "browser", "navigated (panel): {u}");
        return Ok(json!({ "url": u, "title": t, "source": "panel" }));
    }
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
    // Prefer the page the USER actually has open in the panel (native
    // webview). It's a real browser engine, so it has whatever the user
    // loaded — including pages a headless Chromium would be WAF-blocked on.
    // Falls through to the CDP page when no panel page is open.
    if format != "html" {
        if let Some(ep) = read_embedded().await {
            let raw = ep.text;
            let content: String = raw.chars().take(40_000).collect();
            let truncated = content.len() < raw.len();
            return Ok(json!({
                "format": "text",
                "content": content,
                "truncated": truncated,
                "url": ep.url,
                "title": ep.title,
                "source": "panel",
            }));
        }
    }
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
    Ok(json!({ "format": format, "content": content, "truncated": truncated, "source": "cdp" }))
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

/// Inspector hover: the element under (x, y) in CSS-viewport coords →
/// `{ selector, tag, rect }`. The panel draws a highlight box from `rect`.
pub async fn hover_at(x: f64, y: f64) -> Result<Value> {
    let p = page().await?;
    let js = format!("{}({x},{y})", INSPECT_FN);
    let v = p
        .evaluate(js)
        .await
        .map_err(|e| anyhow!("hover: {e}"))?
        .into_value::<Value>()
        .unwrap_or(Value::Null);
    Ok(v)
}

/// Inspector pick: like `hover_at` but returns the full rich payload — same
/// shape as `inspect_selector`, resolved by point instead of selector.
pub async fn pick_at(x: f64, y: f64) -> Result<Value> {
    let p = page().await?;
    let js = format!("{ELEMENT_INFO_JS}(document.elementFromPoint({x},{y}))");
    let v = p
        .evaluate(js)
        .await
        .map_err(|e| anyhow!("pick: {e}"))?
        .into_value::<Value>()
        .unwrap_or(Value::Null);
    Ok(v)
}

/// Agent-facing `inspect` tool: rich element info for the first match of a
/// CSS selector on the shared page. Errors when nothing matches so the agent
/// gets a real signal instead of a silent null.
pub async fn inspect_selector(selector: &str) -> Result<Value> {
    let p = page().await?;
    let sel = serde_json::to_string(selector).map_err(|e| anyhow!("selector: {e}"))?;
    let js = format!("{ELEMENT_INFO_JS}(document.querySelector({sel}))");
    let v = p
        .evaluate(js)
        .await
        .map_err(|e| anyhow!("inspect: {e}"))?
        .into_value::<Value>()
        .unwrap_or(Value::Null);
    if v.is_null() {
        return Err(anyhow!("no element matches selector: {selector}"));
    }
    Ok(v)
}

/// In-page helper for hover only: resolve the element at a point to a
/// stable-ish CSS selector + bounding rect. Deliberately light — it runs on
/// every mousemove; picks and the agent's `inspect` use `ELEMENT_INFO_JS`.
const INSPECT_FN: &str = r#"(function(x,y){
  var el=document.elementFromPoint(x,y);
  if(!el)return null;
  function sel(e){
    if(e.id)return e.tagName.toLowerCase()+'#'+e.id;
    var c='';
    if(e.classList&&e.classList.length)c='.'+Array.prototype.slice.call(e.classList,0,2).join('.');
    var t=e.tagName.toLowerCase()+c;
    if(e.parentElement&&document.querySelectorAll(t).length>1){
      var sibs=Array.prototype.filter.call(e.parentElement.children,function(s){return s.tagName===e.tagName;});
      if(sibs.length>1)t+=':nth-of-type('+(sibs.indexOf(e)+1)+')';
    }
    return t;
  }
  var r=el.getBoundingClientRect();
  return {selector:sel(el),tag:el.tagName.toLowerCase(),rect:{x:r.left,y:r.top,w:r.width,h:r.height}};
})"#;

/// Rich element info, given an Element: selector path, xpath, rect, key
/// attributes, curated computed styles, and React/Vue component + dev source
/// when detectable. The payload shape matches what the embedded Browser
/// pane's picker captures — keep in lockstep with `SELECT_JS` in
/// `src-tauri/src/shell/ipc/mod.rs`.
const ELEMENT_INFO_JS: &str = r#"(function (el) {
  if (!el || el.nodeType !== 1) return null;
  function cssPath(e) {
    if (!e) return '';
    if (e.id) return '#' + e.id;
    var parts = [];
    while (e && e.nodeType === 1 && parts.length < 5) {
      var sel = e.nodeName.toLowerCase();
      if (e.className && typeof e.className === 'string') {
        var c = e.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (c) sel += '.' + c;
      }
      var p = e.parentNode;
      if (p && p.children) {
        var sibs = Array.prototype.filter.call(p.children, function (s) { return s.nodeName === e.nodeName; });
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(e) + 1) + ')';
      }
      parts.unshift(sel);
      e = p;
    }
    return parts.join(' > ');
  }
  function xPath(e) {
    if (!e || e.nodeType !== 1) return '';
    var parts = [], anchored = false;
    while (e && e.nodeType === 1) {
      if (e.id) { parts.unshift('*[@id="' + e.id + '"]'); anchored = true; break; }
      var idx = 1, sib = e.previousElementSibling;
      while (sib) { if (sib.nodeName === e.nodeName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(e.nodeName.toLowerCase() + '[' + idx + ']');
      e = e.parentElement;
    }
    return (anchored ? '//' : '/') + parts.join('/');
  }
  function attrInfo(e) {
    try {
      var out = {}, keep = ['id', 'class', 'data-testid', 'aria-label', 'role', 'name', 'type', 'placeholder', 'href', 'src', 'alt', 'title', 'for'];
      for (var i = 0; i < keep.length; i++) {
        var v = e.getAttribute && e.getAttribute(keep[i]);
        if (v) out[keep[i]] = String(v).slice(0, 200);
      }
      if (e.tagName === 'INPUT' && e.type !== 'password' && e.value) out.value = String(e.value).slice(0, 120);
      return out;
    } catch (_) { return null; }
  }
  function styleInfo(e) {
    try {
      var cs = getComputedStyle(e), out = {};
      var keys = ['display', 'position', 'width', 'height', 'padding', 'margin', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'text-align', 'border', 'border-radius', 'gap', 'flex-direction', 'justify-content', 'align-items', 'opacity', 'overflow', 'z-index'];
      for (var i = 0; i < keys.length; i++) {
        var v = cs.getPropertyValue(keys[i]);
        if (!v || v === 'auto' || v === 'normal' || v === 'none' || v === 'visible' || v === 'static' || v === 'stretch' || v === '1' || v === '0px' || v === 'rgba(0, 0, 0, 0)' || v.indexOf('0px none') === 0 || v.indexOf('0px 0px') === 0) continue;
        out[keys[i]] = v;
      }
      return out;
    } catch (_) { return null; }
  }
  function frameworkInfo(e) {
    try {
      var node = e, key = null, hop = 0, k;
      while (node && hop < 4 && !key) {
        for (k in node) { if (k.indexOf('__reactFiber$') === 0) { key = k; break; } }
        if (!key) { node = node.parentElement; hop++; }
      }
      if (key) {
        var f = node[key], names = [], src = null, guard = 0, t, n, s, fn, i2;
        while (f && guard < 60) {
          t = f.type; n = null;
          if (typeof t === 'function') n = t.displayName || t.name || null;
          else if (t && typeof t === 'object') n = t.displayName || (t.render && (t.render.displayName || t.render.name)) || null;
          if (n && n !== 'Fragment' && names.indexOf(n) < 0 && names.length < 6) names.push(n);
          if (!src && f._debugSource) {
            s = f._debugSource; fn = String(s.fileName || '').replace(/\\/g, '/');
            i2 = fn.indexOf('/src/');
            if (i2 >= 0) fn = fn.slice(i2 + 1);
            src = fn + (s.lineNumber ? ':' + s.lineNumber : '');
          }
          f = f.return; guard++;
        }
        if (names.length || src) return { component: names[0] || null, tree: names, source: src };
      }
      var v = e.__vueParentComponent || (e.parentElement && e.parentElement.__vueParentComponent);
      if (v) {
        var vn = [], c = v, g = 0, ty, n2, vsrc = null;
        while (c && g < 10) {
          ty = c.type || {}; n2 = ty.name || ty.__name || null;
          if (n2 && vn.indexOf(n2) < 0 && vn.length < 6) vn.push(n2);
          if (!vsrc && ty.__file) vsrc = ty.__file;
          c = c.parent; g++;
        }
        if (vn.length || vsrc) return { component: vn[0] || null, tree: vn, source: vsrc };
      }
    } catch (_) {}
    return null;
  }
  var r = el.getBoundingClientRect();
  var info = {
    selector: cssPath(el),
    xpath: xPath(el),
    tag: el.nodeName.toLowerCase(),
    text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
    url: location.href,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    html: String(el.outerHTML || '').slice(0, 1500)
  };
  var a = attrInfo(el); if (a && Object.keys(a).length) info.attrs = a;
  var st = styleInfo(el); if (st && Object.keys(st).length) info.styles = st;
  var fw = frameworkInfo(el);
  if (fw) {
    if (fw.component) info.component = fw.component;
    if (fw.tree && fw.tree.length) info.componentTree = fw.tree;
    if (fw.source) info.source = fw.source;
  }
  return info;
})"#;

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
        "inspect" => inspect_selector(s("selector")).await,
        "back" => back().await,
        "forward" => forward().await,
        "reload" => reload().await,
        "eval" => eval(s("script")).await,
        "screenshot" => Ok(json!({ "format": "png", "image_base64": screenshot_b64().await? })),
        other => Err(anyhow!("unknown action: {other}")),
    }
}
