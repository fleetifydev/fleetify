/**
 * Downloadable-model browser for the local-Ollama settings card.
 *
 * Two ways to add a model:
 *   1. Curated rows — a baked list of popular Ollama-library models with
 *      capability chips (tools / thinking / vision / embedding) and a size
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
 *
 * Visual language deliberately mirrors the sibling provider cards: hairline
 * row separators (not filled boxes), a single green accent reserved for
 * "installed / running", and uniform muted capability chips — no rainbow.
 */
import { useEffect, useRef, useState } from "react";
import { Download, X, Trash2, ChevronDown } from "lucide-react";
import { providers as providersApi } from "@/lib/providers-api";
import { followLink } from "@/components/markdown-link";

type Cap = "tools" | "thinking" | "vision" | "embedding";

interface CuratedModel {
  name: string;
  blurb: string;
  caps: Cap[];
  sizes: string[];
}

// Baked curated catalog. These are real models from the Ollama library.
// Offline fallback while the remote catalog is unavailable.
const CURATED_LOCAL_MODELS: CuratedModel[] = [
  { name: "llama3.2", blurb: "Meta's compact general-purpose model", caps: ["tools"], sizes: ["1b", "3b"] },
  { name: "qwen3.5", blurb: "Alibaba's multimodal general-purpose model", caps: ["vision", "tools", "thinking"], sizes: ["0.8b", "2b", "4b", "9b", "27b"] },
  { name: "gemma4", blurb: "Google's multimodal reasoning model", caps: ["vision", "tools", "thinking"], sizes: ["e2b", "e4b", "12b", "26b", "31b"] },
  { name: "ministral-3", blurb: "Mistral's compact vision-language model family", caps: ["vision", "tools"], sizes: ["3b", "8b", "14b"] },
  { name: "qwen2.5-coder", blurb: "Compact Qwen models for coding", caps: ["tools"], sizes: ["0.5b", "1.5b"] },
  { name: "qwen3-coder", blurb: "Code-specialized Qwen with tool calling", caps: ["tools"], sizes: ["30b"] },
  { name: "gpt-oss", blurb: "OpenAI's open-weight reasoning model", caps: ["tools", "thinking"], sizes: ["20b", "120b"] },
  { name: "deepseek-r1", blurb: "Open reasoning model", caps: ["thinking"], sizes: ["1.5b", "7b", "8b", "14b", "32b"] },
  { name: "qwen3-vl", blurb: "Qwen model for understanding images and text", caps: ["vision", "tools", "thinking"], sizes: ["2b", "4b", "8b"] },
  { name: "nomic-embed-text", blurb: "Compact text embedding model", caps: ["embedding"], sizes: [] },
  { name: "qwen3-embedding", blurb: "Text embeddings for retrieval", caps: ["embedding"], sizes: ["0.6b", "4b", "8b"] },
];

/** Where the "Ollama library" link goes: every tag the free-text pull takes. */
const OLLAMA_LIBRARY_URL = "https://ollama.com/library";

const GREEN = "rgb(64,180,120)";

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

// appearance:none + custom chevron + explicit <option> colors — the native
// select value text ignores CSS `color` in WebKitGTK (Tauri/Linux), rendering
// invisible in dark themes. This styles around that.
const selectStyle: React.CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  padding: "5px 24px 5px 9px",
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
  padding: "5px 11px",
  borderRadius: 7,
  fontSize: 11.5,
  fontWeight: 500,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-med)",
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

/** Uniform, muted capability chip — same neutral treatment for every cap so
 *  the row stays scannable without a four-colour rainbow. */
