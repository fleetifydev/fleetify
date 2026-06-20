//! Typed plugin manifest models. Faithful subset of
//! `services/plugins/types.py` — covers the fields the renderer's
//! marketplace UI + the installer's first pass actually consume.
//!
//! `derive_provides()` mirrors the Python table in docs/provides.md
//! exactly so the marketplace's filter chips render the same chips
//! whether the listing was indexed by the cloud or the local backend.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Every provider id a manifest's `providers` array may name. The first
/// ten are CLI agents whose components materialize to an on-disk home
/// (see `plugins::providers`); `antigravity-sdk` is MCP-only (no home),
/// valid in `providers` so MCP-only plugins can target it.
pub const KNOWN_PROVIDERS: &[&str] = &[
    "claude-code",
    "codex-cli",
    "gemini-cli",
    "kimi-code",
    "opencode",
    "github-copilot",
    "cursor-cli",
    "hermes-agent",
    "antigravity-cli",
    "grok-build",
    "antigravity-sdk",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Author {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretRequirement {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderDeclares {
    #[serde(default)]
    pub skills: u32,
    #[serde(default)]
    pub commands: u32,
    #[serde(default)]
    pub hooks: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Declares {
    #[serde(default)]
    pub mcp_servers: u32,
    #[serde(default)]
    pub templates: u32,
    #[serde(default)]
    pub workflows: u32,
    /// Fleetify-native prompt count — materialised to
    /// `~/.fleetify/prompts/` (or `<project>/.fleetify/prompts/`).
    #[serde(default)]
    pub prompts: u32,
    /// Per-provider component counts, keyed by provider id (`claude`,
    /// `kimi`, `github-copilot`, …). A map (not a fixed struct) so new
    /// providers are additive — an unknown key just carries its counts.
    /// A legacy `codex.prompts` key deserializes harmlessly (unknown
    /// field on `ProviderDeclares` is ignored).
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderDeclares>,
}

/// Canonical "provides" values surfaced as marketplace filter chips.
pub const PROVIDES_VALUES: &[&str] = &[
    "mcp",
    "skills",
    "commands",
    "prompts",
    "hooks",
    "subagents",
    "workflows",
];

/// Compute the `provides` list from a Declares snapshot — mirrors the
/// Python `derive_provides` table from docs/provides.md.
pub fn derive_provides(declares: &Declares) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if declares.mcp_servers > 0 {
        out.push("mcp".into());
    }
    let p = &declares.providers;
    if p.values().any(|d| d.skills > 0) {
        out.push("skills".into());
    }
    // `commands` = slash-command authoring for the agent CLIs that have a
    // /command surface (Claude / Gemini / OpenCode). Counted across every
    // provider in the map; providers without a command surface simply
    // never carry a non-zero `commands`.
    if p.values().any(|d| d.commands > 0) {
        out.push("commands".into());
    }
    if declares.prompts > 0 {
        out.push("prompts".into());
    }
    if p.values().any(|d| d.hooks > 0) {
        out.push("hooks".into());
    }
    if declares.templates > 0 {
        out.push("subagents".into());
    }
    if declares.workflows > 0 {
        out.push("workflows".into());
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginManifest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Author>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_fleetify_version: Option<String>,
    pub providers: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub provides: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub requires_secrets: Vec<SecretRequirement>,
    pub declares: Declares,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

/// `MarketplaceManifest` (`marketplace.json` at a registry's repo root)
/// — slim version covering the renderer's listing surface. Each entry
/// is a marketplace listing pointing at a plugin manifest (or, for
/// "first-party" entries, providing the manifest fields inline).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarketplaceManifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub plugins: Vec<MarketplaceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarketplaceEntry {
    /// Either the directory name within the source repo (when `manifest`
    /// is inlined) or a leaf identifier. Defaults to "" so the wire
    /// format that omits it parses; callers fall back to
    /// `manifest.name` when `path` is empty.
    #[serde(default, alias = "name")]
    pub path: String,
    /// Inline plugin manifest. The fleetifydev/marketplace shape embeds
    /// the full manifest under this key for every entry; my earlier
    /// shape only carried a thin pointer. Optional so both shapes
    /// round-trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<PluginManifest>,
    #[serde(default)]
    pub featured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Author>,
    #[serde(default)]
    pub tags: Vec<String>,
}

// ── Regex validators (manual char-walks to avoid regex dep at parse time) ──

/// Matches the Python NAME_RE `^[a-z0-9][a-z0-9-]*$`.
pub fn is_valid_name(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let first = bytes[0];
    if !((first.is_ascii_lowercase()) || first.is_ascii_digit()) {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Matches the Python SEMVER_RE for X.Y.Z[-pre][+build] semver.
pub fn is_valid_semver(s: &str) -> bool {
    // Split off build (after '+') then prerelease (after '-' on remainder),
    // then validate the X.Y.Z core.
    let (core_pre, _build) = match s.find('+') {
        Some(i) => s.split_at(i),
        None => (s, ""),
    };
    let (core, _pre) = match core_pre.find('-') {
        Some(i) => core_pre.split_at(i),
        None => (core_pre, ""),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    for p in &parts {
        if p.is_empty() {
            return false;
        }
        if p != &"0" && p.starts_with('0') {
            return false; // no leading zeros
        }
        if !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    true
}

pub fn is_known_provider(s: &str) -> bool {
    KNOWN_PROVIDERS.contains(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_regex_matches_kebab_case_only() {
        assert!(is_valid_name("foo"));
        assert!(is_valid_name("foo-bar"));
        assert!(is_valid_name("foo123"));
        assert!(is_valid_name("0foo")); // digit first is OK
                                        // Bad cases:
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("-foo")); // leading hyphen
        assert!(!is_valid_name("Foo")); // uppercase
        assert!(!is_valid_name("foo_bar")); // underscore
        assert!(!is_valid_name("foo bar")); // space
        assert!(!is_valid_name("foo.bar")); // dot
    }

    #[test]
    fn semver_validator_matches_python_regex() {
        for ok in [
            "0.0.1",
            "1.2.3",
            "10.0.0",
            "1.2.3-alpha",
            "1.2.3-alpha.1",
            "1.2.3+build",
            "1.2.3-alpha+build",
        ] {
            assert!(is_valid_semver(ok), "should be valid: {ok}");
        }
        for bad in [
            "", "1", "1.2", "1.2.", ".1.2.3", "1.2.3.4", "01.0.0", // leading zero
            "v1.2.3", // v-prefix
            "1.2.x",
        ] {
            assert!(!is_valid_semver(bad), "should be invalid: {bad}");
        }
    }

    #[test]
    fn derive_provides_matches_table() {
        let mut d = Declares::default();
        assert!(derive_provides(&d).is_empty());

        d.mcp_servers = 1;
        d.providers.insert(
            "claude-code".into(),
            ProviderDeclares {
                skills: 2,
                ..Default::default()
            },
        );
        d.providers.insert(
            "gemini-cli".into(),
            ProviderDeclares {
                commands: 1,
                ..Default::default()
            },
        );
        d.prompts = 5;
        d.providers.insert(
            "kimi-code".into(),
            ProviderDeclares {
                hooks: 1,
                ..Default::default()
            },
        );
        d.templates = 3;
        d.workflows = 1;
        let p = derive_provides(&d);
        assert_eq!(
            p,
            vec![
                "mcp",
                "skills",
                "commands",
                "prompts",
                "hooks",
                "subagents",
                "workflows"
            ]
        );

        // A provider entry with all-zero counts surfaces nothing.
        let mut d2 = Declares::default();
        d2.providers
            .insert("codex-cli".into(), ProviderDeclares::default());
        assert!(derive_provides(&d2).is_empty());
    }

    #[test]
    fn plugin_manifest_round_trips_through_json() {
        let raw = r#"{
            "name": "my-plugin",
            "version": "1.2.3",
            "providers": ["claude-code"],
            "declares": {
                "mcp_servers": 1,
                "providers": { "claude-code": { "skills": 2 } }
            }
        }"#;
        let m: PluginManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(m.name, "my-plugin");
        assert_eq!(m.version, "1.2.3");
        assert!(is_valid_name(&m.name));
        assert!(is_valid_semver(&m.version));
        assert_eq!(m.providers, vec!["claude-code".to_string()]);
        assert_eq!(m.declares.mcp_servers, 1);
        assert_eq!(
            m.declares.providers.get("claude-code").map(|d| d.skills),
            Some(2)
        );
        // Round-trip back to JSON keeps the same structure.
        let back = serde_json::to_string(&m).unwrap();
        assert!(back.contains("\"name\":\"my-plugin\""));
    }
}
