//! Model pricing table (USD per 1M tokens) — faithful port of
//! `app/utils/pricing.py`. Falls back to partial-key match when the
//! caller passes a versioned variant (e.g. "claude-opus-4-7/meta-…"
//! matches "claude-opus-4-7"); 0.0 when no match.

#[derive(Debug, Clone, Copy)]
struct Prices {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

const PRICING: &[(&str, Prices)] = &[
    ("claude-opus-4-7", Prices { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 }),
    ("claude-opus-4-6", Prices { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 }),
    ("claude-sonnet-4-6", Prices { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 }),
    ("claude-haiku-4-5", Prices { input: 0.8, output: 4.0, cache_read: 0.08, cache_write: 1.0 }),
    ("gemini-2.5-pro", Prices { input: 1.25, output: 10.0, cache_read: 0.0, cache_write: 0.0 }),
    ("gemini-2.5-flash", Prices { input: 0.15, output: 0.6, cache_read: 0.0, cache_write: 0.0 }),
    ("gemini-3.1-pro-preview", Prices { input: 1.25, output: 10.0, cache_read: 0.0, cache_write: 0.0 }),
    ("gemini-3-flash-preview", Prices { input: 0.15, output: 0.6, cache_read: 0.0, cache_write: 0.0 }),
    ("gemini-3.1-flash-lite-preview", Prices { input: 0.05, output: 0.20, cache_read: 0.0, cache_write: 0.0 }),
    ("gpt-4o", Prices { input: 2.5, output: 10.0, cache_read: 1.25, cache_write: 0.0 }),
    ("o3", Prices { input: 10.0, output: 40.0, cache_read: 2.5, cache_write: 0.0 }),
    ("o4-mini", Prices { input: 1.1, output: 4.4, cache_read: 0.275, cache_write: 0.0 }),
    ("codex-mini", Prices { input: 1.5, output: 6.0, cache_read: 0.375, cache_write: 0.0 }),
    ("gpt-5.2", Prices { input: 0.5,  output: 2.0,  cache_read: 0.05, cache_write: 0.0 }),
    ("gpt-5.4", Prices { input: 3.0,  output: 15.0, cache_read: 0.30, cache_write: 0.0 }),
    ("gpt-5.5", Prices { input: 15.0, output: 75.0, cache_read: 1.50, cache_write: 0.0 }),
];

fn lookup(model: &str) -> Option<Prices> {
    if let Some((_, p)) = PRICING.iter().find(|(k, _)| *k == model) {
        return Some(*p);
    }
    // Partial match: key contains model, or model contains key. Mirrors the
    // Python `if key in model or model in key` fallback so meta-cost
    // variants like "claude-haiku-4-5/meta-enricher" still price correctly.
    PRICING
        .iter()
        .find(|(k, _)| k.contains(model) || model.contains(*k))
        .map(|(_, p)| *p)
}

pub fn calculate_cost(
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_write: i64,
) -> f64 {
    let Some(p) = lookup(model) else { return 0.0 };
    let cost = (input_tokens as f64 * p.input
        + output_tokens as f64 * p.output
        + cache_read as f64 * p.cache_read
        + cache_write as f64 * p.cache_write)
        / 1_000_000.0;
    (cost * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_pricing_matches_python_formula() {
        let c = calculate_cost("claude-opus-4-7", 1_000_000, 1_000_000, 0, 0);
        assert!((c - (15.0 + 75.0)).abs() < 1e-6, "got {c}");
    }

    #[test]
    fn unknown_model_returns_zero() {
        assert_eq!(calculate_cost("totally-unknown-model", 100, 100, 0, 0), 0.0);
    }

    #[test]
    fn partial_match_for_meta_variant() {
        // meta-cost suffix used by track_meta_call falls back to the
        // base model via the partial-match rule.
        let c = calculate_cost(
            "claude-haiku-4-5/meta-enricher",
            1_000_000,
            0,
            0,
            0,
        );
        assert!((c - 0.8).abs() < 1e-6, "expected 0.8 for haiku base, got {c}");
    }

    #[test]
    fn gpt_4o_with_cache_read() {
        let c = calculate_cost("gpt-4o", 0, 0, 1_000_000, 0);
        assert!((c - 1.25).abs() < 1e-6, "got {c}");
    }
}
