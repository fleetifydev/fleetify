/**
 * Settings → Voice — engine picker, language, BYOK provider/model/key.
 * Prefs live in localStorage (shared with use-voice-dictation).
 * BYOK keys are stored in the OS keychain via voice.setByokKey — never
 * returned to the renderer.
 */
import { useEffect, useState } from "react";
import { Cloud, HardDrive, KeyRound, Download, Check, Zap, Trash2, Loader2, X, ChevronDown } from "lucide-react";

import { voice, type VoiceEngine, type VoiceModel, type VoiceModelProgress } from "@/lib/voice-api";
import { getVoicePrefs, setVoicePref } from "@/hooks/use-voice-dictation";
import { useThemeStore } from "@/stores/theme-store";

// ── static data ───────────────────────────────────────────────────

const LANGS = [
  { code: "auto", label: "Auto-detect" },
  { code: "en",   label: "English" },
  { code: "tr",   label: "Türkçe" },
  { code: "de",   label: "Deutsch" },
  { code: "es",   label: "Español" },
  { code: "fr",   label: "Français" },
  { code: "it",   label: "Italiano" },
  { code: "pt",   label: "Português" },
  { code: "ru",   label: "Русский" },
  { code: "ar",   label: "العربية" },
  { code: "zh",   label: "中文" },
  { code: "ja",   label: "日本語" },
];

type ByokProvider = "groq" | "openai";

