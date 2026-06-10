//! Native microphone capture via cpal. Records PCM, downmixes to mono,
//! resamples to 16 kHz, and encodes a 16-bit WAV — the same format the
//! transcription engines expect — without touching the webview at all.
//!
//! This replaces the renderer-side getUserMedia + ScriptProcessorNode path
//! so no browser-style permission dialog appears on Windows (WASAPI handles
//! mic access as a trusted desktop app). macOS will show the system
//! permission dialog the first time (NSMicrophoneUsageDescription in Info.plist).

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub struct VoiceDevice {
    pub id: String,
    pub name: String,
}

/// Live recording. The `cpal::Stream` is owned entirely by a dedicated audio
/// thread that builds, holds, and drops it — so the stream never crosses a
/// thread boundary and `RecordingState` is `Send` with NO `unsafe impl` on any
/// platform. This matters most on macOS, whose CoreAudio streams are
/// thread-affine (a blanket `unsafe impl Send` would be UB there); it's also
/// correct on Linux/ALSA and Windows/WASAPI. Only `Send` handles + the shared
/// sample buffer live here.
pub struct RecordingState {
    /// Dropping this sender signals the audio thread to drop the stream + exit.
    stop: mpsc::Sender<()>,
    /// The audio thread. Joined in `stop_and_encode` so the stream is fully
    /// dropped (cpal callbacks stopped) before we read the captured samples.
    audio: JoinHandle<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
}

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
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let device_name = device_name.map(str::to_string);
    let samples_cb = samples.clone();

    // Build, hold, and drop the cpal stream entirely on this dedicated thread
    // so it never crosses a thread boundary (required for macOS CoreAudio;
    // harmless elsewhere). `start` blocks only until the stream reports ready.
    let audio = std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(
            move || match build_and_play(device_name.as_deref(), samples_cb) {
                Ok((stream, sample_rate)) => {
                    if ready_tx.send(Ok(sample_rate)).is_err() {
                        return; // caller gave up; drop the stream here.
                    }
                    // Keep the stream alive until stop is signalled (sender
                    // dropped or `()` sent), then drop it on THIS thread.
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            },
        )
        .map_err(|e| format!("spawn voice-capture thread: {e}"))?;

    match ready_rx.recv() {
        Ok(Ok(sample_rate)) => Ok(RecordingState {
            stop: stop_tx,
            audio,
            samples,
            sample_rate,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("voice-capture thread exited before reporting status".into()),
    }
}

/// Open the input device, build the capture stream, and start it. Runs on the
/// dedicated audio thread; returns the live stream + its sample rate.
fn build_and_play(
    device_name: Option<&str>,
    samples: Arc<Mutex<Vec<f32>>>,
) -> Result<(cpal::Stream, u32), String> {
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

    let stream = build_stream(&device, stream_config, fmt, channels, samples)?;
    stream.play().map_err(|e| e.to_string())?;

    tracing::info!(target: "voice", device = device_name.unwrap_or("default"), sample_rate, "recording started");
    Ok((stream, sample_rate))
}

/// Stop the stream, encode captured samples to 16-bit mono 16 kHz WAV.
pub fn stop_and_encode(state: RecordingState) -> Vec<u8> {
    // Signal the audio thread to drop the stream (stops cpal callbacks), then
    // join so the drop completes before we read the captured samples.
    drop(state.stop);
    let _ = state.audio.join();
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
