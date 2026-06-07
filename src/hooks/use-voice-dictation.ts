/**
 * Voice dictation capture hook. Records the mic in the renderer
 * (getUserMedia → Web Audio), encodes a 16 kHz mono 16-bit WAV, base64s
 * it, and hands it to the Rust `voice_transcribe` IPC (which routes to
 * local / broker / BYOK). On success, `onTranscript` is called with the
 * text so the caller can insert it at the composer caret.
 *
 * Capture lives in the webview (matching the existing MicButton device
 * picker); transcription + any network call happen in Rust.
 */
import { useCallback, useRef, useState } from "react";

import { voice, type VoiceEngine } from "@/lib/voice-api";

const LS = {
  engine: "fleet.voice.engine",
  language: "fleet.voice.language",
  model: "fleet.voice.model",
  prompt: "fleet.voice.prompt",
  device: "fleet.mic.deviceId",
} as const;

export interface VoicePrefs {
  engine: VoiceEngine;
  language: string;
  model: string;
  prompt: string;
  deviceId: string | null;
}

/** Read voice settings from localStorage (single source of truth shared
 *  with the Settings → Voice card). Defaults: managed cloud, auto-LID. */
export function getVoicePrefs(): VoicePrefs {
  const get = (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  };
  const engine = get(LS.engine, "broker");
  return {
    engine: (engine === "local" || engine === "broker" || engine === "byok" ? engine : "broker") as VoiceEngine,
    language: get(LS.language, "auto"),
    model: get(LS.model, ""),
    prompt: get(LS.prompt, ""),
    deviceId: (() => {
      try {
        return localStorage.getItem(LS.device);
      } catch {
        return null;
      }
    })(),
  };
}

export function setVoicePref(key: keyof typeof LS, value: string) {
  try {
    localStorage.setItem(LS[key], value);
  } catch {
    /* private mode */
  }
}

type State = "idle" | "recording" | "transcribing";

interface Recording {
  stream: MediaStream;
  ctx: AudioContext;
  proc: ScriptProcessorNode;
  src: MediaStreamAudioSourceNode;
  chunks: Float32Array[];
}

export interface UseVoiceDictation {
  state: State;
  recording: boolean;
  busy: boolean;
  error: string | null;
  /** Start if idle, stop+transcribe if recording. */
  toggle: () => void;
  cancel: () => void;
}

export function useVoiceDictation(onTranscript: (text: string) => void): UseVoiceDictation {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recording | null>(null);

  const teardown = useCallback((rec: Recording) => {
    try {
      rec.proc.disconnect();
      rec.src.disconnect();
      rec.stream.getTracks().forEach((t) => t.stop());
      void rec.ctx.close();
    } catch {
      /* best effort */
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const { deviceId } = getVoicePrefs();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
    } catch {
      setError("Microphone access denied.");
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but still the most portable way
    // to pull raw PCM across WKWebView / WebView2 / WebKitGTK.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    proc.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    recRef.current = { stream, ctx, proc, src, chunks };
    setState("recording");
  }, []);

  const cancel = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) teardown(rec);
    setState("idle");
  }, [teardown]);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) {
      setState("idle");
      return;
    }
    const sampleRate = rec.ctx.sampleRate;
    teardown(rec);

    const flat = flatten(rec.chunks);
    if (flat.length === 0) {
      setState("idle");
      return;
    }
    const pcm16k = downsample(flat, sampleRate, 16_000);
    const wav = encodeWav16(pcm16k, 16_000);
    const b64 = bytesToBase64(wav);

    const prefs = getVoicePrefs();
    setState("transcribing");
    const res = await voice.transcribe(b64, prefs.engine, prefs.language, prefs.model, prefs.prompt);
    setState("idle");
    if (res.ok && res.text && res.text.trim()) {
      onTranscript(res.text.trim());
    } else if (!res.ok) {
      setError(res.error ?? "Transcription failed.");
    }
  }, [onTranscript, teardown]);

  const toggle = useCallback(() => {
    if (state === "recording") void stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  return {
    state,
    recording: state === "recording",
    busy: state === "transcribing",
    error,
    toggle,
    cancel,
  };
}

// ── audio helpers (noUncheckedIndexedAccess-safe) ─────────────────
function flatten(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const a = input[i0] ?? 0;
    const b = input[i1] ?? 0;
    out[i] = a + (b - a) * (idx - i0);
  }
  return out;
}

/** 16-bit PCM mono WAV. */
function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
