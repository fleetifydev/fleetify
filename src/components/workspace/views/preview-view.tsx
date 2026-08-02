/**
 * PreviewView — the running project, framed.
 *
 * Deliberately NOT a browser: no address bar, no history, no tabs. The user
 * navigates inside their own app; anything more is what the Browser view is
 * for. The URL comes from the dev-server sniffer reading terminal output, and
 * can be pinned by hand when detection misses.
 *
 * An iframe rather than the native webview: the webview renders ABOVE the DOM
 * (see BrowserView), which would occlude this pane's own header for no benefit
 * here — there is nothing to inspect, click-pick, or script.
 */
import { useContext, useState } from "react";
import { Globe, RotateCw, X } from "lucide-react";
import { useDevServerStore, selectDevUrl, setManualUrl } from "@/stores/dev-server-store";
import { useActiveCwd } from "@/components/workspace/use-active-cwd";
import { PaneCloseContext } from "@/components/workspace/pane-close-context";

/** Accept "localhost:3000" as readily as a full URL. */
function normalise(raw: string): string {
  const t = raw.trim();
  return /^https?:\/\//.test(t) ? t : `http://${t}`;
}

export function PreviewView() {
  const cwd = useActiveCwd() ?? "";
  const requestClose = useContext(PaneCloseContext);
  const url = useDevServerStore(selectDevUrl(cwd));
  const [draft, setDraft] = useState("");
  // Bumping this remounts the iframe — the only way to force a reload of a
  // cross-origin document we are not allowed to reach into.
  const [reloadNonce, setReloadNonce] = useState(0);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 8,
          padding: "0 8px 0 10px", borderBottom: "1px solid var(--c-brd)",
        }}
      >
        <Globe size={10} style={{ opacity: 0.4, flexShrink: 0 }} />
        <span
          style={{
            flex: 1, fontSize: 11, opacity: 0.6,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {url ?? "Preview"}
        </span>
        {url && (
          <>
            <button
              onClick={() => setReloadNonce(n => n + 1)}
              title="Reload"
              style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.5, display: "flex", padding: 2 }}
            >
              <RotateCw size={11} />
            </button>
            <button
              onClick={() => { setManualUrl(cwd, null); setDraft(""); }}
              title="Use a different address"
              style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.5, fontSize: 10.5, padding: "2px 4px" }}
            >
              Change
            </button>
          </>
        )}
        <button
          onClick={() => requestClose?.("preview")}
          title="Close preview pane"
          style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.5, display: "flex", padding: 2 }}
        >
          <X size={11} />
        </button>
      </div>

      {url ? (
        <iframe
          key={`${url}#${reloadNonce}`}
          src={url}
          title="preview"
          style={{ flex: 1, border: "none", background: "#fff" }}
          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        />
      ) : (
        <div
          style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 12, padding: 24,
          }}
        >
          <Globe size={18} style={{ opacity: 0.3 }} />
          <div style={{ fontSize: 12, opacity: 0.55, textAlign: "center", maxWidth: 250, lineHeight: 1.5 }}>
            {cwd
              ? "No dev server detected yet. Start one in the terminal, or enter its address."
              : "Open a session to preview its dev server."}
          </div>
          {cwd && (
            <form
              onSubmit={e => {
                e.preventDefault();
                if (draft.trim()) setManualUrl(cwd, normalise(draft));
              }}
              style={{ display: "flex", gap: 6 }}
            >
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder="localhost:3000"
                aria-label="Preview address"
                style={{
                  background: "var(--c-srf)", border: "1px solid var(--c-brd)", borderRadius: 5,
                  padding: "4px 9px", fontSize: 11.5, outline: "none", width: 190,
                  color: "var(--card-foreground)",
                }}
              />
              <button
                type="submit"
                style={{
                  fontSize: 11.5, padding: "4px 11px", borderRadius: 5,
                  border: "1px solid var(--c-brd)", background: "var(--c-srf2)",
                  color: "var(--card-foreground)", cursor: "pointer",
                }}
              >
                Open
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
