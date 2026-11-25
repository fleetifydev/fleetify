/**
 * BrowserView — the embedded native browser pane.
 *
 * Moved verbatim out of workspace-panel.tsx, which held every workspace view
 * in one 6,700-line file. This commit is a pure move: no behaviour change, so
 * the feature diff that follows is readable on its own.
 */

import { useState, useEffect, useRef, useCallback, useContext } from "react";
import {
  ArrowLeft, ArrowRight, ChevronDown, Copy, ExternalLink, Globe, List, MoreHorizontal,
  Maximize2, Minimize2, RefreshCw, Search, SquareMousePointer, Star,
  Terminal as TerminalIcon, Trash2, X,
} from "lucide-react";
import { PaneCloseContext } from "@/components/workspace/pane-close-context";
import { SANS } from "@/components/workspace/typography";
import { useIsInPane, usePaneSessionId } from "@/components/chat/pane-session-context";
import { claimEscape } from "@/hooks/use-escape-to-stop";
import {
  SELECT_MODES, copyTextSafe, parsePickPayload, parseSelectMode, pickToRefDetail,
  selectModeLabel, selectModeMenuLabel, type SelectMode,
} from "@/lib/element-ref";
import { withApiTokenQuery } from "@/lib/api-token";
import { useAppStore } from "@/stores/app-store";

/* ── Browser pane ──
   Address bar + a slot that hosts a REAL native child webview overlaid
   INSIDE this panel (same window — no separate OS window). A non-headless
   engine ⇒ sharp on retina, fast, and no bot captcha. We report the slot's
   logical rect to the shell, which positions the native webview there and we
   keep it glued on resize/layout changes. Known cost: dragging the whole app
   window repaints the child webview a beat late — inherent to native child
   webviews on macOS, the price of an embedded real browser. */
type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const inv = (window as unknown as { __TAURI__?: { core?: { invoke?: TauriInvoke } } }).__TAURI__?.core?.invoke;
  return inv ? inv(cmd, args) : Promise.reject(new Error("Tauri invoke unavailable"));
}

