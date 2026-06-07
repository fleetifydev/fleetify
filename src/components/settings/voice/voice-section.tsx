/**
 * Settings → Voice — dictation engine, language, model + key management.
 *
 * Engine prefs live in localStorage (shared with `use-voice-dictation`),
 * so the mic button picks them up with no extra plumbing. The BYOK API
 * key is written to the OS keychain via `voice.setByokKey` and never
 * round-trips back to the renderer.
 */
import { useEffect, useState } from "react";
import { Cloud, HardDrive, KeyRound, Download, Check, Loader2 } from "lucide-react";

import { voice, type VoiceEngine, type VoiceModel } from "@/lib/voice-api";
import { getVoicePrefs, setVoicePref } from "@/hooks/use-voice-dictation";

const LANGS: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect (all languages)" },
  { code: "en", label: "English" },
  { code: "tr", label: "Türkçe" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
];

const BYOK_MODELS: { value: string; label: string }[] = [
  { value: "whisper-large-v3-turbo", label: "Groq · whisper-large-v3-turbo (cheap, multilingual)" },
  { value: "gpt-4o-transcribe", label: "OpenAI · gpt-4o-transcribe (best accuracy)" },
  { value: "gpt-4o-mini-transcribe", label: "OpenAI · gpt-4o-mini-transcribe" },
];

const ENGINES: { id: VoiceEngine; icon: typeof Cloud; title: string; desc: string }[] = [
  { id: "local", icon: HardDrive, title: "On-device", desc: "Offline, private, free. Downloads a Whisper model." },
  { id: "broker", icon: Cloud, title: "Fleetify cloud", desc: "Managed, zero setup. Daily quota; signed-in." },
  { id: "byok", icon: KeyRound, title: "Your own key", desc: "Groq / OpenAI key. You pay the provider." },
];

