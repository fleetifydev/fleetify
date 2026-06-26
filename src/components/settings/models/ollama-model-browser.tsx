/**
 * Downloadable-model browser for the local-Ollama settings card.
 *
 * Two ways to add a model:
 *   1. Curated cards — a baked list of popular Ollama-library models with
 *      capability badges (tools / thinking / vision / embedding) and a size
 *      picker. Download pulls `name:size` (or the bare `name` when a model
 *      has no size variants, e.g. an embedding model).
 *   2. Free-text box — pull any `model:tag` the user types.
 *
 * Pull progress is streamed: we subscribe ONCE to `onOllamaPullProgress`
 * and keep a `pulls` map keyed by the exact pull target. The terminal
 * outcome of a pull rides the progress stream (status === "success" or an
 * `error` line), NOT the `ollamaPull` return value — that return only
 * confirms the pull *started*.
 *
 * Concurrency guard (Task 9 mitigation): the backend's cancel-map keys by
 * model name, so two simultaneous pulls of the same model corrupt the
 * cancel flag. Every Download/Delete control is rendered through one
 * `renderAction(target)` helper keyed by the exact target, so once a target
 * is in flight EVERY place that would start it again shows progress + Cancel
 * instead of a second Download.
 */
import { useEffect, useRef, useState } from "react";
import { Download, X, Trash2 } from "lucide-react";
import { providers as providersApi } from "@/lib/providers-api";

type Cap = "tools" | "thinking" | "vision" | "embedding";

interface CuratedModel {
  name: string;
  blurb: string;
  caps: Cap[];
  sizes: string[];
}

// Baked curated catalog. These are real models from the Ollama library.
// TODO: source from remote catalog (keep the free-text box either way so any
// `model:tag` remains pullable).
const CURATED_LOCAL_MODELS: CuratedModel[] = [
  { name: "llama3.2", blurb: "Meta's compact general-purpose model", caps: ["tools"], sizes: ["1b", "3b"] },
  { name: "llama3.1", blurb: "Meta's flagship general model", caps: ["tools"], sizes: ["8b", "70b"] },
  { name: "qwen2.5", blurb: "Alibaba's multilingual general model", caps: ["tools"], sizes: ["0.5b", "1.5b", "3b", "7b", "14b", "32b"] },
  { name: "qwen2.5-coder", blurb: "Code-specialized Qwen2.5", caps: ["tools"], sizes: ["1.5b", "7b", "14b", "32b"] },
  { name: "gemma2", blurb: "Google's open general model", caps: [], sizes: ["2b", "9b", "27b"] },
  { name: "phi3.5", blurb: "Microsoft's small high-quality model", caps: [], sizes: ["3.8b"] },
  { name: "mistral", blurb: "Mistral 7B general model", caps: ["tools"], sizes: ["7b"] },
  { name: "deepseek-r1", blurb: "Open reasoning model", caps: ["thinking"], sizes: ["1.5b", "7b", "8b", "14b", "32b", "70b"] },
  { name: "llava", blurb: "Vision-language multimodal model", caps: ["vision"], sizes: ["7b", "13b", "34b"] },
  { name: "nomic-embed-text", blurb: "High-quality text embeddings", caps: ["embedding"], sizes: [] },
];

const CAP_COLOR: Record<Cap, string> = {
  tools: "rgb(96,165,250)",
  thinking: "rgb(167,139,250)",
  vision: "rgb(251,191,36)",
  embedding: "rgb(45,212,191)",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  padding: "7px 10px",
  fontSize: 12.5,
  color: "var(--c-high)",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  padding: "5px 8px",
  fontSize: 11.5,
  color: "var(--c-high)",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  outline: "none",
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  padding: "5px 10px",
  borderRadius: 7,
  fontSize: 11.5,
  fontWeight: 500,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  flexShrink: 0,
};

