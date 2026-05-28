import { useEffect, useState, useCallback } from "react";
import { Search, Github } from "lucide-react";
import { listReposResolved, type GhRepo } from "@/lib/api";
import { normalizeCloneUrl } from "@/lib/git-url";

/* ─── GitSourceTab — the "Git" source picker tab ───────────────────────
   Two independent capabilities:
     1. Clone by URL (TOP, always available) — `git clone` works for any
        public repo with no GitHub connection; private repos use the
        system git credential helper.
     2. Browse my repos (gated) — enumerating the user's repos needs a
        GitHub connection, resolved gh-first → OAuth → not-connected.
   Both row-click and URL submit converge on the same clone path via the
   `onPick` / `onClone` callbacks. ─────────────────────────────────────*/

type State =
  | { kind: "loading" }
  | { kind: "list"; repos: GhRepo[] }
  | { kind: "not-connected" }
  | { kind: "error"; message: string };

export function GitSourceTab({
  onPick, cloning, onClone, cloneError,
}: {
  onPick: (url: string) => void;     // repo row click
  cloning: boolean;
  onClone: (url: string) => void;    // URL paste submit
  cloneError?: string | null;        // surfaced by the owner's clone handler
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [filter, setFilter] = useState("");
  const [url, setUrl] = useState("");

  const load = useCallback(() => {
    setState({ kind: "loading" });
    listReposResolved()
      .then(r => {
        if (r.connected) setState({ kind: "list", repos: r.repos });
        else if (r.error) setState({ kind: "error", message: r.error });
        else setState({ kind: "not-connected" });
      })
      .catch((e: Error) => setState({ kind: "error", message: e.message }));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live-refresh when the GitHub link connects/disconnects so the tab
  // flips between the list and the not-connected panel without a remount.
  useEffect(() => {
    const w = window as unknown as {
      electronAPI?: { github?: { onLinkChanged?: (cb: () => void) => () => void } };
    };
    const off = w.electronAPI?.github?.onLinkChanged?.(() => load());
    return () => { off?.(); };
  }, [load]);

  const openIntegrations = () =>
    window.dispatchEvent(new CustomEvent("fleet:open-settings", { detail: { tab: "Integrations" } }));

  const submitUrl = () => {
    const u = normalizeCloneUrl(url);
    if (!u || cloning) return;
    onClone(u);
  };

  const repos = state.kind === "list" ? state.repos : [];
  const shown = repos.filter(r =>
    !filter.trim() || r.nameWithOwner.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* ── Clone by URL — TOP, always available ── */}
      <div style={{ padding: "9px 10px", borderBottom: "1px solid var(--c-brd)", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
        <div style={{ alignSelf: "flex-start", textAlign: "left", fontSize: 9.5, fontWeight: 600, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--c-dim)" }}>
          Clone from URL
        </div>
        <div style={{ alignSelf: "stretch", display: "flex", alignItems: "stretch", background: "var(--c-srf2)", border: "1px solid var(--c-brd)", borderRadius: 6, overflow: "hidden" }}>
          <span style={{ display: "inline-flex", alignItems: "center", paddingLeft: 9, paddingRight: 7, color: "var(--c-dim)", flexShrink: 0 }}>
            <Github size={11} />
          </span>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submitUrl(); } }}
            placeholder="owner/repo or https://github.com/owner/repo"
            disabled={cloning}
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, padding: "6px 0", background: "transparent", border: "none", color: "var(--c-fg)", fontFamily: "var(--font-mono)", fontSize: 11, outline: "none", opacity: cloning ? 0.6 : 1 }}
          />
          <button
            onClick={submitUrl}
            disabled={!url.trim() || cloning}
            style={{ padding: "0 12px", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-sans)", color: url.trim() && !cloning ? "var(--card, #0a0a0a)" : "var(--c-dim)", background: url.trim() && !cloning ? "var(--c-fg)" : "transparent", border: "none", borderLeft: "1px solid var(--c-brd)", cursor: url.trim() && !cloning ? "pointer" : "default", outline: "none", flexShrink: 0, transition: "background 0.12s, color 0.12s" }}
          >
            {cloning ? "…" : "Clone"}
          </button>
        </div>
        {cloneError && (
          <span style={{ alignSelf: "stretch", fontSize: 10.5, color: "#ef4444", fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>{cloneError}</span>
        )}
      </div>

      {/* ── Browse my repos — GitHub-gated ── */}
      {state.kind === "not-connected" ? (
        <div style={{ padding: "20px 14px", textAlign: "center", display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-fg)" }}>GitHub not connected</div>
          <div style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.5, maxWidth: 240 }}>
            Connect GitHub to browse your repositories. You can still clone any public repo by URL above.
          </div>
          <button
            onClick={openIntegrations}
            style={{ marginTop: 2, padding: "5px 11px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid var(--c-brd2)", background: "var(--c-srf)", color: "var(--c-fg)", cursor: "pointer", fontFamily: "var(--font-sans)" }}
          >
            Open Settings → Integrations
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderBottom: "1px solid var(--c-brd)" }}>
            <Search size={11} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter repositories…"
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, padding: 0, background: "transparent", border: "none", color: "var(--c-fg)", fontFamily: "var(--font-sans)", fontSize: 11.5, outline: "none" }}
            />
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto", padding: 4, display: "flex", flexDirection: "column" }}>
            {state.kind === "loading" && (
              <div style={{ padding: "18px 12px", textAlign: "center", fontSize: 11.5, color: "var(--c-dim)" }}>Loading repositories…</div>
            )}
            {state.kind === "error" && (
              <div style={{ padding: 10, fontSize: 11, color: "#ef4444", fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>{state.message}</div>
            )}
            {state.kind === "list" && shown.map(r => (
              <button
                key={r.nameWithOwner}
                disabled={cloning}
                onMouseDown={e => e.preventDefault()}
                onClick={() => onPick(r.url)}
                title={r.description || r.nameWithOwner}
                style={{ display: "grid", gridTemplateColumns: "10px minmax(0,1fr) auto", alignItems: "center", columnGap: 8, padding: "5px 8px", background: "transparent", border: "none", outline: "none", borderRadius: 4, textAlign: "left", cursor: cloning ? "default" : "pointer", opacity: cloning ? 0.5 : 1, fontFamily: "var(--font-sans)", color: "var(--c-fg)", width: "100%" }}
                onMouseEnter={e => { if (!cloning) (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.06))"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: r.isPrivate ? "var(--c-dim)" : "rgba(120,180,140,0.95)", justifySelf: "center" }} />
                <span style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 7, overflow: "hidden" }}>
                  <span style={{ fontSize: 11.75, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0, maxWidth: "60%" }}>{r.nameWithOwner}</span>
                  {r.description && (
                    <span style={{ fontSize: 10.75, color: "var(--c-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{r.description}</span>
                  )}
                </span>
                <span />
              </button>
            ))}
            {state.kind === "list" && shown.length === 0 && (
              <div style={{ padding: "18px 12px", textAlign: "center", fontSize: 11.5, color: "var(--c-dim)" }}>No repositories found.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