export function VoiceSection() {
  const initial = getVoicePrefs();
  const [engine, setEngine] = useState<VoiceEngine>(initial.engine);
  const [language, setLanguage] = useState(initial.language);
  const [model, setModel] = useState(initial.model);
  const [prompt, setPrompt] = useState(initial.prompt);

  const [models, setModels] = useState<VoiceModel[]>([]);
  const [localSupported, setLocalSupported] = useState(true);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState<string | null>(null);

  const [groqKey, setGroqKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [groqPresent, setGroqPresent] = useState(false);
  const [openaiPresent, setOpenaiPresent] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Persist prefs as they change.
  useEffect(() => { setVoicePref("engine", engine); }, [engine]);
  useEffect(() => { setVoicePref("language", language); }, [language]);
  useEffect(() => { setVoicePref("model", model); }, [model]);
  useEffect(() => { setVoicePref("prompt", prompt); }, [prompt]);

  // Load local models + BYOK key presence; subscribe to download progress.
  useEffect(() => {
    voice.listModels().then((r) => { setLocalSupported(r.supported); setModels(r.models); });
    voice.hasByokKey("groq").then((r) => setGroqPresent(r.present));
    voice.hasByokKey("openai").then((r) => setOpenaiPresent(r.present));
    const off = voice.onModelProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p.total > 0 ? p.received / p.total : 0 }));
      if (p.done) {
        setDownloading(null);
        voice.listModels().then((r) => setModels(r.models));
      }
    });
    return () => off();
  }, []);

  const switchEngine = (e: VoiceEngine) => {
    setEngine(e);
    // Reset model to a sensible default for the chosen engine.
    if (e === "broker") setModel("");
    else if (e === "byok") setModel(model.startsWith("gpt-") || model.startsWith("whisper-") ? model : "whisper-large-v3-turbo");
    else setModel(models.find((m) => m.downloaded)?.id ?? "large-v3-turbo");
  };

  const download = async (id: string) => {
    setDownloading(id);
    const r = await voice.downloadModel(id);
    if (!r.ok || r.already) {
      setDownloading(null);
      voice.listModels().then((x) => setModels(x.models));
    }
  };

  const saveKey = async (provider: "groq" | "openai", key: string) => {
    const r = await voice.setByokKey(provider, key);
    if (r.ok) {
      if (provider === "groq") { setGroqPresent(key.length > 0); setGroqKey(""); }
      else { setOpenaiPresent(key.length > 0); setOpenaiKey(""); }
      setSavedMsg(`${provider} key ${key ? "saved" : "cleared"}`);
      setTimeout(() => setSavedMsg(null), 2500);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 640 }}>
      <p style={{ fontSize: 12.5, color: "var(--c-low)", margin: 0, lineHeight: 1.5 }}>
        Click the mic in the chat composer (or its menu to choose an input device), speak,
        and your words are transcribed into the prompt. Language is auto-detected.
      </p>

      {/* Engine */}
      <Field label="Engine">
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {ENGINES.map((e) => {
            const Icon = e.icon;
            const active = engine === e.id;
            return (
              <button key={e.id} onClick={() => switchEngine(e.id)} style={rowBtn(active)}>
                <Icon size={15} style={{ flexShrink: 0, color: active ? "var(--c-high)" : "var(--c-dim)" }} />
                <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-high)" }}>{e.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--c-low)" }}>{e.desc}</div>
                </div>
                {active && <Check size={14} style={{ color: "var(--c-high)", flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      </Field>

      {/* Language */}
      <Field label="Language">
        <select value={language} onChange={(e) => setLanguage(e.target.value)} style={selectStyle}>
          {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </Field>

      {/* Local models */}
      {engine === "local" && (
        <Field label="On-device model">
          {!localSupported ? (
            <div style={note}>This build was compiled without the local Whisper engine. Use Fleetify cloud or your own key.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {models.map((m) => {
                const pct = Math.round((progress[m.id] ?? 0) * 100);
                const isDownloading = downloading === m.id && !m.downloaded;
                const active = model === m.id;
                return (
                  <div key={m.id} style={modelRow}>
                    <button
                      onClick={() => m.downloaded && setModel(m.id)}
                      disabled={!m.downloaded}
                      style={{ ...modelPick, cursor: m.downloaded ? "pointer" : "default" }}
                    >
                      {m.downloaded
                        ? <Check size={13} style={{ color: active ? "var(--c-high)" : "var(--c-dim)" }} />
                        : <span style={{ width: 13 }} />}
                      <span style={{ fontSize: 12.5, color: "var(--c-high)" }}>{m.name}</span>
                      <span style={{ fontSize: 11, color: "var(--c-dim)" }}>{m.size_mb} MB</span>
                    </button>
                    {!m.downloaded && (
                      <button onClick={() => download(m.id)} disabled={isDownloading} style={miniBtn}>
                        {isDownloading
                          ? <><Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> {pct}%</>
                          : <><Download size={11} /> Download</>}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Field>
      )}

      {/* BYOK keys */}
      {engine === "byok" && (
        <>
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)} style={selectStyle}>
              {BYOK_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="API keys">
            <KeyInput
              label="Groq" present={groqPresent} value={groqKey}
              onChange={setGroqKey} onSave={() => saveKey("groq", groqKey)} onClear={() => saveKey("groq", "")}
            />
            <KeyInput
              label="OpenAI" present={openaiPresent} value={openaiKey}
              onChange={setOpenaiKey} onSave={() => saveKey("openai", openaiKey)} onClear={() => saveKey("openai", "")}
            />
            {savedMsg && <div style={{ fontSize: 11.5, color: "rgb(64,180,120)" }}>{savedMsg}</div>}
          </Field>
        </>
      )}

      {/* Vocabulary hint */}
      <Field label="Vocabulary hint (optional)">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Names / jargon to bias recognition, e.g. Fleetify, Tauri, Kubernetes…"
          rows={2}
          style={{ ...selectStyle, resize: "vertical", fontFamily: "inherit" }}
        />
      </Field>

      <div style={note}>
        {engine === "local"
          ? "Audio stays on your device — nothing is uploaded."
          : engine === "broker"
            ? "Audio is sent to Fleetify's server, forwarded to the provider, and not stored."
            : "Audio is sent directly to your chosen provider with your key."}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ fontSize: 11, color: "var(--c-dim)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      {children}
    </div>
  );
}

function KeyInput({
  label, present, value, onChange, onSave, onClear,
}: {
  label: string; present: boolean; value: string;
  onChange: (v: string) => void; onSave: () => void; onClear: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 56, fontSize: 12, color: "var(--c-high)" }}>{label}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={present ? "•••••••• (saved)" : "Paste API key"}
        style={{ ...selectStyle, flex: 1 }}
      />
      <button onClick={onSave} disabled={!value} style={miniBtn}>Save</button>
      {present && <button onClick={onClear} style={miniBtn}>Clear</button>}
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────
const rowBtn = (active: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 11, width: "100%",
  padding: "10px 12px", borderRadius: 9,
  background: active ? "var(--c-srf)" : "transparent",
  border: `1px solid ${active ? "var(--c-high)" : "var(--c-brd)"}`,
  cursor: "pointer", fontFamily: "inherit",
});
const selectStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 7,
  background: "var(--c-srf)", border: "1px solid var(--c-brd)",
  color: "var(--c-high)", fontSize: 12.5, outline: "none", fontFamily: "inherit",
};
const note: React.CSSProperties = { fontSize: 11.5, color: "var(--c-dim)", lineHeight: 1.5 };
const modelRow: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
  padding: "7px 10px", borderRadius: 8, background: "var(--c-srf)", border: "1px solid var(--c-brd)",
};
const modelPick: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 9, flex: 1,
  background: "none", border: "none", outline: "none", textAlign: "left", fontFamily: "inherit",
};
const miniBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, height: 26, padding: "0 10px",
  fontSize: 11.5, fontWeight: 500, borderRadius: 6,
  background: "transparent", border: "1px solid var(--c-brd)", color: "var(--c-low)",
  cursor: "pointer", fontFamily: "inherit",
};