const primaryBtn: React.CSSProperties = {
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  padding: "5px 12px",
  borderRadius: 7,
  fontSize: 11.5,
  fontWeight: 600,
  background: "var(--c-high)",
  border: "none",
  color: "var(--card)",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  flexShrink: 0,
};

/** True when an exact pull target is already installed. Ollama stores a
 *  bare-name pull as `name:latest`, so a target with no tag also matches
 *  its `:latest` form. */
function isInstalledTarget(target: string, installed: string[]): boolean {
  if (installed.includes(target)) return true;
  if (!target.includes(":") && installed.includes(`${target}:latest`)) return true;
  return false;
}

export function OllamaModelBrowser({
  baseUrl,
  installed,
  onChanged,
}: {
  baseUrl: string | null;
  installed: string[];
  onChanged: () => void;
}) {
  // Pull state keyed by the exact target (e.g. "qwen2.5:7b"). Presence ⇒
  // in flight; the bar reads `.percent`.
  const [pulls, setPulls] = useState<Record<string, { percent: number; status: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sizeSel, setSizeSel] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");

  // Keep the latest onChanged reachable from the once-subscribed progress
  // callback without re-subscribing on every render.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  // Subscribe ONCE; unsubscribe on unmount. Terminal success/failure of a
  // pull arrives here, not from the ollamaPull() return value.
  useEffect(() => {
    const unsub = providersApi.onOllamaPullProgress((e) => {
      const model = e.model;
      if (!model) return;
      // Terminal failure — surface the error and drop the in-flight entry.
      if (e.error) {
        setPulls((p) => {
          const next = { ...p };
          delete next[model];
          return next;
        });
        setErrors((er) => ({ ...er, [model]: e.error as string }));
        return;
      }
      // Terminal success — clear and re-probe so the new model shows up.
      if (e.status === "success") {
        setPulls((p) => {
          const next = { ...p };
          delete next[model];
          return next;
        });
        setErrors((er) => {
          const next = { ...er };
          delete next[model];
          return next;
        });
        onChangedRef.current();
        return;
      }
      // Progress update. `percent` can be absent early; derive it from
      // completed/total when possible, else hold the last known value.
      const pct =
        typeof e.percent === "number"
          ? e.percent
          : e.total && e.total > 0 && typeof e.completed === "number"
            ? Math.round((e.completed / e.total) * 100)
            : undefined;
      setPulls((p) => ({
        ...p,
        [model]: { percent: pct ?? p[model]?.percent ?? 0, status: e.status || "pulling" },
      }));
    });
    return unsub;
  }, []);

  async function startPull(target: string) {
    if (!target || pulls[target]) return; // already in flight — no double start
    setErrors((e) => {
      const next = { ...e };
      delete next[target];
      return next;
    });
    // Optimistically mark in flight so concurrent Download controls for the
    // same target flip to Cancel immediately (before the first event).
    setPulls((p) => ({ ...p, [target]: { percent: 0, status: "starting" } }));
    const r = await providersApi.ollamaPull(target, baseUrl);
    if (!r.ok) {
      setPulls((p) => {
        const next = { ...p };
        delete next[target];
        return next;
      });
      setErrors((e) => ({ ...e, [target]: r.error || "Failed to start pull" }));
    }
  }

  async function cancelPull(target: string) {
    await providersApi.ollamaPullCancel(target);
    setPulls((p) => {
      const next = { ...p };
      delete next[target];
      return next;
    });
  }

  async function deleteModel(target: string) {
    const r = await providersApi.ollamaDelete(target, baseUrl);
    if (r.ok) {
      onChanged();
    } else {
      setErrors((e) => ({
        ...e,
        [target]: r.code === "NOT_FOUND" ? "Already gone" : r.error || "Delete failed",
      }));
    }
  }

  // One control surface per target. A target in `pulls` shows progress +
  // Cancel (never a second Download); an installed target shows Delete; else
  // Download. This is what makes resolution 3 structural rather than ad hoc.
  function renderAction(target: string) {
    const pulling = pulls[target];
    if (pulling) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <div
            role="progressbar"
            aria-valuenow={pulling.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Pulling ${target}`}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 4,
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pulling.percent}%`,
                height: "100%",
                background: "var(--c-high)",
                transition: "width 0.2s",
              }}
            />
          </div>
          <span
            style={{
              fontSize: 10.5,
              color: "var(--c-dim)",
              minWidth: 72,
              textAlign: "right",
              whiteSpace: "nowrap",
            }}
          >
            {pulling.status} {pulling.percent}%
          </span>
          <button
            type="button"
            aria-label={`Cancel ${target}`}
            onClick={() => void cancelPull(target)}
            style={ghostBtn}
          >
            <X size={11} /> Cancel
          </button>
        </div>
      );
    }
    if (isInstalledTarget(target, installed)) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "rgb(64,180,120)" }}>Installed ✓</span>
          <button
            type="button"
            aria-label={`Delete ${target}`}
            onClick={() => void deleteModel(target)}
            style={ghostBtn}
          >
            <Trash2 size={11} /> Delete
          </button>
        </div>
      );
    }
    return (
      <button
        type="button"
        aria-label={`Download ${target}`}
        onClick={() => void startPull(target)}
        style={primaryBtn}
      >
        <Download size={11} /> Download
      </button>
    );
  }

  const trimmed = freeText.trim();

  return (
    <div style={{ padding: "12px 0 4px 0", borderTop: "1px solid var(--c-brd)" }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 8 }}>
        Download a model
      </div>

      {/* Curated cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {CURATED_LOCAL_MODELS.map((m) => {
          const hasSizes = m.sizes.length > 0;
          const sel = sizeSel[m.name] ?? m.sizes[0] ?? "";
          const target = hasSizes ? `${m.name}:${sel}` : m.name;
          return (
            <div
              key={m.name}
              style={{
                border: "1px solid var(--c-brd)",
                borderRadius: 8,
                padding: "9px 11px",
                background: "var(--c-srf)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--c-high)",
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                >
                  {m.name}
                </span>
                {m.caps.map((c) => (
                  <span
                    key={c}
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: 0.3,
                      textTransform: "uppercase",
                      color: CAP_COLOR[c],
                      border: `1px solid ${CAP_COLOR[c]}`,
                      borderRadius: 5,
                      padding: "0px 5px",
                      opacity: 0.9,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--c-low)", marginTop: 3 }}>{m.blurb}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                {hasSizes && (
                  <select
                    aria-label={`Size for ${m.name}`}
                    value={sel}
                    onChange={(e) =>
                      setSizeSel((s) => ({ ...s, [m.name]: e.target.value }))
                    }
                    style={selectStyle}
                  >
                    {m.sizes.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
                {renderAction(target)}
              </div>
              {errors[target] && (
                <div style={{ fontSize: 11, color: "rgb(248,113,113)", marginTop: 6 }}>
                  {errors[target]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Free-text pull box — any model:tag from the Ollama library. */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 6 }}>
          Pull any model
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            aria-label="Model to pull"
            value={freeText}
            placeholder="model:tag (e.g. llama3.3:70b)"
            onChange={(e) => setFreeText(e.target.value)}
            style={inputStyle}
          />
          {trimmed ? (
            renderAction(trimmed)
          ) : (
            <button type="button" aria-label="Download model" disabled style={{ ...primaryBtn, opacity: 0.5, cursor: "default" }}>
              <Download size={11} /> Download
            </button>
          )}
        </div>
        {trimmed && errors[trimmed] && (
          <div style={{ fontSize: 11, color: "rgb(248,113,113)", marginTop: 6 }}>
            {errors[trimmed]}
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 6 }}>
          Any model from the{" "}
          <a
            href="https://ollama.com/library"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--c-low)" }}
          >
            Ollama library
          </a>
          , e.g. <code>mistral-nemo:12b</code>.
        </div>
      </div>
    </div>
  );
}
