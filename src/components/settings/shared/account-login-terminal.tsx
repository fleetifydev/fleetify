/**
 * AccountLoginTerminal — an xterm bound to an *existing* PTY (the one
 * `providers.openAccountLogin` spawned for a CLI agent's login flow, in the
 * account's isolated HOME or the real one). Unlike `XtermShell` it does NOT
 * spawn its own shell; it attaches to `ptyId` and relays I/O so the user can
 * complete the OAuth / device-code dance or the agent's menu, then fires
 * `onExit` when the login process ends so the parent can refresh the
 * account's signed-in state.
 *
 * A login prints its URL within milliseconds, before the `pty:data` listener
 * is registered (Tauri drops events nobody listens to), so the terminal
 * replays the PTY's buffered output once it subscribes.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { openLink } from "@/lib/links";
import { unseenTail } from "@/lib/pty-replay";

interface Props {
  ptyId: string;
  onExit?: (exitCode: number) => void;
  /** Leave the login running when the terminal unmounts (the in-chat card
   *  re-attaches after a remount and stops the process itself). */
  keepAlive?: boolean;
}

export function AccountLoginTerminal({ ptyId, onExit, keepAlive = false }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"SF Mono", "SFMono-Regular", ui-monospace, "Menlo", "Monaco", "Consolas", monospace',
      fontSize: 11,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      allowProposedApi: true,
      theme: { background: "#121212", foreground: "#e8e8e8", cursor: "#e8e8e8" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // The addon's own handler opens a link with window.open, which the
    // webview refuses: links, such as a sign-in URL, go to the system
    // browser instead.
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    term.open(container);

    const onData = term.onData((d) => window.electronAPI?.ptyWrite(ptyId, d));
    const onResize = term.onResize(({ cols, rows }) =>
      window.electronAPI?.ptyResize(ptyId, cols, rows),
    );

    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;
    const api = window.electronAPI;
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        /* container not measured yet */
      }
      if (api) {
        api.ptyResize(ptyId, Math.max(20, term.cols || 80), Math.max(5, term.rows || 24));
        // Hold live chunks until the buffered output is written, so the
        // early lines land first and nothing prints twice.
        let synced = false;
        let pending = "";
        unsubData = api.onPtyData(ptyId, (chunk) => {
          if (synced) term.write(chunk);
          else pending += chunk;
        });
        unsubExit = api.onPtyExit(ptyId, ({ exitCode }) => {
          term.write(`\r\n\x1b[2m[login process exited — code ${exitCode}]\x1b[0m\r\n`);
          onExitRef.current?.(exitCode);
        });
        void (async () => {
          const snap = await api.ptyBuffer?.(ptyId).catch(() => null);
          const head = snap?.ok ? snap.data : "";
          if (head) term.write(head);
          term.write(unseenTail(head, pending));
          synced = true;
          pending = "";
        })();
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        /* ignore transient zero-size */
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      unsubData?.();
      unsubExit?.();
      onData.dispose();
      onResize.dispose();
      // Kill the login PTY if the user closes the dialog before completing.
      if (!keepAlive) window.electronAPI?.ptyKill(ptyId);
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
    };
  }, [ptyId, keepAlive]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 280,
        background: "#121212",
        padding: "8px 0 0 10px",
        boxSizing: "border-box",
      }}
    />
  );
}
