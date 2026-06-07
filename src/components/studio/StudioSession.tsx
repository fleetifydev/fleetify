import { useEffect, useState, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import { PanelLeft, FolderOpen } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { usesInAppTitleBar } from "@/lib/utils";
import { LogoMark } from "@/components/brand/logo-mark";
import { studioApi, type HfModel, type HfModelParam } from "@/lib/studio-api";

interface Block { type: string; text?: string; artifact_type?: string; content?: string; job_id?: string; saved_path?: string | null; }
interface GenAsset { url: string; kind: "image" | "video"; jobId?: string; }
interface GenItem { prompt: string; assets: GenAsset[]; }
type Media = "image" | "video";

const fieldStyle: CSSProperties = {
  fontSize: 12, padding: "5px 8px", borderRadius: 6,
  background: "var(--c-srf)", color: "var(--c-high)", border: "1px solid var(--c-brd)",
};
const mediaStyle: CSSProperties = {
  maxWidth: 360, maxHeight: 360, borderRadius: 10, border: "1px solid var(--c-brd)", display: "block",
};
const linkStyle: CSSProperties = { fontSize: 11, color: "var(--c-dim)", textDecoration: "none" };
const linkBtn: CSSProperties = { background: "none", border: "none", padding: 0, fontSize: 11, color: "var(--c-dim)", cursor: "pointer" };
const userBubble: CSSProperties = {
  alignSelf: "flex-end", maxWidth: "80%", background: "var(--c-srf2)", border: "1px solid var(--c-brd)",
  borderRadius: 14, borderBottomRightRadius: 4, padding: "9px 13px", fontSize: 13, lineHeight: 1.5,
  color: "var(--c-high)", whiteSpace: "pre-wrap", wordBreak: "break-word",
};

const leaf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const fileName = (url: string) => url.split("/").pop()?.split("?")[0] || "asset";

/**
 * Live Studio session — a chat-style generation surface. The transcript shows
 * each prompt (as a user bubble) and its resulting image/video, with the live
 * "Generating…" indicator (the same glowing logo + shimmer the Workspace chat
 * uses) while a job runs. The composer is pinned at the bottom like the chat.
 *
 * On mount it consumes a one-shot `pendingGeneration` handed over by the "New
 * generation" composer and runs that first generation. Supports ITERATIVE
 * EDITING: "Edit" on a generated image carries its job id forward as the source
 * for the next generation (Higgsfield accepts a prior job id as `--image`).
 */
export function StudioSession({ sessionId }: { sessionId: string }) {
  const session = useAppStore((s) => s.sessions.find((x) => x.id === sessionId));
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const pendingGeneration = useAppStore((s) => s.pendingGeneration);
  const clearPendingGeneration = useAppStore((s) => s.clearPendingGeneration);
  const inAppBar = usesInAppTitleBar();

  const [media, setMedia] = useState<Media>("image");
  const [models, setModels] = useState<HfModel[]>([]);
  const [model, setModel] = useState("");
  const [params, setParams] = useState<HfModelParam[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("");
  const [cost, setCost] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GenItem[]>([]);
  const [editSource, setEditSource] = useState<GenAsset | null>(null);
  const [pending, setPending] = useState<{ prompt: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const consumedRef = useRef<string | null>(null);

  // Fresh edit/prompt state when the session changes.
  useEffect(() => { setEditSource(null); setPrompt(""); }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    void studioApi.listModels(media).then((ms) => {
      if (cancelled) return;
      setModels(ms);
      setModel(ms[0]?.job_set_type ?? "");
    }).catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [media]);

  useEffect(() => {
    if (!model) { setParams([]); setValues({}); return; }
    let cancelled = false;
    void studioApi.getModel(model).then((d) => {
      if (cancelled) return;
      const ps = (d?.params ?? []).filter((p) => p.name !== "prompt" && ["string", "number", "integer"].includes(p.type));
      setParams(ps);
      const seed: Record<string, string> = {};
      for (const p of ps) if (p.default != null && typeof p.default !== "object") seed[p.name] = String(p.default);
      setValues(seed);
    }).catch(() => { if (!cancelled) { setParams([]); setValues({}); } });
    return () => { cancelled = true; };
  }, [model]);

  const buildParams = useCallback((promptText: string): Record<string, unknown> => {
    const out: Record<string, unknown> = { prompt: promptText };
    for (const p of params) {
      const v = values[p.name];
      if (v != null && v !== "") out[p.name] = v;
    }
    // Image-to-image: feed the prior result's job id as the source.
    if (editSource?.jobId) out.image = editSource.jobId;
    return out;
  }, [params, values, editSource]);

  useEffect(() => {
    if (!model || !prompt.trim()) { setCost(null); return; }
    const id = setTimeout(() => {
      void studioApi.cost(model, buildParams(prompt.trim())).then((c) => setCost(c.credits)).catch(() => setCost(null));
    }, 600);
    return () => clearTimeout(id);
  }, [model, prompt, buildParams]);

  const loadGallery = useCallback(async () => {
    try {
      const msgs = await studioApi.listMessages(sessionId);
      const items: GenItem[] = [];
      let pendingPrompt = "";
      for (const msg of msgs) {
        let blocks: Block[] = [];
        try { blocks = JSON.parse(msg.content) as Block[]; } catch { continue; }
        if (msg.role === "user") {
          pendingPrompt = blocks.find((b) => b.type === "text")?.text ?? "";
        } else {
          const assets: GenAsset[] = blocks
            .filter((b) => b.type === "artifact" && b.content && (b.artifact_type === "image" || b.artifact_type === "video"))
            .map((b) => ({ url: b.content as string, kind: b.artifact_type === "video" ? "video" : "image", jobId: b.job_id }));
          if (assets.length) { items.push({ prompt: pendingPrompt, assets }); pendingPrompt = ""; }
        }
      }
      setGallery(items); // chronological (oldest first) — chat order
    } catch { /* noop */ }
  }, [sessionId]);

  useEffect(() => { void loadGallery(); }, [loadGallery]);

  // Auto-scroll to the newest item / the live "Generating…" row.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [gallery, pending]);

  const runGeneration = useCallback(async (mdl: string, genParams: Record<string, unknown>, promptText: string) => {
    setGenerating(true);
    setError(null);
    setPending({ prompt: promptText });
    try {
      await studioApi.generate(sessionId, mdl, genParams);
      setEditSource(null);
      await loadGallery();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      setGenerating(false);
    }
  }, [sessionId, loadGallery]);

  // Consume the one-shot handoff from the "New generation" composer.
  useEffect(() => {
    if (!pendingGeneration || pendingGeneration.sessionId !== sessionId) return;
    if (consumedRef.current === sessionId) return;
    consumedRef.current = sessionId;
    const pg = pendingGeneration;
    clearPendingGeneration();
    setMedia(pg.media);
    void runGeneration(pg.model, pg.params, pg.prompt);
  }, [pendingGeneration, sessionId, clearPendingGeneration, runGeneration]);

  const onGenerate = useCallback(() => {
    if (!model || !prompt.trim() || generating) return;
    const text = prompt.trim();
    const genParams = buildParams(text);
    setPrompt("");
    void runGeneration(model, genParams, text);
  }, [model, prompt, generating, buildParams, runGeneration]);

  const startEdit = useCallback((asset: GenAsset) => {
    setEditSource(asset);
    setMedia("image");
  }, []);

  const seg = (active: boolean): CSSProperties => ({
    padding: "4px 12px", borderRadius: 5, fontSize: 12, border: "1px solid var(--c-brd)",
    background: active ? "var(--c-srf2)" : "transparent",
    color: active ? "var(--c-high)" : "var(--c-med)", cursor: "pointer",
  });

  const canGenerate = !!model && !!prompt.trim() && !generating;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--card)" }}>
      {/* Header — session title in the breadcrumb style, folder readout right. */}
      <div className="drag-region" style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 16px", background: "var(--card)" }}>
        <div className="no-drag" style={{ display: "flex", alignItems: "center", gap: 14, paddingLeft: !inAppBar && sidebarCollapsed ? 84 : 0, minWidth: 0 }}>
          {!inAppBar && sidebarCollapsed && (
            <button onClick={toggleSidebar} title="Show sidebar" style={{ width: 22, height: 22, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)" }}>
              <PanelLeft size={14} />
            </button>
          )}
          <span style={{ fontSize: 13, fontWeight: 400, color: "var(--c-med)", fontFamily: "var(--font-sans)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 }}>
            {session?.title ?? "Generation"}
          </span>
        </div>
        {session?.project_path && (
          <span className="no-drag" title={session.project_path} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--c-dim)", flexShrink: 0, maxWidth: 220, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            <FolderOpen size={11} style={{ flexShrink: 0 }} /> {leaf(session.project_path)}
          </span>
        )}
      </div>

      {/* Transcript — prompts + results top-to-bottom, newest at the bottom. */}
      <div ref={scrollRef} style={{ flex: 1, overflow: "auto" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 24px 12px", display: "flex", flexDirection: "column", gap: 26 }}>
          {gallery.length === 0 && !pending && (
            <div style={{ fontSize: 12.5, color: "var(--c-dim)", textAlign: "center", padding: "48px 0" }}>
              Your generations will appear here.
            </div>
          )}
          {gallery.map((g, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {g.prompt && <div style={userBubble}>{g.prompt}</div>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {g.assets.map((a, j) => (
                  <div key={j} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {a.kind === "video"
                      ? <video controls src={a.url} style={mediaStyle} />
                      : <img src={a.url} alt="Generated" style={mediaStyle} />}
                    <div style={{ display: "flex", gap: 12 }}>
                      {a.kind === "image" && a.jobId && (
                        <button onClick={() => startEdit(a)} style={linkBtn}>Edit</button>
                      )}
                      <a href={a.url} download={fileName(a.url)} target="_blank" rel="noreferrer" style={linkStyle}>Download</a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {pending && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {pending.prompt && <div style={userBubble}>{pending.prompt}</div>}
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, animation: "fade-in 0.2s ease both" }}>
                <LogoMark size={13} glow style={{ flexShrink: 0, color: "var(--c-high)" }} />
                <span className="thinking-shimmer-text" style={{ fontSize: 12, fontWeight: 500, fontFamily: "var(--font-sans)", letterSpacing: "-0.01em" }}>
                  Generating…
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer — pinned at the bottom like the Workspace chat. */}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--c-brd)", background: "var(--card)", padding: "12px 16px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {(["image", "video"] as const).map((t) => (
              <button key={t} onClick={() => setMedia(t)} style={seg(media === t)}>{t === "image" ? "Image" : "Video"}</button>
            ))}
            <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} style={{ ...fieldStyle, maxWidth: 240, cursor: "pointer" }}>
              {models.map((m) => <option key={m.job_set_type} value={m.job_set_type}>{m.display_name}</option>)}
            </select>
            {cost != null && <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>~{cost} credits</span>}
          </div>

          {params.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {params.map((p) => (
                <label key={p.name} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5, color: "var(--c-med)" }}>
                  <span>{p.name}{p.required ? " *" : ""}</span>
                  {p.enum && p.enum.length > 0 ? (
                    <select aria-label={p.name} value={values[p.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} style={fieldStyle}>
                      {p.enum.map((opt, i) => <option key={i} value={String(opt)}>{String(opt)}</option>)}
                    </select>
                  ) : (
                    <input aria-label={p.name} type={["number", "integer"].includes(p.type) ? "number" : "text"}
                      value={values[p.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} style={fieldStyle} />
                  )}
                </label>
              ))}
            </div>
          )}

          {editSource && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--c-brd)", background: "var(--c-srf)", alignSelf: "flex-start" }}>
              <img src={editSource.url} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5 }} />
              <span style={{ fontSize: 11.5, color: "var(--c-med)" }}>Editing from this image</span>
              <button onClick={() => setEditSource(null)} aria-label="Clear source" style={{ background: "none", border: "none", color: "var(--c-dim)", cursor: "pointer", fontSize: 13 }}>✕</button>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onGenerate();
                }
              }}
              placeholder={editSource ? "Describe the edit…" : "Describe what to generate…"}
              rows={2}
              style={{ flex: 1, fontSize: 13, lineHeight: 1.5, padding: "10px 12px", borderRadius: 10, background: "var(--c-srf)", color: "var(--c-high)", border: "1px solid var(--c-brd)", resize: "none", outline: "none" }}
            />
            <button onClick={onGenerate} disabled={!canGenerate}
              style={{ fontSize: 12.5, fontWeight: 600, padding: "9px 18px", borderRadius: 8, border: "none",
                cursor: canGenerate ? "pointer" : "default",
                background: "var(--c-high)", color: "var(--card)", opacity: canGenerate ? 1 : 0.45, flexShrink: 0 }}>
              {generating ? "Generating…" : editSource ? "Generate edit" : "Generate"}
            </button>
          </div>
          {error && <div style={{ fontSize: 12, color: "#e66" }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
