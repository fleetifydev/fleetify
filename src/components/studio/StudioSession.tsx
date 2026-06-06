import { useEffect, useState, useCallback } from "react";
import { studioApi, type HfModel, type HfModelParam } from "@/lib/studio-api";

interface Block { type: string; text?: string; artifact_type?: string; content?: string; }
interface GenAsset { url: string; kind: "image" | "video"; }
interface GenItem { prompt: string; assets: GenAsset[]; }
type Media = "image" | "video";

const fieldStyle: React.CSSProperties = {
  fontSize: 12, padding: "5px 8px", borderRadius: 6,
  background: "var(--c-srf)", color: "var(--c-high)", border: "1px solid var(--c-brd)",
};

export function StudioSession({ sessionId }: { sessionId: string }) {
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

  useEffect(() => {
    let cancelled = false;
    void studioApi.listModels(media).then(ms => {
      if (cancelled) return;
      setModels(ms);
      setModel(ms[0]?.job_set_type ?? "");
    }).catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [media]);

  useEffect(() => {
    if (!model) { setParams([]); setValues({}); return; }
    let cancelled = false;
    void studioApi.getModel(model).then(d => {
      if (cancelled) return;
      const ps = (d?.params ?? []).filter(p => p.name !== "prompt" && ["string", "number", "integer"].includes(p.type));
      setParams(ps);
      const seed: Record<string, string> = {};
      for (const p of ps) if (p.default != null && typeof p.default !== "object") seed[p.name] = String(p.default);
      setValues(seed);
    }).catch(() => { if (!cancelled) { setParams([]); setValues({}); } });
    return () => { cancelled = true; };
  }, [model]);

  const buildParams = useCallback((): Record<string, unknown> => {
    const out: Record<string, unknown> = { prompt };
    for (const p of params) {
      const v = values[p.name];
      if (v != null && v !== "") out[p.name] = v;
    }
    return out;
  }, [prompt, params, values]);

  useEffect(() => {
    if (!model || !prompt.trim()) { setCost(null); return; }
    const id = setTimeout(() => {
      void studioApi.cost(model, buildParams()).then(c => setCost(c.credits)).catch(() => setCost(null));
    }, 600);
    return () => clearTimeout(id);
  }, [model, prompt, buildParams]);

  const loadGallery = useCallback(async () => {
    try {
      const msgs = await studioApi.listMessages(sessionId);
      const items: GenItem[] = [];
      let pending = "";
      for (const msg of msgs) {
        let blocks: Block[] = [];
        try { blocks = JSON.parse(msg.content) as Block[]; } catch { continue; }
        if (msg.role === "user") {
          pending = blocks.find(b => b.type === "text")?.text ?? "";
        } else {
          const assets: GenAsset[] = blocks
            .filter(b => b.type === "artifact" && b.content && (b.artifact_type === "image" || b.artifact_type === "video"))
            .map(b => ({ url: b.content as string, kind: b.artifact_type === "video" ? "video" : "image" }));
          if (assets.length) { items.push({ prompt: pending, assets }); pending = ""; }
        }
      }
      setGallery(items.reverse());
    } catch { /* noop */ }
  }, [sessionId]);

  useEffect(() => { void loadGallery(); }, [loadGallery]);

  const generate = useCallback(async () => {
    if (!model || !prompt.trim() || generating) return;
    setGenerating(true); setError(null);
    try {
      await studioApi.generate(sessionId, model, buildParams());
      setPrompt("");
      await loadGallery();
    } catch (e) { setError(String(e)); }
    finally { setGenerating(false); }
  }, [model, prompt, generating, sessionId, loadGallery, buildParams]);

  const fileName = (url: string) => url.split("/").pop()?.split("?")[0] || "asset";

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 24, background: "var(--card)" }}>
      <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["image", "video"] as const).map(t => (
            <button key={t} onClick={() => setMedia(t)} style={{
              padding: "4px 12px", borderRadius: 5, fontSize: 12, border: "1px solid var(--c-brd)",
              background: media === t ? "var(--c-srf2)" : "transparent",
              color: media === t ? "var(--c-high)" : "var(--c-med)", cursor: "pointer",
            }}>{t === "image" ? "Image" : "Video"}</button>
          ))}
        </div>
        <select aria-label="Model" value={model} onChange={e => setModel(e.target.value)} style={{ ...fieldStyle, maxWidth: 280 }}>
          {models.map(m => <option key={m.job_set_type} value={m.job_set_type}>{m.display_name}</option>)}
        </select>
        {params.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {params.map(p => (
              <label key={p.name} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5, color: "var(--c-med)" }}>
                <span>{p.name}{p.required ? " *" : ""}</span>
                {p.enum && p.enum.length > 0 ? (
                  <select aria-label={p.name} value={values[p.name] ?? ""} onChange={e => setValues(v => ({ ...v, [p.name]: e.target.value }))} style={fieldStyle}>
                    {p.enum.map((opt, i) => <option key={i} value={String(opt)}>{String(opt)}</option>)}
                  </select>
                ) : (
                  <input aria-label={p.name} type={["number", "integer"].includes(p.type) ? "number" : "text"}
                    value={values[p.name] ?? ""} onChange={e => setValues(v => ({ ...v, [p.name]: e.target.value }))} style={fieldStyle} />
                )}
              </label>
            ))}
          </div>
        )}
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe what to generate…" rows={3}
          style={{ fontSize: 13, padding: 10, borderRadius: 8, background: "var(--c-srf)", color: "var(--c-high)", border: "1px solid var(--c-brd)", resize: "vertical" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => void generate()} disabled={generating || !prompt.trim() || !model}
            style={{ fontSize: 12.5, fontWeight: 600, padding: "7px 16px", borderRadius: 6, border: "none",
              cursor: generating || !prompt.trim() || !model ? "default" : "pointer",
              background: "var(--c-high)", color: "var(--card)", opacity: generating || !prompt.trim() || !model ? 0.5 : 1 }}>
            {generating ? "Generating…" : "Generate"}
          </button>
          {cost != null && <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>~{cost} credits</span>}
        </div>
        {error && <div style={{ fontSize: 12, color: "#e66" }}>{error}</div>}
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 18 }}>
          {gallery.length === 0 && !generating && <div style={{ fontSize: 12, color: "var(--c-dim)" }}>No generations yet.</div>}
          {gallery.map((g, i) => (
            <div key={i}>
              {g.prompt && <div style={{ fontSize: 12, color: "var(--c-med)", marginBottom: 6 }}>{g.prompt}</div>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {g.assets.map((a, j) => (
                  <div key={j} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {a.kind === "video"
                      ? <video controls src={a.url} style={{ maxWidth: 320, maxHeight: 320, borderRadius: 8, border: "1px solid var(--c-brd)" }} />
                      : <img src={a.url} alt="Generated image" style={{ maxWidth: 320, maxHeight: 320, borderRadius: 8, border: "1px solid var(--c-brd)" }} />}
                    <a href={a.url} download={fileName(a.url)} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--c-dim)", textDecoration: "none" }}>Download</a>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
