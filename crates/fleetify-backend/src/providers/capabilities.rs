//! Per-provider / per-model capability descriptors for the native
//! effort + permission UI. Lookup module (not fields on the catalog
//! literals) so each provider is an independent, testable unit. See
//! docs/superpowers/specs/2026-06-05-effort-permission-architecture-design.md.

use serde::Serialize;

/// When a config change for a provider's bridge takes effect.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Apply {
    /// Read at process start; a change re-spawns on the next message.
    Spawn,
    /// Applied mid-session via ACP `session/set_config_option`.
    Live,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ConfigTiming {
    pub permission: Apply,
    pub effort: Apply,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct PermMode {
    pub id: &'static str,
    pub label: &'static str,
}

/// A provider's native permission surface.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PermissionCapability {
    /// A single mode enum, optionally with an independent OS-sandbox
    /// toggle (Gemini/Antigravity/Qwen). `sandbox` is the list of
    /// sandbox values, or `None` when the provider has no sandbox axis.
    Modes {
        modes: &'static [PermMode],
        sandbox: Option<&'static [&'static str]>,
    },
    /// Two orthogonal axes — a true cross-product (Codex only).
    ApprovalSandbox {
        approvals: &'static [&'static str],
        sandboxes: &'static [&'static str],
    },
    /// No tool-authorization concept (Perplexity).
    None,
}

/// Optional per-tool allow/deny matrix overlay for agents that have one
/// (Cursor, Copilot, OpenCode, Kimi).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ToolMatrixCapability {
    pub tools: &'static [&'static str],
    pub decisions: &'static [&'static str],
    pub supports_glob: bool,
}

/// A model's native effort surface.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EffortCapability {
    /// Discrete level set (subset of low|medium|high|xhigh|max).
    Levels {
        levels: &'static [&'static str],
        default: &'static str,
    },
    /// Gemini 3 style thinking-level (low|high|…).
    ThinkingLevel {
        levels: &'static [&'static str],
        default: &'static str,
    },
    /// Token thinking-budget (Gemini 2.5). `default` `-1` = dynamic.
    Budget {
        min: i64,
        max: i64,
        default: i64,
        can_disable: bool,
    },
    /// On/off thinking switch (Kimi, DeepSeek V3.2, Qwen).
    Toggle { default: bool },
    /// Intrinsic / non-reasoning — no effort control.
    None,
}

const CLAUDE_MODES: &[PermMode] = &[
    PermMode {
        id: "default",
        label: "Ask permissions",
    },
    PermMode {
        id: "acceptEdits",
        label: "Accept edits",
    },
    PermMode {
        id: "plan",
        label: "Plan mode",
    },
    PermMode {
        id: "bypassPermissions",
        label: "Bypass permissions",
    },
];
const GEMINI_MODES: &[PermMode] = &[
    PermMode {
        id: "default",
        label: "Ask permissions",
    },
    PermMode {
        id: "auto_edit",
        label: "Accept edits",
    },
    PermMode {
        id: "plan",
        label: "Plan mode",
    },
    PermMode {
        id: "yolo",
        label: "Bypass permissions",
    },
];
const CURSOR_MODES: &[PermMode] = &[
    PermMode {
        id: "agent",
        label: "Agent",
    },
    PermMode {
        id: "plan",
        label: "Plan",
    },
    PermMode {
        id: "ask",
        label: "Ask (read-only)",
    },
];
const COPILOT_MODES: &[PermMode] = &[
    PermMode {
        id: "ask",
        label: "Ask permissions",
    },
    PermMode {
        id: "plan",
        label: "Plan mode",
    },
    PermMode {
        id: "autopilot",
        label: "Autopilot",
    },
];
const OPENCODE_MODES: &[PermMode] = &[
    PermMode {
        id: "build",
        label: "Build",
    },
    PermMode {
        id: "plan",
        label: "Plan",
    },
];
const KIMI_MODES: &[PermMode] = &[
    PermMode {
        id: "ask",
        label: "Ask permissions",
    },
    PermMode {
        id: "plan",
        label: "Plan mode",
    },
    PermMode {
        id: "yolo",
        label: "YOLO (bypass)",
    },
];
const ANTIGRAVITY_MODES: &[PermMode] = &[
    PermMode {
        id: "request-review",
        label: "Request review",
    },
    PermMode {
        id: "proceed-in-sandbox",
        label: "Proceed in sandbox",
    },
    PermMode {
        id: "always-proceed",
        label: "Always proceed (YOLO)",
    },
];
const HTTP_MODES: &[PermMode] = &[
    PermMode {
        id: "default",
        label: "Ask permissions",
    },
    PermMode {
        id: "acceptEdits",
        label: "Accept edits",
    },
    PermMode {
        id: "bypassPermissions",
        label: "Bypass permissions",
    },
];
const HERMES_MODES: &[PermMode] = HTTP_MODES;
const SANDBOX_TOGGLE: &[&str] = &["off", "on"];

