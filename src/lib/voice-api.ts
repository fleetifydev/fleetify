/**
 * Renderer wrapper around the voice IPC bridge (`window.electronAPI.voice`).
 * Mirrors lib/github-link-api.ts: every method resolves to a result
 * object, and when the Tauri shell isn't present (tests / plain browser)
 * each method is a deterministic no-op.
 *
 * Audio is captured in the renderer (use-voice-dictation) and the actual
 * provider/network calls happen in Rust — the API key + Fleetify bearer
 * never reach this layer.
 */

export type VoiceEngine = "auto" | "local" | "broker" | "byok";

export interface VoiceDevice {
  id: string;
  name: string;
}

export interface VoiceTranscribeResult {
  ok: boolean;
  text?: string;
  language?: string | null;
  duration_seconds?: number;
  source?: string;
  code?: string;
  error?: string;
}

export interface VoiceModel {
  id: string;
  name: string;
  size_mb: number;
  downloaded: boolean;
}

export interface VoiceModelProgress {
  id: string;
  received: number;
  total: number;
  done?: boolean;
}

interface VoiceAPI {
  listDevices: () => Promise<{ ok: boolean; devices: VoiceDevice[] }>;
  startRecording: (deviceName: string | null) => Promise<{ ok: boolean; code?: string; error?: string }>;
  stopRecording: (engine: string, language: string, model: string, prompt: string) => Promise<VoiceTranscribeResult>;
  transcribe: (audioBase64: string, engine: string, language: string, model: string, prompt: string) => Promise<VoiceTranscribeResult>;
  setByokKey: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  hasByokKey: (provider: string) => Promise<{ ok: boolean; present: boolean }>;
  listModels: () => Promise<{ ok: boolean; supported: boolean; models: VoiceModel[] }>;
  downloadModel: (id: string) => Promise<{ ok: boolean; error?: string; already?: boolean; code?: string }>;
  cancelDownload: () => Promise<{ ok: boolean }>;
  onModelProgress: (cb: (p: VoiceModelProgress) => void) => () => void;
}

function api(): VoiceAPI {
  const w = (typeof window !== "undefined" ? window : {}) as {
    electronAPI?: { voice?: VoiceAPI };
  };
  return (
    w.electronAPI?.voice ?? {
      listDevices: async () => ({ ok: true, devices: [] }),
      startRecording: async () => ({ ok: false, code: "ELECTRON_UNAVAILABLE", error: "voice unavailable" }),
      stopRecording: async () => ({ ok: false, code: "ELECTRON_UNAVAILABLE", error: "voice unavailable" }),
      transcribe: async () => ({ ok: false, code: "ELECTRON_UNAVAILABLE", error: "voice unavailable" }),
      setByokKey: async () => ({ ok: false, error: "voice unavailable" }),
      hasByokKey: async () => ({ ok: true, present: false }),
      listModels: async () => ({ ok: true, supported: false, models: [] }),
      downloadModel: async () => ({ ok: false, error: "voice unavailable" }),
      cancelDownload: async () => ({ ok: false }),
      onModelProgress: () => () => {},
    }
  );
}

export const voice = {
  listDevices: () => api().listDevices(),
  startRecording: (deviceName: string | null) => api().startRecording(deviceName),
  stopRecording: (engine: string, language: string, model: string, prompt: string) =>
    api().stopRecording(engine, language, model, prompt),
  transcribe: (audioBase64: string, engine: string, language: string, model: string, prompt: string) =>
    api().transcribe(audioBase64, engine, language, model, prompt),
  setByokKey: (provider: string, key: string) => api().setByokKey(provider, key),
  hasByokKey: (provider: string) => api().hasByokKey(provider),
  listModels: () => api().listModels(),
  downloadModel: (id: string) => api().downloadModel(id),
  cancelDownload: () => api().cancelDownload(),
  onModelProgress: (cb: (p: VoiceModelProgress) => void) => api().onModelProgress(cb),
};
