/**
 * XtermShell — a single live shell rendered with @xterm/xterm and
 * driven through the Electron main-process node-pty bridge.
 *
 * Strict-mode safe: effects mount → clean up → mount again. Each run
 * builds a fresh Terminal + PTY and the cleanup tears both down. The
 * `disposed` flag inside the async PTY spawn handles the race where
 * a strict-mode cleanup arrives BEFORE ptySpawn resolves — when that
 * happens the freshly-spawned PTY is killed immediately.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { feedPtyChunk } from "@/stores/dev-server-store";

interface Props {
  cwd?: string;
  shell?: string;
}

export function XtermShell({ cwd, shell }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── 1. Build the xterm instance ──
    // Font + cursor tuned to Cursor's integrated terminal look:
    //  - 11px is the same density Cursor / VS Code default to on mac
    //  - 1.25 line-height keeps rows tight (matches reference image)
    //  - block cursor with blink, ~0.4px letter spacing reads sharp
    //    on retina without blurring glyph edges
    const term = new Terminal({
      fontFamily: '"SF Mono", "SFMono-Regular", ui-monospace, "Menlo", "Monaco", "Consolas", monospace',
      fontSize: 11,
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1.25,
      letterSpacing: 0.4,
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: {
        background: "#121212",
        foreground: "#e8e8e8",
        cursor: "#e8e8e8",
        cursorAccent: "#121212",
        selectionBackground: "rgba(255,255,255,0.16)",
        black:        "#1a1a1a",
        red:          "#ff6b6b",
        green:        "#4ade80",
        yellow:       "#fbbf24",
        blue:         "#60a5fa",
        magenta:      "#c084fc",
        cyan:         "#22d3ee",
        white:        "#e8e8e8",
        brightBlack:  "#5a5a5a",
        brightRed:    "#ff8888",
        brightGreen:  "#86efac",
        brightYellow: "#fde68a",
        brightBlue:   "#93c5fd",
        brightMagenta:"#d8b4fe",
        brightCyan:   "#67e8f9",
        brightWhite:  "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(container);
    // (Previously printed an "xterm mounted · requested cwd: …" line
    // for debugging. Removed — the shell prompt itself shows the cwd,
    // so the banner only added noise on every terminal open.)

    // ── 2. Spawn the PTY ──
    let ptyId: string | null = null;
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;
    let disposed = false;

    const onDataDisposable = term.onData(d => {
      if (ptyId) window.electronAPI?.ptyWrite(ptyId, d);
    });

    const onResizeDisposable = term.onResize(({ cols: c, rows: r }) => {
      if (ptyId) window.electronAPI?.ptyResize(ptyId, c, r);
    });

    // Wait one rAF + microtask cycle so xterm's renderer has measured
    // its cell box against the real container before we spawn the PTY.
    // Spawning earlier baked the prompt at 80×24 (the constructor
    // defaults); the later resize only nudges the shell — long zsh /
    // starship prompts that overflow 80 cols had already wrapped, so
    // the redraw left visual garbage like overlapping path segments.
    const waitForFit = (): Promise<{ cols: number; rows: number }> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          try {
            fitAddon.fit();
          } catch { /* container measured 0 — fall back to 80×24 */ }
          // Clamp to xterm's minimum (1×1) but keep a sane floor so
          // a momentarily-collapsed panel doesn't spawn a 0-col shell.
          const c = Math.max(20, term.cols || 80);
          const r = Math.max(5,  term.rows || 24);
          resolve({ cols: c, rows: r });
        });
      });

    (async () => {
      const api = window.electronAPI;
      if (!api?.ptySpawn) {
        term.write("\x1b[31m[error] window.electronAPI.ptySpawn is missing — preload.cjs may not be loaded.\x1b[0m\r\n");
        return;
      }
      try {
        const { cols, rows } = await waitForFit();
        if (disposed) return;
        const res = await api.ptySpawn({ cols, rows, cwd, shell });
        if (disposed) {
          // Effect was cleaned up while we were awaiting. Kill the
          // freshly-born shell so it doesn't leak.
          if (res && res.ok) api.ptyKill(res.id);
          return;
        }
        if (!res || !res.ok) {
          const err = (res as { error?: string } | undefined)?.error ?? "unknown error";
          term.write(`\x1b[31m[error] ptySpawn failed: ${err}\x1b[0m\r\n`);
          term.write("\x1b[2mTip: hard-restart the app. If the issue persists, check that the Tauri pty_spawn command is registered.\x1b[0m\r\n");
          return;
        }
        ptyId = res.id;
        // (Previously echoed "shell cwd: …" — silenced for the same
        // reason as the mount banner. The prompt + main.cjs logs are
        // the source of truth if cwd resolution ever needs debugging.)

        unsubData = api.onPtyData(ptyId, chunk => {
          term.write(chunk);
          // Sniff for a dev-server boot banner so the Preview pane can frame it.
          // Piggybacks on the subscription the terminal already needs — no
          // second listener, and no Rust change, because pty.rs already streams
          // every chunk to the renderer.
          if (cwd) feedPtyChunk(cwd, chunk);
        });
        unsubExit = api.onPtyExit(ptyId, ({ exitCode, signal }) => {
          term.write(`\r\n\x1b[2m[process exited — code ${exitCode}${signal ? ` signal ${signal}` : ""}]\x1b[0m\r\n`);
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        term.write(`\x1b[31m[error] ${msg}\x1b[0m\r\n`);
        term.write("\x1b[2mHard-restart Electron so the new main.cjs (with PTY handlers) loads:\x1b[0m\r\n");
        term.write("\x1b[2m  pkill -9 -f \"frontend/node_modules/electron\" && sleep 1 && make dev\x1b[0m\r\n");
      }
    })();

    // ── 3. Resize observer ──
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* ignore transient zero-sized states */ }
    });
    ro.observe(container);

    // ── 4. Cleanup ──
    return () => {
      disposed = true;
      ro.disconnect();
      unsubData?.();
      unsubExit?.();
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      if (ptyId) window.electronAPI?.ptyKill(ptyId);
      try { term.dispose(); } catch { /* already disposed */ }
    };
  }, [cwd, shell]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%", height: "100%",
        background: "#121212",
        padding: "8px 0 0 10px",
        boxSizing: "border-box",
      }}
    />
  );
}