/// Native permission surface per provider (§9).
pub fn permission_capability(provider_id: &str) -> PermissionCapability {
    match provider_id {
        "claude" => PermissionCapability::Modes {
            modes: CLAUDE_MODES,
            sandbox: None,
        },
        "codex" => PermissionCapability::ApprovalSandbox {
            approvals: &["untrusted", "on-request", "never"],
            sandboxes: &["read-only", "workspace-write", "danger-full-access"],
        },
        "agy" | "antigravity-sdk" => PermissionCapability::Modes {
            modes: ANTIGRAVITY_MODES,
            sandbox: Some(SANDBOX_TOGGLE),
        },
        "gemini" => PermissionCapability::Modes {
            modes: GEMINI_MODES,
            sandbox: Some(SANDBOX_TOGGLE),
        },
        "cursor" => PermissionCapability::Modes {
            modes: CURSOR_MODES,
            sandbox: None,
        },
        "github-copilot" => PermissionCapability::Modes {
            modes: COPILOT_MODES,
            sandbox: None,
        },
        "opencode" => PermissionCapability::Modes {
            modes: OPENCODE_MODES,
            sandbox: None,
        },
        "kimi" => PermissionCapability::Modes {
            modes: KIMI_MODES,
            sandbox: None,
        },
        "hermes" => PermissionCapability::Modes {
            modes: HERMES_MODES,
            sandbox: None,
        },
        "perplexity" => PermissionCapability::None,
        // All HTTP providers → Fleetify agentic-runner tiers.
        _ => PermissionCapability::Modes {
            modes: HTTP_MODES,
            sandbox: None,
        },
    }
}

/// Per-tool allow/deny matrix for agents that expose one (§9). Tool
/// names are each agent's real vocabulary; they differ per agent.
pub fn tool_matrix(provider_id: &str) -> Option<ToolMatrixCapability> {
    match provider_id {
        "opencode" => Some(ToolMatrixCapability {
            tools: &[
                "read",
                "edit",
                "bash",
                "glob",
                "grep",
                "webfetch",
                "websearch",
            ],
            decisions: &["allow", "ask", "deny"],
            supports_glob: true,
        }),
        "cursor" => Some(ToolMatrixCapability {
            tools: &["Read", "Write", "Shell", "WebFetch", "Mcp"],
            decisions: &["allow", "deny"],
            supports_glob: true,
        }),
        "github-copilot" => Some(ToolMatrixCapability {
            tools: &["shell", "write", "read"],
            decisions: &["allow", "deny"],
            supports_glob: true,
        }),
        "kimi" => Some(ToolMatrixCapability {
            tools: &["mcp_tool"],
            decisions: &["allow", "deny"],
            supports_glob: true,
        }),
        _ => None,
    }
}

const CLAUDE_FULL: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const CLAUDE_NO_XHIGH: &[&str] = &["low", "medium", "high", "max"];
const CLAUDE_BASE: &[&str] = &["low", "medium", "high"];

fn claude_effort(model: &str) -> EffortCapability {
    if model.contains("haiku") {
        return EffortCapability::None;
    }
    if model.contains("opus-4-8") || model.contains("opus-4-7") {
        EffortCapability::Levels {
            levels: CLAUDE_FULL,
            default: "high",
        }
    } else if model.contains("opus-4-5") {
        EffortCapability::Levels {
            levels: CLAUDE_BASE,
            default: "high",
        }
    } else {
        // opus-4-6, sonnet-4-6
        EffortCapability::Levels {
            levels: CLAUDE_NO_XHIGH,
            default: "high",
        }
    }
}

fn openai_effort(model: &str) -> EffortCapability {
    if model.starts_with("gpt-5") {
        EffortCapability::Levels {
            levels: &["minimal", "low", "medium", "high"],
            default: "medium",
        }
    } else if model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4") {
        EffortCapability::Levels {
            levels: &["low", "medium", "high"],
            default: "medium",
        }
    } else {
        EffortCapability::None // gpt-4.1 / non-reasoning
    }
}