function CapChip({ cap }: { cap: Cap }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: "var(--c-dim)",
        border: "1px solid var(--c-brd)",
        borderRadius: 4,
        padding: "1px 5px",
        lineHeight: 1.6,
        flexShrink: 0,
      }}
    >
      {cap}
    </span>
  );
}

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
  const [catalog, setCatalog] = useState(CURATED_LOCAL_MODELS);

  useEffect(() => {
    const controller = new AbortController();
    void providersApi.ollamaSuggestions(controller.signal).then((suggestions) => {
      if (controller.signal.aborted || suggestions.length === 0) return;
      const models = [...suggestions]
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .map((model): CuratedModel => {
          const caps: Cap[] = [];
          if (model.modalities?.input.includes("image")) caps.push("vision");
          if (model.tool_call) caps.push("tools");
          if (model.reasoning) caps.push("thinking");
          if (model.modalities?.output.includes("embedding")) caps.push("embedding");
          return { name: model.id, blurb: model.note ?? "", caps, sizes: model.tags ?? [] };
        });
      setCatalog(models);
    });
    return () => controller.abort();
  }, []);

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
  // Download. This is what makes the concurrency guard structural, not ad hoc.
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
              height: 5,
              borderRadius: 3,
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pulling.percent}%`,
                height: "100%",
                background: GREEN,
                transition: "width 0.2s",
              }}
            />
          </div>
          <span
            style={{
              fontSize: 10.5,
              color: "var(--c-dim)",
              minWidth: 66,
              textAlign: "right",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto", flexShrink: 0 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              fontWeight: 500,
              color: GREEN,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: GREEN }} />
            Installed
          </span>
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
        style={{ ...primaryBtn, marginLeft: "auto" }}
      >
        <Download size={11} /> Download
      </button>
    );
  }

  function renderError(target: string) {
    return errors[target] && (
      <div style={{ fontSize: 11, color: "rgb(248,113,113)", marginTop: 6 }}>
        {errors[target]}
      </div>
    );
  }

  const trimmed = freeText.trim();
  const rows = catalog.map((model) => {
    const previous = sizeSel[model.name];
    const size = previous && model.sizes.includes(previous) ? previous : (model.sizes[0] ?? "");
    const target = size ? `${model.name}:${size}` : model.name;
    return { model, size, target };
  });
  // A catalog refresh can remove a target while its pull is running or failed.
  const targetsOutsideRows = [...new Set([...Object.keys(pulls), ...Object.keys(errors)])].filter(
    (target) => target !== trimmed && !rows.some((row) => row.target === target),
  );

  return (
    <div style={{ padding: "14px 0 2px 0", borderTop: "1px solid var(--c-brd)" }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)" }}>Download a model</div>
      <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 3 }}>
        Pull a curated model below, or any tag from the{" "}
        <a
          href={OLLAMA_LIBRARY_URL}
          rel="noreferrer"
          onClick={(e) => followLink(e, OLLAMA_LIBRARY_URL)}
          style={{ color: "var(--c-low)" }}
        >
          Ollama library
        </a>
        .
      </div>

      {/* Curated rows — hairline separators, no filled boxes. */}
      <div style={{ marginTop: 6 }}>
        {rows.map(({ model: m, size, target }, i) => {
          const pulling = !!pulls[target];
          return (
            <div
              key={m.name}
              style={{
                padding: "10px 0",
                borderTop: i === 0 ? "none" : "1px solid var(--c-brd)",
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
                  <CapChip key={c} cap={c} />
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--c-low)", marginTop: 3 }}>{m.blurb}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                {m.sizes.length > 0 && !pulling && (
                  <div style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                    <select
                      aria-label={`Size for ${m.name}`}
                      value={size}
                      onChange={(e) => setSizeSel((s) => ({ ...s, [m.name]: e.target.value }))}
                      style={selectStyle}
                    >
                      {m.sizes.map((s) => (
                        <option key={s} value={s} style={{ background: "var(--c-srf)", color: "var(--c-high)" }}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={12}
                      style={{
                        position: "absolute",
                        right: 7,
                        top: "50%",
                        transform: "translateY(-50%)",
                        pointerEvents: "none",
                        color: "var(--c-dim)",
                      }}
                    />
                  </div>
                )}
                {renderAction(target)}
              </div>
              {renderError(target)}
            </div>
          );
        })}
        {targetsOutsideRows.map((target) => (
          <div key={target} style={{ padding: "10px 0", borderTop: "1px solid var(--c-brd)" }}>
            <div style={{ fontSize: 12, color: "var(--c-high)", fontFamily: "var(--font-mono, monospace)" }}>
              {target}
            </div>
            <div style={{ marginTop: 8 }}>{renderAction(target)}</div>
            {renderError(target)}
          </div>
        ))}
      </div>

      {/* Free-text pull — any model:tag, kept as a quiet affordance below the
          curated list rather than a second heavyweight section. */}
      <div style={{ marginTop: 4, paddingTop: 12, borderTop: "1px solid var(--c-brd)" }}>
        <div style={{ fontSize: 11.5, fontWeight: 500, color: "var(--c-med)", marginBottom: 6 }}>
          Pull any tag
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            aria-label="Model to pull"
            value={freeText}
            placeholder="model:tag — e.g. llama3.3:70b"
            onChange={(e) => setFreeText(e.target.value)}
            style={inputStyle}
          />
          {trimmed ? (
            renderAction(trimmed)
          ) : (
            <button
              type="button"
              aria-label="Download model"
              disabled
              style={{ ...primaryBtn, marginLeft: 0, opacity: 0.5, cursor: "default" }}
            >
              <Download size={11} /> Download
            </button>
          )}
        </div>
        {trimmed && renderError(trimmed)}
      </div>
    </div>
  );
}
