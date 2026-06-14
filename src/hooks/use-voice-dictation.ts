/**
 * Voice dictation hook — delegates mic capture entirely to Rust (cpal).
 *
 * The renderer no longer calls getUserMedia / ScriptProcessorNode / AudioContext.
 * Instead:
 *   toggle()  →  voice_start_recording (cpal starts WASAPI capture in Rust)
 *   toggle()  →  voice_stop_recording  (cpal stops, WAV encoded, transcribed in Rust)
 *
 * This eliminates the browser-style mic permission popup on Windows because
 * cpal uses the OS WASAPI API directly (trusted desktop-app context).
 */
import { useCallback, useState } from "react";

import { voice, type VoiceEngine } from "@/lib/voice-api";

const LS = {
  engine:   "fleet.voice.engine",
  language: "fleet.voice.language",
  model:    "fleet.voice.model",
  prompt:   "fleet.voice.prompt",
  device:   "fleet.mic.deviceId",
} as const;

export interface VoicePrefs {
  engine:   VoiceEngine;
  language: string;
  model:    string;
  prompt:   string;
  deviceId: string | null;
}

const VALID_ENGINES: VoiceEngine[] = ["auto", "local", "broker", "byok"];

/** Actionable messages keyed by Rust error codes. */
const VOICE_ERRORS: Partial<Record<string, string>> = {
  NO_ENGINE:         "No voice engine available — sign in, add an API key, or download a local model in Settings → Voice.",
  NO_TOKEN:          "Sign in to Fleetify to use cloud voice. Open Settings → Account.",
  QUOTA_EXCEEDED:    "Daily voice quota reached. Switch to your own key or a local model in Settings → Voice.",
  NO_KEY:            "No API key saved. Add a Groq or OpenAI key in Settings → Voice.",
  NO_MODEL:          "No local Whisper model downloaded. Download one in Settings → Voice.",
  LOCAL_UNAVAILABLE: "Local Whisper engine not available in this build. Use Fleetify cloud or your own key.",
  CAPTURE_FAILED:    "Could not access the microphone. Check your system audio settings.",
  NOT_RECORDING:     "No active recording — try again.",
};

/** Read voice prefs from localStorage (shared with Settings → Voice). */
export function getVoicePrefs(): VoicePrefs {
  const get = (k: string, d: string) => {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  };
  const engine = get(LS.engine, "auto");
  return {
    engine:   (VALID_ENGINES.includes(engine as VoiceEngine) ? engine : "auto") as VoiceEngine,
    language: get(LS.language, "auto"),
    model:    get(LS.model, ""),
    prompt:   get(LS.prompt, ""),
    deviceId: (() => { try { return localStorage.getItem(LS.device); } catch { return null; } })(),
  };
}

export function setVoicePref(key: keyof typeof LS, value: string) {
  try { localStorage.setItem(LS[key], value); } catch { /* private mode */ }
}

/** Whether dictation can actually run with the current prefs. False when the
 *  on-device ("local") engine is selected but no local model is chosen — the
 *  mic would only ever error with NO_MODEL, so we disable it up front. Every
 *  other engine ("auto"/"broker"/"byok") doesn't require a downloaded model. */
export function isVoiceReady(): boolean {
  const { engine, model } = getVoicePrefs();
  return engine !== "local" || model.trim() !== "";
}

type State = "idle" | "recording" | "transcribing";

export interface UseVoiceDictation {
  state:     State;
  recording: boolean;
  busy:      boolean;
  error:     string | null;
  /** Start if idle, stop + transcribe if recording. */
  toggle: () => void;
  cancel: () => void;
}

export function useVoiceDictation(onTranscript: (text: string) => void): UseVoiceDictation {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    // Best-effort stop — discard any captured audio.
    void voice.stopRecording("auto", "auto", "", "");
    setState("idle");
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") {
      setState("transcribing");
      const prefs = getVoicePrefs();
      voice
        .stopRecording(prefs.engine, prefs.language, prefs.model, prefs.prompt)
        .then((res) => {
          setState("idle");
          if (res.ok && res.text?.trim()) {
            onTranscript(res.text.trim());
          } else if (!res.ok) {
            const msg = res.code
              ? (VOICE_ERRORS[res.code] ?? res.error ?? "Transcription failed.")
              : (res.error ?? "Transcription failed.");
            setError(msg);
          }
        })
        .catch(() => {
          setState("idle");
          setError("Transcription failed.");
        });
    } else if (state === "idle") {
      setError(null);
      const prefs = getVoicePrefs();
      voice
        .startRecording(prefs.deviceId)
        .then((res) => {
          if (res.ok) {
            setState("recording");
          } else {
            const msg = res.code
              ? (VOICE_ERRORS[res.code] ?? res.error ?? "Could not start recording.")
              : (res.error ?? "Could not start recording.");
            setError(msg);
          }
        })
        .catch(() => setError("Could not start recording."));
    }
  }, [state, onTranscript]);

  return {
    state,
    recording: state === "recording",
    busy:      state === "transcribing",
    error,
    toggle,
    cancel,
  };
}
