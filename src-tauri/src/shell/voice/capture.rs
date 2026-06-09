//! Native microphone capture via cpal. Records PCM, downmixes to mono,
//! resamples to 16 kHz, and encodes a 16-bit WAV — the same format the
//! transcription engines expect — without touching the webview at all.
//!
//! This replaces the renderer-side getUserMedia + ScriptProcessorNode path
//! so no browser-style permission dialog appears on Windows (WASAPI handles
//! mic access as a trusted desktop app). macOS will show the system
//! permission dialog the first time (NSMicrophoneUsageDescription in Info.plist).

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub struct VoiceDevice {
    pub id: String,
    pub name: String,
}

/// Live recording — keep this alive to keep the stream running.
/// Drop it (or call `stop_and_encode`) to finalize.
pub struct RecordingState {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
}

// cpal::Stream is Send on Windows (WASAPI). macOS CoreAudio streams
// must stay on their creation thread — revisit when shipping macOS.
#[cfg(target_os = "windows")]
unsafe impl Send for RecordingState {}

pub fn list_devices() -> Vec<VoiceDevice> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devs| {
            devs.filter_map(|d| {
                d.name().ok().map(|n| VoiceDevice {
                    id: n.clone(),
                    name: n,
                })
            })
            .collect()
        })
        .unwrap_or_default()
}

pub fn start(device_name: Option<&str>) -> Result<RecordingState, String> {
    let host = cpal::default_host();

    let device = match device_name {
        Some(name) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| format!("Input device '{name}' not found"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| "No default input device".to_string())?,
    };

    let config = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let fmt = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));

    let stream = build_stream(&device, stream_config, fmt, channels, samples.clone())?;
    stream.play().map_err(|e| e.to_string())?;

    tracing::info!(target: "voice", device = device_name.unwrap_or("default"), sample_rate, "recording started");

    Ok(RecordingState {
        stream,
        samples,
        sample_rate,
    })
}

/// Stop the stream, encode captured samples to 16-bit mono 16 kHz WAV.
pub fn stop_and_encode(state: RecordingState) -> Vec<u8> {
    drop(state.stream); // stops cpal callbacks immediately
    let samples = state.samples.lock().unwrap().clone();
    tracing::info!(target: "voice", samples = samples.len(), "recording stopped");
    if samples.is_empty() {
        return vec![];
    }
    let samples_16k = resample(&samples, state.sample_rate, 16_000);
    encode_wav(&samples_16k, 16_000)
}

// ── stream builders ───────────────────────────────────────────────

fn build_stream(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    fmt: cpal::SampleFormat,
    channels: usize,
    samples: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, String> {
    match fmt {
        cpal::SampleFormat::F32 => {
            let s = samples;
            device.build_input_stream(
                &config,
                move |data: &[f32], _| push_mono_f32(data, channels, &s),
                |e| tracing::error!("cpal: {e}"),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let s = samples;
            device.build_input_stream(
                &config,
                move |data: &[i16], _| push_mono_i16(data, channels, &s),
                |e| tracing::error!("cpal: {e}"),
                None,
            )
        }
        other => return Err(format!("Unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())
}

fn push_mono_f32(data: &[f32], ch: usize, out: &Arc<Mutex<Vec<f32>>>) {
    let ch = ch.max(1);
    let mut locked = out.lock().unwrap();
    for chunk in data.chunks(ch) {
        locked.push(chunk.iter().sum::<f32>() / ch as f32);
    }
}

fn push_mono_i16(data: &[i16], ch: usize, out: &Arc<Mutex<Vec<f32>>>) {
    let ch = ch.max(1);
    let mut locked = out.lock().unwrap();
    for chunk in data.chunks(ch) {
        let mono = chunk.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / ch as f32;
        locked.push(mono);
    }
}

// ── DSP helpers ───────────────────────────────────────────────────

fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let len = ((input.len() as f64 / ratio).round() as usize).max(1);
    (0..len)
        .map(|i| {
            let idx = i as f64 * ratio;
            let i0 = idx.floor() as usize;
            let i1 = (i0 + 1).min(input.len() - 1);
            let frac = (idx - i0 as f64) as f32;
            input[i0] + (input[i1] - input[i0]) * frac
        })
        .collect()
}

/// 16-bit PCM mono WAV — same format whisper-rs and the cloud engines expect.
fn encode_wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut buf = Vec::with_capacity(44 + data_len);
    macro_rules! u16le {
        ($v:expr) => {
            buf.extend_from_slice(&($v as u16).to_le_bytes())
        };
    }
    macro_rules! u32le {
        ($v:expr) => {
            buf.extend_from_slice(&($v as u32).to_le_bytes())
        };
    }
    buf.extend_from_slice(b"RIFF");
    u32le!(36 + data_len);
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    u32le!(16);
    u16le!(1);
    u16le!(1);
    u32le!(rate);
    u32le!(rate * 2);
    u16le!(2);
    u16le!(16);
    buf.extend_from_slice(b"data");
    u32le!(data_len);
    for &s in samples {
        let s = s.clamp(-1.0, 1.0);
        let v: i16 = if s < 0.0 {
            (s * 32768.0) as i16
        } else {
            (s * 32767.0) as i16
        };
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf
}