fn gemini_effort(model: &str) -> EffortCapability {
    if model.contains("2.5-flash") {
        EffortCapability::Budget {
            min: 0,
            max: 24576,
            default: -1,
            can_disable: true,
        }
    } else if model.contains("2.5-pro") {
        EffortCapability::Budget {
            min: 128,
            max: 32768,
            default: -1,
            can_disable: false,
        }
    } else if model.contains("-3") || model.contains("3.") {
        EffortCapability::ThinkingLevel {
            levels: &["low", "high"],
            default: "high",
        }
    } else {
        EffortCapability::None
    }
}

fn grok_effort(model: &str) -> EffortCapability {
    if model.contains("4.3") {
        EffortCapability::Levels {
            levels: &["none", "low", "medium", "high"],
            default: "low",
        }
    } else if model.contains("3-mini") {
        EffortCapability::Levels {
            levels: &["low", "high"],
            default: "low",
        }
    } else {
        EffortCapability::None // grok-4 / grok-3 / code-fast: reasoning-always
    }
}

/// Native effort surface for one provider+model (§9). Anthropic's HTTP
/// compat endpoint ignores effort → None there (Claude effort is CLI-only).
pub fn effort_capability(provider_id: &str, model_id: &str) -> EffortCapability {
    match provider_id {
        "claude" => claude_effort(model_id),
        "codex" => EffortCapability::Levels {
            levels: &["low", "medium", "high", "xhigh"],
            default: "medium",
        },
        "openai" => openai_effort(model_id),
        "gemini" | "gemini-api" => gemini_effort(model_id),
        "grok" => grok_effort(model_id),
        "kimi" | "kimi-api" => {
            if model_id.contains("thinking") {
                EffortCapability::Toggle { default: true }
            } else {
                EffortCapability::None
            }
        }
        "deepseek" => {
            if model_id.contains("reasoner") || model_id.contains("v3.2") {
                EffortCapability::Toggle { default: true }
            } else {
                EffortCapability::None
            }
        }
        "perplexity" => {
            if model_id.contains("deep-research") {
                EffortCapability::Levels {
                    levels: &["low", "medium", "high"],
                    default: "medium",
                }
            } else {
                EffortCapability::None
            }
        }
        "github-copilot" => EffortCapability::Levels {
            levels: &["low", "medium", "high", "xhigh"],
            default: "medium",
        },
        // anthropic (compat) / nvidia-nim / openrouter / cloudflare / ollama /
        // opencode / cursor / hermes / agy → resolved via dynamic model events
        // or unsupported here.
        _ => EffortCapability::None,
    }
}

/// When permission/effort changes apply for a provider's bridge (§8).
pub fn config_timing(provider_id: &str) -> ConfigTiming {
    match provider_id {
        "opencode" | "cursor" | "hermes" => ConfigTiming {
            permission: Apply::Live,
            effort: Apply::Live,
        },
        "github-copilot" => ConfigTiming {
            permission: Apply::Spawn,
            effort: Apply::Live,
        },
        _ => ConfigTiming {
            permission: Apply::Spawn,
            effort: Apply::Spawn,
        },
    }
}

/// One model's id paired with its native effort surface — serialized
/// alongside the tile so the renderer can gate the effort control per
/// model without a second round-trip.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ModelEffort {
    pub id: &'static str,
    pub effort: EffortCapability,
}

/// Everything the renderer needs to render native permission + effort
/// controls for one provider tile. CLI agents have empty `default_models`
/// so their `model_efforts` is empty — those models live in the renderer's
/// static `CLI_MODELS` and carry their own descriptors.
#[derive(Debug, Clone, Serialize)]
pub struct TileCapabilities {
    pub permission: PermissionCapability,
    pub tool_matrix: Option<ToolMatrixCapability>,
    pub timing: ConfigTiming,
    pub model_efforts: Vec<ModelEffort>,
}

