//! Canonical hook triggers and their per-provider native event names.
//!
//! A library hook is authored against a *semantic* trigger (e.g. `pre_tool_use`);
//! each provider's writer resolves it to that vendor's native event name (Claude
//! `PreToolUse`, Gemini `BeforeTool`, Cursor `preToolUse`, …). Providers absent
//! from a trigger's `natives` don't support it. The frontend mirrors this table
//! (`src/lib/hook-triggers.ts`) to drive the picker.

/// A semantic trigger and its native event name per provider. A provider absent
/// from `natives` does not support this trigger.
pub struct Trigger {
    pub id: &'static str,
    pub label: &'static str,
    /// Whether the `matcher` field applies (tool-name scoped).
    pub tool_scoped: bool,
    pub natives: &'static [(&'static str, &'static str)],
}

pub const TRIGGERS: &[Trigger] = &[
    Trigger {
        id: "pre_tool_use",
        label: "Before tool use",
        tool_scoped: true,
        natives: &[
            ("claude-code", "PreToolUse"),
            ("gemini-cli", "BeforeTool"),
            ("codex-cli", "PreToolUse"),
            ("cursor-cli", "preToolUse"),
            ("kimi-code", "PreToolUse"),
            ("antigravity-cli", "PreToolUse"),
            ("github-copilot", "preToolUse"),
        ],
    },
    Trigger {
        id: "post_tool_use",
        label: "After tool use",
        tool_scoped: true,
        natives: &[
            ("claude-code", "PostToolUse"),
            ("gemini-cli", "AfterTool"),
            ("codex-cli", "PostToolUse"),
            ("cursor-cli", "postToolUse"),
            ("kimi-code", "PostToolUse"),
            ("antigravity-cli", "PostToolUse"),
            ("github-copilot", "postToolUse"),
        ],
    },
    Trigger {
        id: "user_prompt_submit",
        label: "User prompt submit",
        tool_scoped: false,
        natives: &[
            ("claude-code", "UserPromptSubmit"),
            ("gemini-cli", "BeforeAgent"),
            ("codex-cli", "UserPromptSubmit"),
            ("cursor-cli", "beforeSubmitPrompt"),
            ("kimi-code", "UserPromptSubmit"),
            ("github-copilot", "userPromptSubmitted"),
        ],
    },
    Trigger {
        id: "session_start",
        label: "Session start",
        tool_scoped: false,
        natives: &[
            ("claude-code", "SessionStart"),
            ("gemini-cli", "SessionStart"),
            ("codex-cli", "SessionStart"),
            ("cursor-cli", "sessionStart"),
            ("kimi-code", "SessionStart"),
            ("github-copilot", "sessionStart"),
        ],
    },
    Trigger {
        id: "session_end",
        label: "Session end",
        tool_scoped: false,
        natives: &[
            ("claude-code", "SessionEnd"),
            ("gemini-cli", "SessionEnd"),
            ("cursor-cli", "sessionEnd"),
            ("kimi-code", "SessionEnd"),
            ("github-copilot", "sessionEnd"),
        ],
    },
    Trigger {
        id: "stop",
        label: "Agent stop",
        tool_scoped: false,
        natives: &[
            ("claude-code", "Stop"),
            ("gemini-cli", "AfterAgent"),
            ("codex-cli", "Stop"),
            ("cursor-cli", "stop"),
            ("kimi-code", "Stop"),
            ("antigravity-cli", "Stop"),
            ("github-copilot", "agentStop"),
        ],
    },
    Trigger {
        id: "before_model",
        label: "Before model call",
        tool_scoped: false,
        natives: &[
            ("gemini-cli", "BeforeModel"),
            ("antigravity-cli", "PreInvocation"),
        ],
    },
    Trigger {
        id: "after_model",
        label: "After model call",
        tool_scoped: false,
        natives: &[
            ("gemini-cli", "AfterModel"),
            ("antigravity-cli", "PostInvocation"),
        ],
    },
    Trigger {
        id: "pre_compact",
        label: "Before compaction",
        tool_scoped: false,
        natives: &[
            ("claude-code", "PreCompact"),
            ("gemini-cli", "PreCompress"),
            ("codex-cli", "PreCompact"),
            ("cursor-cli", "preCompact"),
            ("kimi-code", "PreCompact"),
            ("github-copilot", "preCompact"),
        ],
    },
    Trigger {
        id: "notification",
        label: "Notification",
        tool_scoped: false,
        natives: &[
            ("claude-code", "Notification"),
            ("gemini-cli", "Notification"),
            ("kimi-code", "Notification"),
            ("github-copilot", "notification"),
        ],
    },
];

/// The native event name for `(trigger_id, provider)`, or `None` if unsupported.
pub fn native_event(trigger_id: &str, provider: &str) -> Option<&'static str> {
    TRIGGERS
        .iter()
        .find(|t| t.id == trigger_id)?
        .natives
        .iter()
        .find(|(p, _)| *p == provider)
        .map(|(_, e)| *e)
}

/// Providers that support a trigger (for validation/tests).
pub fn providers_for(trigger_id: &str) -> Vec<&'static str> {
    TRIGGERS
        .iter()
        .find(|t| t.id == trigger_id)
        .map(|t| t.natives.iter().map(|(p, _)| *p).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_event_maps_per_provider() {
        assert_eq!(
            native_event("pre_tool_use", "claude-code"),
            Some("PreToolUse")
        );
        assert_eq!(
            native_event("pre_tool_use", "gemini-cli"),
            Some("BeforeTool")
        );
        assert_eq!(
            native_event("pre_tool_use", "cursor-cli"),
            Some("preToolUse")
        );
        assert_eq!(native_event("stop", "github-copilot"), Some("agentStop"));
        // antigravity has no user-prompt event.
        assert_eq!(native_event("user_prompt_submit", "antigravity-cli"), None);
        // unknown trigger / provider.
        assert_eq!(native_event("nope", "claude-code"), None);
    }

    #[test]
    fn providers_for_trigger_is_the_support_set() {
        let p = providers_for("before_model");
        assert!(p.contains(&"gemini-cli"));
        assert!(p.contains(&"antigravity-cli"));
        assert!(!p.contains(&"claude-code"));
    }
}
