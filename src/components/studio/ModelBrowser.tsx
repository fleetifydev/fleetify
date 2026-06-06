import { useEffect, useState, useCallback } from "react";
import { studioApi, type HfModel, type HfModelDetail } from "@/lib/studio-api";

type MediaTab = "image" | "video";

export function ModelBrowser() {
  const [tab, setTab] = useState<MediaTab>("image");
  const [models, setModels] = useState<HfModel[] | null>(null);
  const [selected, setSelected] = useState<HfModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(async (t: MediaTab) => {
    setModels(null); setSelected(null); setError(null);
    try { setModels(await studioApi.listModels(t)); }
    catch (e) { setError(String(e)); setModels([]); }
  }, []);

  useEffect(() => { void loadModels(tab); }, [tab, loadModels]);

  const openModel = useCallback(async (id: string) => {
    setSelected(null);
    try { setSelected(await studioApi.getModel(id)); }
    catch (e) { setError(String(e)); }
  }, []);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {(["image", "video"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "4px 12px", borderRadius: 5, fontSize: 12,
            border: "1px solid var(--c-brd)",
            background: tab === t ? "var(--c-srf2)" : "transparent",
            color: tab === t ? "var(--c-high)" : "var(--c-med)", cursor: "pointer",
          }}>{t === "image" ? "Image" : "Video"}</button>
        ))}
      </div>
      {error && <div style={{ fontSize: 12, color: "#e66" }}>{error}</div>}
      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ flex: "0 0 240px", display: "flex", flexDirection: "column", gap: 4 }}>
          {models === null ? (
            <div style={{ fontSize: 12, color: "var(--c-dim)" }}>Loading…</div>
          ) : models.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--c-dim)" }}>No models.</div>
          ) : models.map(m => (
            <button key={m.job_set_type} onClick={() => void openModel(m.job_set_type)} style={{
              textAlign: "left", padding: "6px 10px", borderRadius: 5, fontSize: 12.5,
              border: "1px solid transparent",
              background: selected?.job_set_type === m.job_set_type ? "var(--c-srf2)" : "var(--c-srf)",
              color: "var(--c-high)", cursor: "pointer",
            }}>{m.display_name}</button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--c-high)" }}>{selected.display_name}</div>
              <div style={{ fontSize: 11, color: "var(--c-dim)", marginBottom: 10 }}>{selected.job_set_type} · {selected.type}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {selected.params.map(p => (
                  <div key={p.name} style={{ fontSize: 12, color: "var(--c-med)" }}>
                    <span style={{ color: "var(--c-high)", fontWeight: 500 }}>{p.name}</span>
                    <span style={{ color: "var(--c-dim)" }}> · {p.type}{p.required ? " · required" : ""}</span>
                    {p.enum && <div style={{ fontSize: 11, color: "var(--c-dim)" }}>options: {p.enum.map(String).join(", ")}</div>}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--c-dim)" }}>Select a model to see its parameters.</div>
          )}
        </div>
      </div>
    </div>
  );
}