type HistEntry = { url: string; title: string; ts: number };
function faviconFor(url: string): string {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).host}&sz=64`; } catch { return ""; }
}
function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  if (/\s/.test(t)) return false;
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true;
  return /^[^\s./]+\.[^\s]{2,}/.test(t); // host.tld[/...]
}
function resolveTarget(raw: string): string {
  const t = raw.trim();
  if (looksLikeUrl(t)) {
    if (/^https?:\/\//i.test(t)) return t;
    // Loopback hosts get http: dev servers speak plain http, and a https://
    // guess just buys a TLS error before the user retypes the scheme.
    const loopback = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(t);
    return (loopback ? "http://" : "https://") + t;
  }
  return "https://www.google.com/search?q=" + encodeURIComponent(t);
}
function hostOf(url: string): string { try { return new URL(url).host; } catch { return url; } }

function BrowserView() {
  const requestClose = useContext(PaneCloseContext);
  const [editUrl, setEditUrl] = useState("");
  const [active, setActive] = useState(false);
  const [selecting, setSelecting] = useState(false);
  // Sticky Select behaviour: ask opens the in-page box, the copy modes put
  // the chosen representation straight on the clipboard per click.
  const [selectMode, setSelectMode] = useState<SelectMode>(() => {
    try { return parseSelectMode(localStorage.getItem("fleet:browser-select-mode")); } catch { return "ask"; }
  });
  const [modeOpen, setModeOpen] = useState(false);
  // Mirrors for the once-registered Tauri event listeners below — the content
  // script re-injects FRESH (unarmed) on every navigation, so the url
  // listener must know the current pill state to re-arm each new page.
  const selectingRef = useRef(false);
  useEffect(() => { selectingRef.current = selecting; }, [selecting]);
  const selectModeRef = useRef<SelectMode>("ask");
  useEffect(() => { selectModeRef.current = selectMode; }, [selectMode]);
  // The session whose composer takes this view's element picks. In a split
  // pane that is the pane's own, so a pick lands in the pane that armed
  // Select even while another pane is focused. Outside a pane it is none,
  // and the single view's one composer takes the pick. A mirror for the
  // once-registered pick listener below.
  const inPane = useIsInPane();
  const paneSessionId = usePaneSessionId();
  const pickSessionRef = useRef<string | null>(null);
  useEffect(() => { pickSessionRef.current = inPane ? paneSessionId : null; }, [inPane, paneSessionId]);
  const fullscreen = useAppStore((s) => s.rightPanelFullscreen);
  const setRightPanelFullscreen = useAppStore((s) => s.setRightPanelFullscreen);
  const [urlFocused, setUrlFocused] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<HistEntry[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const [histQuery, setHistQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("fleet:browser-bookmarks") || "[]") as string[]; } catch { return []; }
  });
  const [showBookmarkBar, setShowBookmarkBar] = useState<boolean>(() => {
    try { return localStorage.getItem("fleet:browser-bookmark-bar") === "1"; } catch { return false; }
  });
  const slotRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(false);
  const lastRect = useRef("");
  // The native webview renders ABOVE the DOM, so it would occlude our
  // toolbar popovers. While one is open we tuck the webview away.
  const popoverOpenRef = useRef(false);
  // URL mirroring with the agent's backend CDP browser.
  const mirrorWsRef = useRef<WebSocket | null>(null);
  const lastMirror = useRef("");

  const measure = useCallback(() => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  }, []);

  // Keep the native webview glued to the slot rect; only push when it moved.
  const syncBounds = useCallback(() => {
    if (!activeRef.current) return;
    if (popoverOpenRef.current) {
      // Tuck the native webview to a 1px corner so the DOM popover shows.
      if (lastRect.current !== "hidden") {
        lastRect.current = "hidden";
        void tauriInvoke("browser_embed_set_bounds", { x: 0, y: 0, width: 1, height: 1 });
      }
      return;
    }
    const b = measure();
    if (!b) return;
    const key = `${b.x},${b.y},${b.width},${b.height}`;
    if (key === lastRect.current) return;
    lastRect.current = key;
    void tauriInvoke("browser_embed_set_bounds", b);
  }, [measure]);

  // Create the embedded webview if needed, else navigate the existing one.
  const openOrNavigate = useCallback((url: string) => {
    if (activeRef.current) {
      void tauriInvoke("browser_embed_navigate", { url });
      return;
    }
    const b = measure() ?? { x: 0, y: 0, width: 800, height: 600 };
    lastRect.current = `${b.x},${b.y},${b.width},${b.height}`;
    void tauriInvoke("browser_embed_create", { url, ...b })
      .then((res) => {
        const ok = (res as { ok?: boolean } | undefined)?.ok;
        if (ok === false) { setErr((res as { error?: string }).error ?? "open failed"); return; }
        setErr(null); setActive(true); activeRef.current = true;
      })
      .catch((e) => setErr(String(e)));
  }, [measure]);

  const go = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const target = resolveTarget(trimmed);
    setEditUrl(target);
    setTyping(false);
    setHistOpen(false);
    openOrNavigate(target);
  }, [openOrNavigate]);

  // Track layout while open; tear the native webview down on unmount.
  useEffect(() => {
    let raf = 0;
    const tick = () => { syncBounds(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const onResize = () => syncBounds();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      activeRef.current = false;
      void tauriInvoke("browser_embed_close");
    };
  }, [syncBounds]);

  // Mirror the embedded page's current URL into the address bar.
  useEffect(() => {
    const listen = (window as unknown as { __TAURI__?: { event?: { listen?: (n: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } } }).__TAURI__?.event?.listen;
    if (!listen) return;
    let un: (() => void) | undefined;
    void listen("browser-embed:url", (e) => {
      if (typeof e.payload !== "string") return;
      const u = e.payload;
      setEditUrl(u);
      setHistory((h) => {
        const prev = h.find((en) => en.url === u);
        const rest = h.filter((en) => en.url !== u);
        return [...rest, { url: u, title: prev?.title || hostOf(u), ts: Date.now() }].slice(-200);
      });
      // Panel → agent CDP: keep the agent's browser on the page the user views.
      if (u && u !== lastMirror.current) {
        lastMirror.current = u;
        const ws = mirrorWsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "navigate", url: u }));
      }
      // Each navigation injects a FRESH, unarmed content script — while the
      // Select pill is on, re-arm every new page so the pill and the page
      // can never disagree (the old behaviour: pill lit, picker dead).
      if (selectingRef.current) {
        void tauriInvoke("browser_embed_set_select", { on: true, mode: selectModeRef.current });
      }
    }).then((f) => { un = f; });
    return () => { un?.(); };
  }, []);

  // Agent CDP → panel: mirror the backend browser's URL into the native webview.
  // The URL carries the API token, which takes an await: `closed` keeps a
  // socket from opening once the effect is cleaned up.
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    void withApiTokenQuery(`${proto}//${location.host}/ws/browser-url`).then((url) => {
      if (closed) return;
      try {
        const socket = new WebSocket(url);
        ws = socket;
        mirrorWsRef.current = socket;
        socket.onmessage = (ev) => {
          try {
            const m = JSON.parse(typeof ev.data === "string" ? ev.data : "") as { type?: string; url?: string };
            if (m.type === "url" && typeof m.url === "string" && m.url && m.url !== lastMirror.current) {
              lastMirror.current = m.url;
              setEditUrl(m.url);
              openOrNavigate(m.url);
            }
          } catch { /* ignore */ }
        };
        socket.onclose = () => { if (mirrorWsRef.current === socket) mirrorWsRef.current = null; };
      } catch { /* no mirroring */ }
    });
    return () => {
      closed = true;
      ws?.close();
      if (mirrorWsRef.current === ws) mirrorWsRef.current = null;
    };
  }, [openOrNavigate]);

  // Page titles arrive separately (content script → meta channel) — fold them
  // into the matching history entry.
  useEffect(() => {
    const listen = (window as unknown as { __TAURI__?: { event?: { listen?: (n: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } } }).__TAURI__?.event?.listen;
    if (!listen) return;
    let un: (() => void) | undefined;
    void listen("browser-embed:meta", (e) => {
      if (typeof e.payload !== "string") return;
      try {
        const m = JSON.parse(decodeURIComponent(e.payload)) as { title?: string; url?: string };
        if (!m.url || !m.title) return;
        setHistory((h) => h.map((en) => (en.url === m.url ? { ...en, title: m.title as string } : en)));
      } catch { /* ignore */ }
    }).then((f) => { un = f; });
    return () => { un?.(); };
  }, []);

  // Bookmarks (persisted) + the overflow / history popovers.
  const isBookmarked = bookmarks.includes(editUrl);
  const toggleBookmark = useCallback(() => {
    if (!editUrl) return;
    setBookmarks((prev) => {
      const next = prev.includes(editUrl) ? prev.filter((u) => u !== editUrl) : [editUrl, ...prev].slice(0, 50);
      try { localStorage.setItem("fleet:browser-bookmarks", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [editUrl]);

  // Responsive toolbar — collapse low-priority controls when the pane is narrow.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barW, setBarW] = useState(9999);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setBarW(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = barW < 440;   // drop the "Select" label + devtools
  const ultra = barW < 330;     // also drop history + bookmark star

  // Suggestions show while the user is actively typing a query/URL.
  const showSuggest = urlFocused && typing && editUrl.trim().length > 0;

  // Keep the webview-hide flag in sync with any open overlay (popover or
  // suggestions) — the native webview renders above the DOM.
  useEffect(() => { popoverOpenRef.current = histOpen || menuOpen || modeOpen || showSuggest; }, [histOpen, menuOpen, modeOpen, showSuggest]);

  // Close the popovers on an outside click / Escape. The Escape listener is
  // on `document`, which runs before every `window` listener, and claims the
  // key: closing a popover must not also stop the chat's stream.
  useEffect(() => {
    if (!histOpen && !menuOpen && !modeOpen) return;
    const close = () => { setHistOpen(false); setMenuOpen(false); setModeOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      claimEscape(e);
      close();
    };
    window.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey); };
  }, [histOpen, menuOpen, modeOpen]);

  // Escape leaves full screen. Registered only while full screen is on. Like
  // the popovers above, it claims the key from `document`.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { claimEscape(e); setRightPanelFullscreen(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen, setRightPanelFullscreen]);

  // Leaving the pane must not strand the layout in full screen with no way
  // back — the button that exits it lives in this toolbar.
  useEffect(() => () => { useAppStore.getState().setRightPanelFullscreen(false); }, []);

  // Toggle the in-page element picker (content script highlights + posts back).
  const toggleSelect = useCallback(() => {
    if (!activeRef.current) return;
    setSelecting((prev) => {
      const next = !prev;
      void tauriInvoke("browser_embed_set_select", { on: next, mode: selectMode });
      return next;
    });
  }, [selectMode]);

  // Pick a sticky mode from the ▾ popover; live-switch when already armed.
  const applyMode = useCallback((m: SelectMode) => {
    setSelectMode(m);
    try { localStorage.setItem("fleet:browser-select-mode", m); } catch { /* ignore */ }
    setModeOpen(false);
    if (activeRef.current && selecting) void tauriInvoke("browser_embed_set_select", { on: true, mode: m });
  }, [selecting]);

  // Messages from the in-page element box arrive as URL-encoded JSON. Three
  // kinds: copy (LAST-RESORT clipboard write — the page copies in its own
  // document first, where focus and the user gesture live; this document is
  // usually unfocused at that moment, so the write may legitimately miss and
  // must never surface an unhandled rejection), dismiss (Esc/× in the box —
  // un-arm the Select pill), and a real pick → composer.
  useEffect(() => {
    const listen = (window as unknown as { __TAURI__?: { event?: { listen?: (n: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } } }).__TAURI__?.event?.listen;
    if (!listen) return;
    let un: (() => void) | undefined;
    void listen("browser-embed:pick", (e) => {
      if (typeof e.payload !== "string") return;
      const msg = parsePickPayload(e.payload);
      if (!msg) return;
      if (msg.action === "copy") {
        // The box stays open in-page, so Select stays armed-looking there;
        // don't flip our pill either.
        if (msg.value) void copyTextSafe(msg.value);
        return;
      }
      if (msg.action === "error") {
        // The content script caught a page-specific throw — surface it so a
        // dead-feeling click is diagnosable from the renderer log.
        console.error("[browser-select] in-page picker error:", msg.message || "unknown");
        return;
      }
      // Tauri hands every pick to every mounted browser view. Only the view
      // whose Select is armed made it. Another view can be mounted out of
      // sight: the global right panel stays mounted at zero width when
      // closed. The page can only send a pick while armed, because turning
      // Select off closes its box.
      if (!selectingRef.current) return;
      setSelecting(false);
      if (msg.action === "dismiss") return;
      const detail = pickToRefDetail(msg);
      if (!detail) return;
      window.dispatchEvent(new CustomEvent("fleet:add-element-ref", {
        detail: {
          ...detail,
          // Typed into the in-page composer that opens at the picked
          // element. Empty when the user sent without writing anything.
          prompt: msg.prompt || "",
          // The box's Send dispatches the agent turn immediately; Add stages.
          autosend: !!msg.submit,
          // In a split pane, this pane's composer takes it (pickSessionRef).
          sessionId: pickSessionRef.current,
        },
      }));
    }).then((f) => { un = f; });
    return () => { un?.(); };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Toolbar — flat, panel-coloured, borderless two-tone URL (Cursor-style).
          The whole bar is a drag handle; the URL field opts out so text
          selection still works. */}
      <div
        ref={barRef}
        data-pane-handle="true"
        style={{
          height: 40, flexShrink: 0, display: "flex", alignItems: "center",
          padding: "0 6px", gap: 1, cursor: "grab", position: "relative",
          background: "var(--sidebar)", borderBottom: "1px solid var(--sidebar-border)",
        }}
      >
        {/* History / reading-list popover toggle */}
        {!ultra && <BrowserNavBtn title="History & bookmarks" active={histOpen} onClick={() => { setHistOpen((v) => !v); setMenuOpen(false); }}><List size={14} /></BrowserNavBtn>}
        <BrowserNavBtn title="Back" disabled={!active} onClick={() => void tauriInvoke("browser_embed_nav", { action: "back" })}><ArrowLeft size={14} /></BrowserNavBtn>
        <BrowserNavBtn title="Forward" disabled={!active} onClick={() => void tauriInvoke("browser_embed_nav", { action: "forward" })}><ArrowRight size={14} /></BrowserNavBtn>
        <BrowserNavBtn title="Reload" onClick={() => { if (activeRef.current) void tauriInvoke("browser_embed_nav", { action: "reload" }); else go(editUrl); }}><RefreshCw size={13} /></BrowserNavBtn>
        {!ultra && (
          <BrowserNavBtn title={isBookmarked ? "Remove bookmark" : "Bookmark"} disabled={!editUrl} active={isBookmarked} onClick={toggleBookmark}>
            <Star size={13} fill={isBookmarked ? "currentColor" : "none"} />
          </BrowserNavBtn>
        )}

        {/* URL — borderless, same colour as the bar; two-tone (host bright,
            scheme/path dim) until focused. Placeholder is a clear grey so the
            field reads as an address bar without any box. */}
        <div style={{ flex: 1, minWidth: 0, position: "relative", height: 28, display: "flex", alignItems: "center", margin: "0 4px" }}>
          {!urlFocused && !!editUrl && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", padding: "0 8px", fontFamily: "var(--font-mono)", fontSize: 12.5, pointerEvents: "none", overflow: "hidden", whiteSpace: "nowrap" }}>
              <UrlText url={editUrl} />
            </div>
          )}
          <input
            className="browser-url-input"
            value={editUrl}
            onChange={(e) => { setEditUrl(e.target.value); setTyping(true); }}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => { setUrlFocused(true); setTyping(false); e.target.select(); }}
            onBlur={() => { setUrlFocused(false); setTyping(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); go(editUrl); }
              else if (e.key === "Escape") { setTyping(false); (e.target as HTMLInputElement).blur(); }
            }}
            placeholder="Search or enter URL"
            spellCheck={false}
            style={{
              width: "100%", height: 28, padding: "0 8px",
              background: "transparent", border: "none", outline: "none",
              color: urlFocused ? "#e6e6e6" : "transparent", caretColor: "#e6e6e6",
              fontFamily: "var(--font-mono)", fontSize: 12.5,
            }}
          />
        </div>

        {/* Fullscreen — hands the whole window to the panel. A page is worth
            more room than a side panel gives it, and the picker in particular
            is much easier to aim at full width. */}
        <button
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          onClick={() => setRightPanelFullscreen(!fullscreen)}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          style={{
            height: 26, width: 26, borderRadius: 7, flexShrink: 0, marginRight: 2,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: fullscreen ? "rgba(76,141,255,0.18)" : "transparent",
            border: "none", outline: "none",
            color: fullscreen ? "#4c8dff" : "#9a9a9a", cursor: "pointer",
          }}
          onMouseEnter={(e) => { if (!fullscreen) e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
          onMouseLeave={(e) => { if (!fullscreen) e.currentTarget.style.background = "transparent"; }}
        >
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>

        {/* Element-select — right-side split pill (Cursor's "Design"). Body
            toggles picking with the sticky mode; the ▾ picks Ask vs Copy(…). */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 1, flexShrink: 0, marginRight: 2 }}>
          <button
            title={selecting
              ? "Cancel select"
              : selectMode === "ask"
                ? "Select an element → composer"
                : `Select: each click copies (${selectModeMenuLabel(selectMode)})`}
            disabled={!active}
            onClick={toggleSelect}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            style={{
              height: 26, padding: "0 7px 0 9px", borderRadius: "7px 0 0 7px",
              display: "inline-flex", alignItems: "center", gap: 5,
              background: selecting ? "rgba(76,141,255,0.18)" : "transparent",
              border: "none", outline: "none",
              color: !active ? "#4a4a4a" : selecting ? "#4c8dff" : "#9a9a9a",
              cursor: active ? "pointer" : "default",
              fontFamily: SANS, fontSize: 12.5, fontWeight: 500,
            }}
            onMouseEnter={(e) => { if (active && !selecting) e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
            onMouseLeave={(e) => { if (!selecting) e.currentTarget.style.background = "transparent"; }}
          >
            <SquareMousePointer size={13} />
            {!compact && <span>{selectModeLabel(selectMode, selecting)}</span>}
            {selecting && <X size={12} style={{ opacity: 0.8 }} />}
          </button>
          <button
            title="Select mode"
            disabled={!active}
            onClick={() => { setModeOpen((v) => !v); setHistOpen(false); setMenuOpen(false); }}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            style={{
              height: 26, width: 15, borderRadius: "0 7px 7px 0",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: selecting ? "rgba(76,141,255,0.18)" : modeOpen ? "rgba(255,255,255,0.07)" : "transparent",
              border: "none", outline: "none",
              color: !active ? "#4a4a4a" : selecting || modeOpen ? "#4c8dff" : "#9a9a9a",
              cursor: active ? "pointer" : "default",
            }}
            onMouseEnter={(e) => { if (active && !selecting && !modeOpen) e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
            onMouseLeave={(e) => { if (!selecting && !modeOpen) e.currentTarget.style.background = "transparent"; }}
          >
            <ChevronDown size={11} />
          </button>
        </div>
        {!compact && <BrowserNavBtn title="Developer tools" disabled={!active} onClick={() => void tauriInvoke("browser_embed_devtools")}><TerminalIcon size={13} /></BrowserNavBtn>}
        <BrowserNavBtn title="More" active={menuOpen} onClick={() => { setMenuOpen((v) => !v); setHistOpen(false); }}><MoreHorizontal size={14} /></BrowserNavBtn>

        {/* Address suggestions while typing (Search Google for… / history matches) */}
        {showSuggest && (() => {
          const q = editUrl.trim();
          const isUrl = looksLikeUrl(q);
          const ql = q.toLowerCase();
          const matches = history
            .filter((e) => e.url.toLowerCase().includes(ql) || e.title.toLowerCase().includes(ql))
            .slice(-6).reverse();
          return (
            <BrowserPopover left={150} right={150}>
              <BrowserPopItem onClick={() => go(q)}>
                {isUrl ? <Globe size={15} style={{ color: "#9a9a9a", flexShrink: 0 }} /> : <Search size={15} style={{ color: "#9a9a9a", flexShrink: 0 }} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {isUrl ? <>Go to <span style={{ color: "#4c8dff" }}>{q}</span></> : <>Search Google for <span style={{ color: "#4c8dff" }}>{q}</span></>}
                </span>
              </BrowserPopItem>
              {matches.map((e, i) => (
                <BrowserPopItem key={`sg-${i}-${e.url}`} onClick={() => go(e.url)}>
                  <img src={faviconFor(e.url)} width={15} height={15} style={{ borderRadius: 3, flexShrink: 0 }} alt="" />
                  <span style={POP_URL}>{e.title || hostOf(e.url)}</span>
                  <span style={{ ...POP_URL, color: "#5f5f5f", marginLeft: "auto", paddingLeft: 10 }}>{hostOf(e.url)}</span>
                </BrowserPopItem>
              ))}
            </BrowserPopover>
          );
        })()}

        {/* History + bookmarks popover (favicon · title · search · time-grouped) */}
        {histOpen && (() => {
          const q = histQuery.trim().toLowerCase();
          const all = [...history].reverse().filter((e) => !q || e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q));
          const now = Date.now();
          const recent = all.filter((e) => now - e.ts < 7 * 864e5);
          const older = all.filter((e) => now - e.ts >= 7 * 864e5);
          const row = (e: HistEntry, i: number) => (
            <BrowserPopItem key={`h-${i}-${e.url}`} onClick={() => { setHistOpen(false); go(e.url); }}>
              <img src={faviconFor(e.url)} width={16} height={16} style={{ borderRadius: 3, flexShrink: 0 }} alt="" />
              <span style={POP_URL}>{e.title || hostOf(e.url)}</span>
            </BrowserPopItem>
          );
          return (
            <BrowserPopover left={6}>
              <input
                value={histQuery}
                onChange={(ev) => setHistQuery(ev.target.value)}
                onMouseDown={(ev) => ev.stopPropagation()}
                placeholder="Search"
                spellCheck={false}
                style={{ width: "100%", height: 28, margin: "2px 0 6px", padding: "0 10px", background: "rgba(255,255,255,0.05)", border: "1px solid var(--sidebar-border)", borderRadius: 6, color: "#e6e6e6", outline: "none", fontFamily: SANS, fontSize: 12.5, boxSizing: "border-box" }}
              />
              {bookmarks.filter((u) => !q || u.toLowerCase().includes(q)).length > 0 && <div style={POP_HEADER}>Bookmarks</div>}
              {bookmarks.filter((u) => !q || u.toLowerCase().includes(q)).map((u, i) => (
                <BrowserPopItem key={`bm-${i}-${u}`} onClick={() => { setHistOpen(false); go(u); }}>
                  <Star size={13} fill="currentColor" style={{ color: "#e0b341", flexShrink: 0 }} />
                  <span style={POP_URL}>{u}</span>
                </BrowserPopItem>
              ))}
              {recent.length > 0 && <div style={POP_HEADER}>Last 7 days</div>}
              {recent.map(row)}
              {older.length > 0 && <div style={POP_HEADER}>Older</div>}
              {older.map(row)}
              {all.length === 0 && <div style={{ padding: "8px 10px", color: "#6a6a6a", fontFamily: SANS, fontSize: 12 }}>No history yet</div>}
            </BrowserPopover>
          );
        })()}

        {/* Overflow menu */}
        {menuOpen && (
          <BrowserPopover right={6}>
            <BrowserPopItem disabled={!active} onClick={() => { setMenuOpen(false); if (activeRef.current) void tauriInvoke("browser_embed_nav", { action: "reload" }); }}>
              <RefreshCw size={13} style={{ flexShrink: 0 }} /><span>Hard Reload</span>
            </BrowserPopItem>
            <BrowserPopItem disabled={!editUrl} onClick={() => { setMenuOpen(false); if (editUrl) void navigator.clipboard?.writeText(editUrl); }}>
              <Copy size={13} style={{ flexShrink: 0 }} /><span>Copy Current URL</span>
            </BrowserPopItem>
            <BrowserPopItem disabled={!editUrl} onClick={() => { setMenuOpen(false); if (editUrl) void tauriInvoke("shell_open_external", { url: editUrl }); }}>
              <ExternalLink size={13} style={{ flexShrink: 0 }} /><span>Open in System Browser</span>
            </BrowserPopItem>
            <div style={{ height: 1, background: "var(--sidebar-border)", margin: "4px 0" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", color: "#c8c8c8", fontFamily: SANS, fontSize: 12.5 }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <span style={{ flex: 1 }}>Show Bookmark Bar</span>
              <button
                onClick={() => setShowBookmarkBar((v) => { const nv = !v; try { localStorage.setItem("fleet:browser-bookmark-bar", nv ? "1" : "0"); } catch { /* ignore */ } return nv; })}
                style={{ width: 34, height: 18, borderRadius: 10, border: "none", cursor: "pointer", background: showBookmarkBar ? "#4c8dff" : "rgba(255,255,255,0.18)", position: "relative", transition: "background .12s", flexShrink: 0 }}
              >
                <span style={{ position: "absolute", top: 2, left: showBookmarkBar ? 18 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left .12s" }} />
              </button>
            </div>
            <div style={{ height: 1, background: "var(--sidebar-border)", margin: "4px 0" }} />
            <BrowserPopItem onClick={() => { setMenuOpen(false); setHistory([]); }}>
              <Trash2 size={13} style={{ flexShrink: 0 }} /><span>Clear Browsing History</span>
            </BrowserPopItem>
            <BrowserPopItem disabled={!active} onClick={() => { setMenuOpen(false); void tauriInvoke("browser_embed_clear_data"); }}>
              <Trash2 size={13} style={{ flexShrink: 0 }} /><span>Clear Cookies</span>
            </BrowserPopItem>
            <BrowserPopItem disabled={!active} onClick={() => { setMenuOpen(false); void tauriInvoke("browser_embed_clear_data"); }}>
              <Trash2 size={13} style={{ flexShrink: 0 }} /><span>Clear Cache</span>
            </BrowserPopItem>
            <div style={{ height: 1, background: "var(--sidebar-border)", margin: "4px 0" }} />
            <BrowserPopItem onClick={() => { setMenuOpen(false); requestClose?.("browser"); }}>
              <X size={13} style={{ flexShrink: 0 }} /><span>Close Browser</span>
            </BrowserPopItem>
          </BrowserPopover>
        )}

        {/* Select-mode popover (the pill's ▾) */}
        {modeOpen && (
          <BrowserPopover right={34}>
            {SELECT_MODES.map((m) => (
              <BrowserPopItem key={m} onClick={() => applyMode(m)}>
                <span style={{ width: 14, flexShrink: 0, color: "#4c8dff" }}>{m === selectMode ? "✓" : ""}</span>
                <span>{selectModeMenuLabel(m)}</span>
              </BrowserPopItem>
            ))}
          </BrowserPopover>
        )}
      </div>

      {/* Bookmark bar (toggle via overflow menu) */}
      {showBookmarkBar && (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 2, padding: "4px 8px", overflowX: "auto", background: "var(--sidebar)", borderBottom: "1px solid var(--sidebar-border)" }}>
          {bookmarks.length === 0
            ? <span style={{ color: "#6a6a6a", fontSize: 11.5, fontFamily: SANS, padding: "2px 4px" }}>No bookmarks yet — click the ☆ to add this page</span>
            : bookmarks.map((u, i) => (
              <button
                key={`bb-${i}-${u}`} title={u} onClick={() => go(u)} onMouseDown={(e) => e.stopPropagation()}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 5, border: "none", background: "transparent", color: "#b0b0b0", cursor: "pointer", fontFamily: SANS, fontSize: 11.5, whiteSpace: "nowrap", flexShrink: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <img src={faviconFor(u)} width={13} height={13} style={{ borderRadius: 2 }} alt="" />
                <span>{hostOf(u)}</span>
              </button>
            ))}
        </div>
      )}

      {/* The native child webview is overlaid on top of this slot by the shell. */}
      <div ref={slotRef} style={{ flex: 1, overflow: "hidden", background: "var(--card)", position: "relative" }}>
        {!active && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 12, alignItems: "center", justifyContent: "center", color: err ? "#f87171" : "#9a9a9a", fontSize: 12.5, fontFamily: SANS, textAlign: "center", padding: 24, lineHeight: 1.6 }}>
            <Globe size={26} strokeWidth={1.5} style={{ color: "#5a5a5a" }} />
            {err ? `Couldn't open the browser: ${err}` : "Type a URL above and press Enter — a real browser loads right here."}
          </div>
        )}
      </div>
    </div>
  );
}

/* Ghost icon button for the browser toolbar — flat, panel-coloured, with a
   blue tint when `active` (the element-select toggle). Stops mousedown so a
   click never arms the pane-drag handle on the bar behind it. */
function BrowserNavBtn({
  title, onClick, disabled, active, children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{
        width: 25, height: 25, borderRadius: 6, flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: active ? "rgba(76,141,255,0.18)" : "transparent",
        border: "none", outline: "none",
        color: disabled ? "#4a4a4a" : active ? "#4c8dff" : "#9a9a9a",
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => { if (!disabled && !active) { e.currentTarget.style.background = "rgba(255,255,255,0.07)"; e.currentTarget.style.color = "#e0e0e0"; } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = disabled ? "#4a4a4a" : "#9a9a9a"; } }}
    >
      {children}
    </button>
  );
}

/* Two-tone URL display (Cursor-style): scheme + path dimmed, host bright. */
function UrlText({ url }: { url: string }) {
  let scheme = "", rest = "";
  let host: string;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url);
    scheme = u.protocol + "//";
    host = u.host;
    rest = u.pathname + u.search + u.hash;
  } catch {
    host = url;
  }
  return (
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      <span style={{ color: "#5f5f5f" }}>{scheme}</span>
      <span style={{ color: "#e6e6e6" }}>{host}</span>
      <span style={{ color: "#5f5f5f" }}>{rest}</span>
    </span>
  );
}

/* Dropdown panel anchored under the browser toolbar (history / overflow). */
const POP_HEADER: React.CSSProperties = { padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6a6a6a", fontFamily: SANS };
const POP_URL: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11.5 };

function BrowserPopover({ left, right, children }: { left?: number; right?: number; children: React.ReactNode }) {
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute", top: 42, left, right, zIndex: 50,
        minWidth: 248, maxWidth: 440, maxHeight: 360, overflowY: "auto",
        background: "var(--sidebar)", border: "1px solid var(--sidebar-border)",
        borderRadius: 8, padding: 4, boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
      }}
    >
      {children}
    </div>
  );
}

function BrowserPopItem({ onClick, disabled, children }: { onClick?: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      disabled={disabled}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 8,
        padding: "6px 10px", borderRadius: 6, border: "none", background: "transparent",
        color: disabled ? "#5a5a5a" : "#c8c8c8", cursor: disabled ? "default" : "pointer",
        fontFamily: SANS, fontSize: 12.5, textAlign: "left",
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      {children}
    </button>
  );
}

// resolveTarget is exported for its unit tests only.
export { BrowserView, resolveTarget };