/// Capability bundle for one provider spec. Pure — safe to call per tile.
pub fn tile_capabilities(spec: &'static crate::providers::ProviderSpec) -> TileCapabilities {
    TileCapabilities {
        permission: permission_capability(spec.id),
        tool_matrix: tool_matrix(spec.id),
        timing: config_timing(spec.id),
        model_efforts: spec
            .default_models
            .iter()
            .map(|m| ModelEffort {
                id: m.id,
                effort: effort_capability(spec.id, m.id),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_capability_serializes_with_kind_tag() {
        let cap = PermissionCapability::Modes {
            modes: &[PermMode {
                id: "default",
                label: "Ask permissions",
            }],
            sandbox: None,
        };
        let v = serde_json::to_value(cap).unwrap();
        assert_eq!(v["kind"], "modes");
        assert_eq!(v["modes"][0]["id"], "default");
    }

    #[test]
    fn effort_capability_serializes_with_kind_tag() {
        let none = serde_json::to_value(EffortCapability::None).unwrap();
        assert_eq!(none["kind"], "none");
        let levels = serde_json::to_value(EffortCapability::Levels {
            levels: &["low", "high"],
            default: "high",
        })
        .unwrap();
        assert_eq!(levels["kind"], "levels");
        assert_eq!(levels["default"], "high");
    }

    #[test]
    fn timing_serializes_snake_case() {
        let t = ConfigTiming {
            permission: Apply::Spawn,
            effort: Apply::Live,
        };
        let v = serde_json::to_value(t).unwrap();
        assert_eq!(v["permission"], "spawn");
        assert_eq!(v["effort"], "live");
    }

    #[test]
    fn config_timing_marks_acp_bridges_live() {
        assert_eq!(
            config_timing("opencode"),
            ConfigTiming {
                permission: Apply::Live,
                effort: Apply::Live
            }
        );
        assert_eq!(
            config_timing("cursor"),
            ConfigTiming {
                permission: Apply::Live,
                effort: Apply::Live
            }
        );
        assert_eq!(
            config_timing("hermes"),
            ConfigTiming {
                permission: Apply::Live,
                effort: Apply::Live
            }
        );
        // Copilot: tools at spawn, effort live.
        assert_eq!(
            config_timing("github-copilot"),
            ConfigTiming {
                permission: Apply::Spawn,
                effort: Apply::Live
            }
        );
        // Spawn-fixed.
        assert_eq!(
            config_timing("claude"),
            ConfigTiming {
                permission: Apply::Spawn,
                effort: Apply::Spawn
            }
        );
        assert_eq!(
            config_timing("codex"),
            ConfigTiming {
                permission: Apply::Spawn,
                effort: Apply::Spawn
            }
        );
        assert_eq!(
            config_timing("openai"),
            ConfigTiming {
                permission: Apply::Spawn,
                effort: Apply::Spawn
            }
        );
    }

    #[test]
    fn permission_capability_per_provider() {
        // Claude: 4 modes (default/acceptEdits/plan/bypassPermissions), no sandbox.
        match permission_capability("claude") {
            PermissionCapability::Modes { modes, sandbox } => {
                assert!(modes.iter().any(|m| m.id == "plan"));
                assert_eq!(modes.len(), 4);
                assert!(sandbox.is_none());
            }
            _ => panic!("claude must be Modes"),
        }
        // Codex: two-axis cross-product.
        match permission_capability("codex") {
            PermissionCapability::ApprovalSandbox {
                approvals,
                sandboxes,
            } => {
                assert_eq!(approvals, &["untrusted", "on-request", "never"]);
                assert_eq!(
                    sandboxes,
                    &["read-only", "workspace-write", "danger-full-access"]
                );
            }
            _ => panic!("codex must be ApprovalSandbox"),
        }
        // Antigravity: 3-tier Modes + sandbox toggle.
        match permission_capability("agy") {
            PermissionCapability::Modes { modes, sandbox } => {
                assert_eq!(modes.len(), 3);
                assert!(sandbox.is_some());
            }
            _ => panic!("agy must be Modes + sandbox"),
        }
        // Perplexity: None.
        assert_eq!(
            permission_capability("perplexity"),
            PermissionCapability::None
        );
        // An HTTP provider: agentic tiers, 3 modes.
        match permission_capability("openai") {
            PermissionCapability::Modes { modes, sandbox } => {
                assert_eq!(modes.len(), 3);
                assert!(!modes.iter().any(|m| m.id == "plan"));
                assert!(sandbox.is_none());
            }
            _ => panic!("openai must be Modes"),
        }
        // Gemini CLI uses its native approval ids.
        match permission_capability("gemini") {
            PermissionCapability::Modes { modes, .. } => {
                assert!(modes.iter().any(|m| m.id == "auto_edit"));
                assert!(modes.iter().any(|m| m.id == "yolo"));
            }
            _ => panic!("gemini must be Modes"),
        }
        // HTTP-tier providers (incl. the *-api siblings of CLI agents) fall to the agentic tiers.
        assert_eq!(
            permission_capability("kimi-api"),
            PermissionCapability::Modes {
                modes: HTTP_MODES,
                sandbox: None
            }
        );
        assert_eq!(
            permission_capability("gemini-api"),
            PermissionCapability::Modes {
                modes: HTTP_MODES,
                sandbox: None
            }
        );
    }

    #[test]
    fn tool_matrix_for_allow_deny_agents() {
        let oc = tool_matrix("opencode").expect("opencode has a matrix");
        assert!(oc.tools.contains(&"bash"));
        assert_eq!(oc.decisions, &["allow", "ask", "deny"]);
        assert!(oc.supports_glob);

        let cop = tool_matrix("github-copilot").expect("copilot has a matrix");
        assert!(cop.tools.contains(&"shell"));
        assert_eq!(cop.decisions, &["allow", "deny"]);

        // Non-matrix agents → None.
        assert!(tool_matrix("claude").is_none());
        assert!(tool_matrix("codex").is_none());
        assert!(tool_matrix("openai").is_none());
    }

    #[test]
    fn tile_capabilities_bundles_provider_and_model_caps() {
        let openai = crate::providers::CATALOG
            .iter()
            .find(|s| s.id == "openai")
            .expect("openai in catalog");
        let caps = tile_capabilities(openai);
        assert!(matches!(
            caps.permission,
            PermissionCapability::Modes { .. }
        ));
        assert!(matches!(caps.timing.permission, Apply::Spawn));
        assert!(
            !caps.model_efforts.is_empty(),
            "openai ships curated models"
        );
        let claude = crate::providers::CATALOG
            .iter()
            .find(|s| s.id == "claude")
            .expect("claude in catalog");
        let ccaps = tile_capabilities(claude);
        assert!(
            matches!(ccaps.permission, PermissionCapability::Modes { modes, .. } if modes.len() == 4)
        );
        assert!(ccaps.model_efforts.is_empty());
    }

    #[test]
    fn effort_capability_is_model_specific() {
        use EffortCapability::*;
        // Claude: model-specific level sets; Haiku none.
        assert!(matches!(effort_capability("claude", "claude-opus-4-8"),
            Levels { levels, .. } if levels.contains(&"xhigh") && levels.contains(&"max")));
        assert!(matches!(effort_capability("claude", "claude-sonnet-4-6"),
            Levels { levels, .. } if !levels.contains(&"xhigh") && levels.contains(&"max")));
        assert!(matches!(effort_capability("claude", "claude-opus-4-5"),
            Levels { levels, .. } if levels == ["low", "medium", "high"]));
        assert_eq!(effort_capability("claude", "claude-haiku-4-5"), None);
        // OpenAI: GPT-5 adds minimal; codex no minimal; o-series no minimal.
        assert!(matches!(effort_capability("openai", "gpt-5.5"),
            Levels { levels, .. } if levels.contains(&"minimal")));
        assert!(matches!(effort_capability("codex", "gpt-5.2-codex"),
            Levels { levels, .. } if !levels.contains(&"minimal") && levels.contains(&"xhigh")));
        // Gemini: 2.5 budget, 3 thinking-level.
        assert!(matches!(
            effort_capability("gemini-api", "gemini-2.5-flash"),
            Budget {
                can_disable: true,
                ..
            }
        ));
        assert!(matches!(
            effort_capability("gemini-api", "gemini-2.5-pro"),
            Budget {
                can_disable: false,
                ..
            }
        ));
        // Grok: bifurcated.
        assert!(matches!(
            effort_capability("grok", "grok-4.3"),
            Levels { .. }
        ));
        assert_eq!(effort_capability("grok", "grok-4"), None);
        // Kimi: toggle on thinking models.
        assert!(matches!(
            effort_capability("kimi-api", "kimi-k2-thinking"),
            Toggle { .. }
        ));
        // Anthropic HTTP compat can't do effort levels → None (CLI-only).
        assert_eq!(effort_capability("anthropic", "claude-opus-4-8"), None);
        // Unknown → None.
        assert_eq!(effort_capability("ollama", "llama3"), None);
    }
}
