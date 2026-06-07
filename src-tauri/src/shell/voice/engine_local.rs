//! On-device Whisper (whisper.cpp via whisper-rs). Blocking — invoked
//! from `spawn_blocking`. Decodes the renderer's 16 kHz mono WAV, runs
//! Whisper with auto language detection (or a pinned language), and
//! returns the transcript. `no_context` keeps short push-to-talk clips
//! from drifting on a stale prompt.
//!
//! NOTE: written against the whisper-rs 0.16 API. This module is gated
//! behind the `local-whisper` feature and never affects cloud-only
//! builds; if a method signature shifted in a point release, adjust here.

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct LocalOut {
    pub text: String,
    pub language: Option<String>,
    pub duration_seconds: f64,
}

pub fn run(model_path: &std::path::Path, wav: &[u8], language: &str) -> Result<LocalOut, String> {
    let samples = decode_wav_16k_mono(wav)?;
    if samples.is_empty() {
        return Err("no audio samples".into());
    }
    let duration_seconds = samples.len() as f64 / 16_000.0;

    let ctx = WhisperContext::new_with_params(
        &model_path.to_string_lossy(),
        WhisperContextParameters::default(),
    )
    .map_err(|e| format!("load model: {e}"))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("create state: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_translate(false);
    params.set_no_context(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    let lang = if language.is_empty() || language == "auto" {
        "auto"
    } else {
        language
    };
    params.set_language(Some(lang));

    state
        .full(params, &samples)
        .map_err(|e| format!("transcribe: {e}"))?;

    let n = state
        .full_n_segments()
        .map_err(|e| format!("segments: {e}"))?;
    let mut text = String::new();
    for i in 0..n {
        if let Ok(seg) = state.full_get_segment_text(i) {
            text.push_str(&seg);
        }
    }

    Ok(LocalOut {
        text: text.trim().to_string(),
        // Detected-language surfacing varies across whisper-rs versions;
        // omit for the MVP — the composer only needs the transcript.
        language: None,
        duration_seconds,
    })
}

/// Decode a PCM WAV into f32 mono @16 kHz. The renderer already targets
/// 16 kHz mono; we downmix + resample defensively.
fn decode_wav_16k_mono(wav: &[u8]) -> Result<Vec<f32>, String> {
    let reader =
        hound::WavReader::new(std::io::Cursor::new(wav)).map_err(|e| format!("wav: {e}"))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;

    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|s| (s as f32 / max).clamp(-1.0, 1.0))
                .collect()
        }
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .filter_map(|s| s.ok())
            .collect(),
    };

    let mono: Vec<f32> = if channels > 1 {
        interleaved
            .chunks(channels)
            .map(|f| f.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        interleaved
    };

    Ok(if spec.sample_rate == 16_000 {
        mono
    } else {
        resample_linear(&mono, spec.sample_rate, 16_000)
    })
}

fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = src.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let frac = (src - i0 as f64) as f32;
        out.push(input[i0] * (1.0 - frac) + input[i1] * frac);
    }
    out
}