const BYOK_PROVIDERS: {
  id: ByokProvider;
  name: string;
  lightLogo: string;
  darkLogo: string;
  models: { value: string; label: string; desc: string }[];
}[] = [
  {
    id: "groq",
    name: "Groq",
    lightLogo: "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest/light/groq.png",
    darkLogo:  "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest/dark/groq.png",
    models: [
      { value: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo", desc: "Fast · multilingual" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    lightLogo: "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest/light/openai.png",
    darkLogo:  "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest/dark/openai.png",
    models: [
      { value: "gpt-4o-transcribe",      label: "gpt-4o-transcribe",      desc: "Best accuracy" },
      { value: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe", desc: "Faster · cheaper" },
    ],
  },
];

const ENGINES: { id: VoiceEngine; icon: typeof Cloud; title: string; desc: string }[] = [
  { id: "auto",   icon: Zap,       title: "Auto",           desc: "Cloud → key → on-device. Picks the best available." },
  { id: "broker", icon: Cloud,     title: "Fleetify cloud", desc: "Managed, zero setup. Daily quota." },
  { id: "byok",   icon: KeyRound,  title: "Your own key",   desc: "Groq or OpenAI. You pay the provider." },
  { id: "local",  icon: HardDrive, title: "On-device",      desc: "Offline, private, free. Downloads a Whisper model." },
];

// derive BYOK provider from model string
const modelToProvider = (m: string): ByokProvider => m.startsWith("gpt-") ? "openai" : "groq";

// ── component ────────────────────────────────────────────────────

export function VoiceSection() {
  const { theme } = useThemeStore();
  const isDark = theme === "dark";

  const initial = getVoicePrefs();
  const [engine,   setEngine]   = useState<VoiceEngine>(initial.engine);
  const [language, setLanguage] = useState(initial.language);
  const [model,    setModel]    = useState(initial.model || "whisper-large-v3-turbo");
  const [prompt,   setPrompt]   = useState(initial.prompt);

  const [localModels,    setLocalModels]    = useState<VoiceModel[]>([]);
  const [localSupported, setLocalSupported] = useState(true);
  const [downloading,    setDownloading]    = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<Record<string, string>>({});

  const [groqKey,       setGroqKey]       = useState("");
  const [openaiKey,     setOpenaiKey]     = useState("");
  const [groqPresent,   setGroqPresent]   = useState(false);
  const [openaiPresent, setOpenaiPresent] = useState(false);
  const [groqPreview,   setGroqPreview]   = useState<string | null>(
    () => { try { return localStorage.getItem("fleet.voice.byok.groq.preview"); } catch { return null; } }
  );
  const [openaiPreview, setOpenaiPreview] = useState<string | null>(
    () => { try { return localStorage.getItem("fleet.voice.byok.openai.preview"); } catch { return null; } }
  );
  const [editingKey,   setEditingKey]    = useState(false);
  const [keyFeedback,  setKeyFeedback]   = useState<string | null>(null);

  useEffect(() => { setVoicePref("engine",   engine);   }, [engine]);
  useEffect(() => { setVoicePref("language", language); }, [language]);
  useEffect(() => { setVoicePref("model",    model);    }, [model]);
  useEffect(() => { setVoicePref("prompt",   prompt);   }, [prompt]);

  useEffect(() => {
    voice.listModels().then((r) => { setLocalSupported(r.supported); setLocalModels(r.models); });
    voice.hasByokKey("groq").then((r)   => setGroqPresent(r.present));
    voice.hasByokKey("openai").then((r) => setOpenaiPresent(r.present));
    const off = voice.onModelProgress((p: VoiceModelProgress & { cancelled?: boolean }) => {
      if (p.cancelled) {
        setDownloading(null);
        setDownloadStatus((prev) => { const n = { ...prev }; delete n[p.id]; return n; });
        return;
      }
      if (p.done) {
        setDownloading(null);
        setDownloadStatus((prev) => { const n = { ...prev }; delete n[p.id]; return n; });
        voice.listModels().then((r) => setLocalModels(r.models));
        return;
      }
      const pct    = p.total > 0 ? Math.round((p.received / p.total) * 100) : 0;
      const mb     = (p.received / 1_048_576).toFixed(1);
      const totalS = p.total > 0 ? ` / ${(p.total / 1_048_576).toFixed(0)} MB` : "";
      setDownloadStatus((prev) => ({ ...prev, [p.id]: `${mb} MB${totalS}  (${pct}%)` }));
    });
    return () => off();
  }, []);

  const switchEngine = (e: VoiceEngine) => {
    setEngine(e);
    if (e === "broker") setModel("");
    else if (e === "byok") {
      if (!model.startsWith("gpt-") && !model.startsWith("whisper-")) setModel("whisper-large-v3-turbo");
    } else if (e === "local") {
      setModel(localModels.find((m) => m.downloaded)?.id ?? "large-v3-turbo");
    }
  };

  const switchByokProvider = (p: ByokProvider) => {
    const def = BYOK_PROVIDERS.find((x) => x.id === p)!;
    setModel(def.models[0]!.value);
    setEditingKey(false); // reset edit state when switching provider
  };

  const downloadModel = async (id: string) => {
    setDownloading(id);
    setDownloadStatus((prev) => ({ ...prev, [id]: "Starting…" }));
    const r = await voice.downloadModel(id);
    if (r.already) {
      setDownloading(null);
      setDownloadStatus((prev) => { const n = { ...prev }; delete n[id]; return n; });
      voice.listModels().then((x) => setLocalModels(x.models));
    } else if (!r.ok && r.code !== "CANCELLED") {
      setDownloading(null);
      setDownloadStatus((prev) => ({ ...prev, [id]: `✗ ${r.error ?? "Download failed"}` }));
      setTimeout(() => setDownloadStatus((prev) => { const n = { ...prev }; delete n[id]; return n; }), 3000);
      voice.listModels().then((x) => setLocalModels(x.models));
    }
  };

  const cancelDownload = () => { void voice.cancelDownload(); };

  const maskKey = (key: string) =>
    key.length <= 8 ? "••••••••" : key.slice(0, 6) + "••••" + key.slice(-4);

  const saveKey = async (provider: ByokProvider, key: string) => {
    const r = await voice.setByokKey(provider, key);
    if (!r.ok) return;
    const isGroq = provider === "groq";
    if (key) {
      const preview = maskKey(key);
      if (isGroq) { setGroqPresent(true);  setGroqPreview(preview);  setGroqKey("");
        try { localStorage.setItem("fleet.voice.byok.groq.preview", preview); } catch { /* ignore */ }
      } else      { setOpenaiPresent(true); setOpenaiPreview(preview); setOpenaiKey("");
        try { localStorage.setItem("fleet.voice.byok.openai.preview", preview); } catch { /* ignore */ }
      }
    } else {
      if (isGroq) { setGroqPresent(false);  setGroqPreview(null);
        try { localStorage.removeItem("fleet.voice.byok.groq.preview"); } catch { /* ignore */ }
      } else      { setOpenaiPresent(false); setOpenaiPreview(null);
        try { localStorage.removeItem("fleet.voice.byok.openai.preview"); } catch { /* ignore */ }
      }
    }
    setEditingKey(false);
    setKeyFeedback(key ? "Key saved" : "Key removed");
    setTimeout(() => setKeyFeedback(null), 2000);
  };

  // BYOK derived state
  const byokProvider = modelToProvider(model);
  const byokDef      = BYOK_PROVIDERS.find((p) => p.id === byokProvider)!;
  const keyPresent   = byokProvider === "groq" ? groqPresent   : openaiPresent;
  const keyPreview   = byokProvider === "groq" ? groqPreview   : openaiPreview;
  const keyValue     = byokProvider === "groq" ? groqKey       : openaiKey;
  const setKeyValue  = byokProvider === "groq" ? setGroqKey    : setOpenaiKey;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 580 }}>

      {/* Engine picker */}
      <Section label="Engine">
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {ENGINES.map((e) => {
            const Icon   = e.icon;
            const active = engine === e.id;
            return (
              <button key={e.id} onClick={() => switchEngine(e.id)} style={engineRow(active)}>
                <Icon size={14} style={{ flexShrink: 0, color: active ? "var(--c-high)" : "var(--c-dim)" }} />
                <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <span style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: "var(--c-high)" }}>
                    {e.title}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--c-dim)", marginLeft: 8 }}>{e.desc}</span>
                </div>
                {active && <Check size={13} style={{ color: "var(--c-accent, var(--c-high))", flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      </Section>

      {/* Language. A native <select> in WebKitGTK (Tauri/Linux) draws its value
          text in the GTK system theme and ignores CSS `color`, so it was barely
          legible in dark mode. `appearance: none` makes WebKit render the control
          itself so it honours `color`/`background`; the native arrow goes with it,
          so we overlay a <ChevronDown>, and each <option> gets explicit colours
          for the open list. */}
      <Section label="Language">
        <div style={{ position: "relative" }}>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            style={{ ...selectSt, appearance: "none", WebkitAppearance: "none", paddingRight: 30, cursor: "pointer" }}
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code} style={{ background: "var(--c-srf)", color: "var(--c-high)" }}>
                {l.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={14}
            style={{
              position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
              pointerEvents: "none", color: "var(--c-dim)",
            }}
          />
        </div>
      </Section>

      {/* ── BYOK ─────────────────────────────────────────────── */}
      {engine === "byok" && (
        <>
          {/* Provider tiles */}
          <Section label="Provider">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {BYOK_PROVIDERS.map((p) => {
                const active = byokProvider === p.id;
                const logo   = isDark ? p.darkLogo : p.lightLogo;
                return (
                  <button key={p.id} onClick={() => switchByokProvider(p.id)} style={providerTile(active)}>
                    <img
                      src={logo}
                      alt={p.name}
                      width={22} height={22}
                      style={{ borderRadius: 5, objectFit: "contain" }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--c-high)" }}>{p.name}</span>
                    {active && <Check size={12} style={{ marginLeft: "auto", color: "var(--c-accent, var(--c-high))" }} />}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Model list for selected provider */}
          <Section label="Model">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {byokDef.models.map((m) => {
                const active = model === m.value;
                return (
                  <button key={m.value} onClick={() => setModel(m.value)} style={modelTile(active)}>
                    <div style={{
                      width: 14, height: 14, borderRadius: "50%", flexShrink: 0,
                      border: `1.5px solid ${active ? "var(--c-accent, var(--c-high))" : "var(--c-brd)"}`,
                      background: active ? "var(--c-accent, var(--c-high))" : "transparent",
                    }} />
                    <span style={{ fontSize: 12.5, color: "var(--c-high)", flex: 1, textAlign: "left" }}>
                      {m.label}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>{m.desc}</span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* API key */}
          <Section label={`${byokDef.name} API key`}>
            {keyPresent && !editingKey ? (
              /* Saved view — masked preview + Edit */
              <div style={keyRow}>
                <span style={{
                  fontFamily: "var(--font-mono, monospace)", fontSize: 12.5,
                  color: "var(--c-high)", flex: 1, letterSpacing: 0.5,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {keyPreview ?? "••••••••••••••••"}
                </span>
                <button onClick={() => setEditingKey(true)} style={ghostBtn}>Edit</button>
                <button onClick={() => void saveKey(byokProvider, "")} style={dangerBtn}>
                  <Trash2 size={11} /> Remove
                </button>
              </div>
            ) : (
              /* Input view — new key or replacing existing */
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {keyPresent && editingKey && (
                  <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>
                    Replacing <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--c-high)" }}>
                      {keyPreview}
                    </span>
                  </span>
                )}
                <div style={keyRow}>
                  <input
                    type="password"
                    value={keyValue}
                    onChange={(e) => setKeyValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && keyValue) void saveKey(byokProvider, keyValue); }}
                    placeholder={`Paste ${byokDef.name} API key…`}
                    autoFocus={editingKey}
                    style={{
                      flex: 1, background: "none", border: "none", outline: "none",
                      color: "var(--c-high)", fontSize: 12.5, fontFamily: "inherit",
                    }}
                  />
                  <button
                    onClick={() => { if (keyValue) void saveKey(byokProvider, keyValue); }}
                    disabled={!keyValue}
                    style={saveBtn(!keyValue)}
                  >
                    Save
                  </button>
                  {editingKey && (
                    <button onClick={() => { setEditingKey(false); setKeyValue(""); }} style={ghostBtn}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}
            {keyFeedback && (
              <span style={{ fontSize: 11.5, color: "rgb(72 199 142)" }}>{keyFeedback}</span>
            )}
          </Section>
        </>
      )}

      {/* ── Local models ────────────────────────────────────── */}
      {engine === "local" && (
        <Section label="On-device model">
          {!localSupported ? (
            <p style={noteSt}>
              This build was compiled without the local Whisper engine.
              Use Fleetify cloud or your own key.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {localModels.map((m) => {
                const isDownloading = downloading === m.id;
                const active        = model === m.id && m.downloaded;
                const status        = downloadStatus[m.id];
                const isError       = status?.startsWith("✗");
                const isCancel      = status === "✗ Cancelled";
                return (
                  <div key={m.id} style={localRow}>
                    {/* Radio dot */}
                    <button
                      onClick={() => m.downloaded && setModel(m.id)}
                      disabled={!m.downloaded}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, flex: 1,
                        background: "none", border: "none", outline: "none",
                        cursor: m.downloaded ? "pointer" : "default",
                        fontFamily: "inherit", textAlign: "left", minWidth: 0,
                      }}
                    >
                      <div style={{
                        width: 14, height: 14, borderRadius: "50%", flexShrink: 0,
                        border: `1.5px solid ${active ? "var(--c-accent, var(--c-high))" : "var(--c-brd)"}`,
                        background: active ? "var(--c-accent, var(--c-high))" : "transparent",
                      }} />
                      <span style={{ fontSize: 12.5, color: "var(--c-high)", flex: 1, minWidth: 0 }}>{m.name}</span>
                    </button>

                    {/* Right side: status or size or actions */}
                    {isDownloading && status ? (
                      /* Downloading: spinner + progress text + Cancel */
                      <>
                        <Loader2 size={11} style={{ color: "var(--c-dim)", animation: "spin 1s linear infinite", flexShrink: 0 }} />
                        <span style={{
                          fontSize: 11, fontFamily: "var(--font-mono, monospace)",
                          color: isError || isCancel ? "rgb(239 68 68)" : "var(--c-dim)",
                          whiteSpace: "nowrap",
                        }}>
                          {status}
                        </span>
                        <button onClick={cancelDownload} style={{ ...dangerBtn, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3 }}>
                          <X size={9} strokeWidth={2.5} /> Cancel
                        </button>
                      </>
                    ) : status ? (
                      /* Post-download status (error / cancelled) — fades out */
                      <span style={{
                        fontSize: 11, fontFamily: "var(--font-mono, monospace)",
                        color: "rgb(239 68 68)", whiteSpace: "nowrap",
                      }}>
                        {status}
                      </span>
                    ) : !m.downloaded ? (
                      /* Not yet downloaded */
                      <>
                        <span style={{ fontSize: 11, color: "var(--c-dim)" }}>{m.size_mb} MB</span>
                        <button onClick={() => downloadModel(m.id)} style={ghostBtn}>
                          <Download size={11} /> Download
                        </button>
                      </>
                    ) : (
                      /* Downloaded — show size */
                      <span style={{ fontSize: 11, color: "var(--c-dim)" }}>{m.size_mb} MB</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* Vocabulary hint */}
      <Section label="Vocabulary hint">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Names or jargon to bias recognition — e.g. Fleetify, Tauri, Kubernetes…"
          rows={2}
          style={{ ...selectSt, resize: "vertical", fontFamily: "inherit" }}
        />
      </Section>

      <p style={noteSt}>
        {engine === "local"
          ? "Audio stays on your device — nothing is uploaded."
          : engine === "broker"
            ? "Audio is sent to Fleetify's server, forwarded to the provider, and not stored."
            : engine === "byok"
              ? `Audio is sent directly to ${byokDef.name} using your key.`
              : "Picks the best available engine at transcription time."}
      </p>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: 0.7,
        textTransform: "uppercase", color: "var(--c-dim)",
      }}>
        {label}
      </span>
      {children}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────

const engineRow = (active: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10, width: "100%",
  padding: "9px 11px", borderRadius: 8,
  background: active ? "var(--c-srf)" : "transparent",
  border: `1px solid ${active ? "var(--c-high)" : "var(--c-brd)"}`,
  cursor: "pointer", fontFamily: "inherit",
  transition: "border-color 0.12s",
});

const providerTile = (active: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10,
  padding: "11px 14px", borderRadius: 9,
  background: active ? "var(--c-srf)" : "transparent",
  border: `1px solid ${active ? "var(--c-high)" : "var(--c-brd)"}`,
  cursor: "pointer", fontFamily: "inherit",
  transition: "border-color 0.12s",
});

const modelTile = (active: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10, width: "100%",
  padding: "8px 11px", borderRadius: 7,
  background: active ? "var(--c-srf)" : "transparent",
  border: `1px solid ${active ? "var(--c-brd)" : "transparent"}`,
  cursor: "pointer", fontFamily: "inherit",
  transition: "background 0.1s",
});

const localRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  padding: "8px 11px", borderRadius: 7,
  background: "var(--c-srf)", border: "1px solid var(--c-brd)",
};

const keyRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "9px 12px", borderRadius: 8,
  background: "var(--c-srf)", border: "1px solid var(--c-brd)",
};

const selectSt: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 7,
  background: "var(--c-srf)", border: "1px solid var(--c-brd)",
  color: "var(--c-high)", fontSize: 12.5, outline: "none", fontFamily: "inherit",
};

const ghostBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  height: 24, padding: "0 9px", borderRadius: 5, flexShrink: 0,
  fontSize: 11.5, fontWeight: 500,
  background: "transparent", border: "1px solid var(--c-brd)",
  color: "var(--c-low)", cursor: "pointer", fontFamily: "inherit",
};

const dangerBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  height: 24, padding: "0 9px", borderRadius: 5, flexShrink: 0,
  fontSize: 11.5, fontWeight: 500,
  background: "transparent", border: "none",
  color: "rgb(239 68 68)", cursor: "pointer", fontFamily: "inherit",
};

const saveBtn = (disabled: boolean): React.CSSProperties => ({
  height: 26, padding: "0 12px", borderRadius: 6, flexShrink: 0,
  fontSize: 12, fontWeight: 600,
  background: disabled ? "transparent" : "var(--c-high)",
  border: `1px solid ${disabled ? "var(--c-brd)" : "var(--c-high)"}`,
  color: disabled ? "var(--c-dim)" : "var(--c-bg, #000)",
  cursor: disabled ? "default" : "pointer",
  fontFamily: "inherit",
  transition: "background 0.12s",
});

const noteSt: React.CSSProperties = {
  fontSize: 11.5, color: "var(--c-dim)", lineHeight: 1.6, margin: 0,
};
