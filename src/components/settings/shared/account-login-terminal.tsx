/**
 * AccountLoginTerminal — an xterm bound to an *existing* PTY (the one
 * `providers.openAccountLogin` spawned for a CLI agent's `… login` flow inside
 * the account's isolated HOME). Unlike `XtermShell` it does NOT spawn its own
 * shell; it attaches to `ptyId` and relays I/O so the user can complete the
 * OAuth / device-code dance, then fires `onExit` when the login process ends so
 * the parent can refresh the account's authenticated state.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface Props {
  ptyId: string;
  onExit?: (exitCode: number) => void;
}

export function AccountLoginTerminal({ ptyId, onExit }: Props) {
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
    term.loadAddon(new WebLinksAddon());
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
        unsubData = api.onPtyData(ptyId, (chunk) => term.write(chunk));
        unsubExit = api.onPtyExit(ptyId, ({ exitCode }) => {
          term.write(`\r\n\x1b[2m[login process exited — code ${exitCode}]\x1b[0m\r\n`);
          onExitRef.current?.(exitCode);
        });
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
      window.electronAPI?.ptyKill(ptyId);
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
    };
  }, [ptyId]);

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
