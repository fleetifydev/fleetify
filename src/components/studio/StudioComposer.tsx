import { useEffect, useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { PanelLeft, FolderOpen } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { isWindowsPlatform } from "@/lib/utils";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { studioApi, type HfModel, type StudioToolStatus, type HfAccount } from "@/lib/studio-api";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { createSession } from "@/lib/api";

type Media = "image" | "video";

const control: CSSProperties = {
  fontSize: 12.5,
  padding: "8px 11px",
  borderRadius: 8,
  background: "var(--c-srf)",
  color: "var(--c-high)",
  border: "1px solid var(--c-brd)",
};

const leaf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Studio "New generation" composer.
 *
 * Like the Workspace new-session screen: no session row exists yet. On Generate
 * we create the session, stash the first generation as a one-shot handoff
 * (`setPendingGeneration`), and activate the session — StudioSession then runs
 * the generation and renders the live "Generating…" state in the chat, so the
 * composer never blocks. A folder is mandatory (generations are saved there).
 */
export function StudioComposer() {
  const addSession = useAppStore((s) => s.addSession);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setPendingGeneration = useAppStore((s) => s.setPendingGeneration);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const isWindows = isWindowsPlatform();

  const [provider, setProvider] = useState(STUDIO_TOOLS[0]?.id ?? "higgsfield");
  const [media, setMedia] = useState<Media>("image");
  const [models, setModels] = useState<HfModel[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [folder, setFolder] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<StudioToolStatus[] | null>(null);
  const [account, setAccount] = useState<HfAccount | null>(null);

  const loadTools = useCallback(async () => {
    try {
      setTools(await studioApi.getTools());
    } catch {
      setTools([]);
    }
    try {
      setAccount(await studioApi.getAccount());
    } catch {
      setAccount(null);
    }
  }, []);
  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  useEffect(() => {
    let cancelled = false;
    void studioApi
      .listModels(media)
      .then((ms) => {
        if (cancelled) return;
        setModels(ms);
        setModel(ms[0]?.job_set_type ?? "");
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [media]);

  const pick = useCallback(async () => {
    // Match the Workspace new-session picker (session-toolbar): the OS folder
    // dialog is owned by the window shell (electronAPI), not the backend —
    // `/fs/pick` is intentionally a no-op. Fall back to a prompt if absent.
    if (window.electronAPI?.openFolderDialog) {
      const p = await window.electronAPI.openFolderDialog();
      if (p) setFolder(p);
      return;
    }
    const p = window.prompt("Folder for your generations");
    if (p) setFolder(p);
  }, []);

  const canSubmit = !!model && !!prompt.trim() && !!folder && !submitting;

  const submit = useCallback(async () => {
    if (!model || !prompt.trim() || !folder || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const text = prompt.trim();
      const title = text.slice(0, 48) || "Generation";
      const session = await createSession({
        title,
        project_path: folder,
        tool: provider,
        permission_mode: "default",
        model_name: model,
        use_worktree: false,
      });
      addSession(session);
      // Hand the first generation to the session view, then activate it. The
      // session runs it and shows "Generating…" — the composer never blocks.
      setPendingGeneration({ sessionId: session.id, model, media, params: { prompt: text }, prompt: text });
      setActiveSession(session.id); // clears studioComposerOpen
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [model, prompt, folder, submitting, provider, media, addSession, setPendingGeneration, setActiveSession]);

  const seg = (active: boolean): CSSProperties => ({
    padding: "5px 12px",
    borderRadius: 7,
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    border: `1px solid ${active ? "var(--c-brd)" : "transparent"}`,
    background: active ? "var(--c-srf2)" : "transparent",
    color: active ? "var(--c-high)" : "var(--c-med)",
    cursor: "pointer",
  });

  const status = tools?.find((t) => t.id === provider);
  const notInstalled = !!status && !status.installed;
  const notConnected = !!status && status.installed && !status.authenticated;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--card)" }}>
      {/* Top bar — mirrors the Workspace chat header: the "New generation"
          label sits INSIDE the 44px header at the exact scale/colour/font of
          the new-session "New chat" breadcrumb (chat-view SessionBreadcrumb). */}
      <div className="drag-region" style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", background: "var(--card)" }}>
        <div className="no-drag" style={{ display: "flex", alignItems: "center", gap: 14, paddingLeft: !isWindows && sidebarCollapsed ? 84 : 0, minWidth: 0 }}>
          {!isWindows && sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              title="Show sidebar"
              style={{ width: 22, height: 22, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)" }}
            >
              <PanelLeft size={14} />
            </button>
          )}
          <span style={{ fontSize: 13, fontWeight: 400, color: "var(--c-med)", fontFamily: "var(--font-sans)", letterSpacing: "-0.01em", padding: "1px 4px" }}>
            New generation
          </span>
        </div>
        {account && (
          <span className="no-drag" title={`Higgsfield balance · ${account.email}`} style={{ fontSize: 11, color: "var(--c-dim)", flexShrink: 0 }}>
            {account.credits} credit{account.credits === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 540, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {STUDIO_TOOLS.map((t) => {
              const active = provider === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setProvider(t.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "5px 11px 5px 8px",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    border: `1px solid ${active ? "var(--c-brd)" : "transparent"}`,
                    background: active ? "var(--c-srf2)" : "transparent",
                    color: active ? "var(--c-high)" : "var(--c-med)",
                    cursor: "pointer",
                  }}
                >
                  <ProviderLogo tool={t.id} size={15} /> {t.name}
                </button>
              );
            })}
            <span style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 4 }}>
              {(["image", "video"] as const).map((t) => (
                <button key={t} onClick={() => setMedia(t)} style={seg(media === t)}>
                  {t === "image" ? "Image" : "Video"}
                </button>
              ))}
            </div>
          </div>

          {notInstalled ? (
            <div style={{ fontSize: 12.5, color: "var(--c-med)", padding: "12px 0" }}>
              {status?.display_name ?? "This tool"} isn’t installed. Run{" "}
              <code style={{ color: "var(--c-high)" }}>{status?.install_hint}</code>
            </div>
          ) : notConnected ? (
            <div style={{ fontSize: 12.5, color: "var(--c-med)", padding: "12px 0", display: "flex", alignItems: "center", gap: 10 }}>
              <span>
                Not connected. Run <code style={{ color: "var(--c-high)" }}>hf auth login</code> in your terminal, then
              </span>
              <button onClick={() => void loadTools()} style={{ ...control, padding: "5px 11px", cursor: "pointer" }}>
                Refresh
              </button>
            </div>
          ) : (
            <>
              <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} style={{ ...control, width: "100%", cursor: "pointer" }}>
                {models.map((m) => (
                  <option key={m.job_set_type} value={m.job_set_type}>
                    {m.display_name}
                  </option>
                ))}
              </select>

              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
                }}
                placeholder="Describe what you want to create…"
                rows={5}
                autoFocus
                disabled={submitting}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontSize: 14,
                  lineHeight: 1.5,
                  padding: "13px 15px",
                  borderRadius: 10,
                  resize: "none",
                  background: "var(--c-srf)",
                  color: "var(--c-high)",
                  border: "1px solid var(--c-brd)",
                  outline: "none",
                }}
              />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <button
                  onClick={() => void pick()}
                  title="Choose where generations are saved"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 12px",
                    borderRadius: 8,
                    fontSize: 12,
                    maxWidth: 280,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                    background: "var(--c-srf)",
                    color: folder ? "var(--c-high)" : "var(--c-med)",
                    border: "1px solid var(--c-brd)",
                    cursor: "pointer",
                  }}
                >
                  <FolderOpen size={13} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
                  {folder ? leaf(folder) : "Pick folder"}
                </button>
                <button
                  onClick={() => void submit()}
                  disabled={!canSubmit}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    padding: "8px 20px",
                    borderRadius: 8,
                    border: "none",
                    cursor: canSubmit ? "pointer" : "default",
                    background: "var(--c-high)",
                    color: "var(--card)",
                    opacity: canSubmit ? 1 : 0.45,
                  }}
                >
                  {submitting ? "Starting…" : "Generate"}
                </button>
              </div>

              {!folder && <div style={{ fontSize: 11, color: "var(--c-dim)" }}>Pick a folder — your generations are saved there.</div>}
              {error && <div style={{ fontSize: 12, color: "#e66" }}>{error}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
