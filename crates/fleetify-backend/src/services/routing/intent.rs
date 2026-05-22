//! Heuristic complexity classifier — turns a `RoutingTask` into a `ComplexityHint`.
//! v1 is rule-based (keyword + length + code-block detection). v1.1 plans to
//! swap in Semantic Router for embedding-based intent clustering — see spec
//! `docs/superpowers/specs/2026-05-22-provider-router-design.md`.

use super::traits::{ComplexityHint, RoutingTask};

pub struct IntentClassifier;

impl IntentClassifier {
    pub fn classify(&self, task: &RoutingTask) -> ComplexityHint {
        if let Some(h) = task.user_hint {
            return h;
        }
        let prompt = &task.user_prompt;
        let lower = prompt.to_lowercase();
        let words = prompt.split_whitespace().count();

        let has_complex_keyword = [
            "refactor",
            "migrate",
            "architect",
            "design",
            "redesign",
            "deadlock",
            "race condition",
        ]
        .iter()
        .any(|k| lower.contains(k));
        let has_simple_keyword = ["typo", "rename", "format", "lint"]
            .iter()
            .any(|k| lower.contains(k));
        let has_code_block = prompt.contains("```");
        let many_files = task.workspace_context.file_count.unwrap_or(0) > 20;

        // Decision table (first match wins):
        //   - complex keyword OR many files → Complex
        //   - simple keyword AND short prompt → Trivial
        //   - very short prompt → Simple
        //   - moderate prompt → Medium
        //   - long prompt → Complex
        if has_complex_keyword || many_files {
            ComplexityHint::Complex
        } else if has_simple_keyword && !has_code_block && words < 30 {
            ComplexityHint::Trivial
        } else if words < 20 {
            ComplexityHint::Simple
        } else if words < 100 {
            ComplexityHint::Medium
        } else {
            ComplexityHint::Complex
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::routing::traits::{
        AgentKind, ComplexityHint, RoutingTask, TaskFlow, WorkspaceHints,
    };

    fn task(prompt: &str) -> RoutingTask {
        RoutingTask {
            flow: TaskFlow::Chat {
                session_id: "t".into(),
            },
            user_prompt: prompt.into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: vec![AgentKind::Claude],
            budget_remaining: None,
        }
    }

    #[test]
    fn user_hint_overrides_heuristic() {
        let mut t = task("anything goes here");
        t.user_hint = Some(ComplexityHint::Trivial);
        assert!(matches!(
            IntentClassifier.classify(&t),
            ComplexityHint::Trivial
        ));
    }

    #[test]
    fn complex_keyword_classifies_complex() {
        let t = task("Please refactor the auth module");
        assert!(matches!(
            IntentClassifier.classify(&t),
            ComplexityHint::Complex
        ));
    }

    #[test]
    fn short_simple_classifies_trivial() {
        let t = task("rename foo to bar");
        assert!(matches!(
            IntentClassifier.classify(&t),
            ComplexityHint::Trivial
        ));
    }

    #[test]
    fn very_short_classifies_simple() {
        let t = task("hello");
        assert!(matches!(
            IntentClassifier.classify(&t),
            ComplexityHint::Simple
        ));
    }

    #[test]
    fn long_prompt_classifies_complex() {
        let long = "lorem ipsum ".repeat(60);
        let t = task(&long);
        assert!(matches!(
            IntentClassifier.classify(&t),
            ComplexityHint::Complex
        ));
    }

    #[test]
    fn many_files_classifies_complex() {
        let mut t = task("fix the build");
        t.workspace_context.file_count = Some(50);
        assert!(matches!(
            IntentClassifier.classify(&t),
            ComplexityHint::Complex
        ));
    }

    #[test]
    fn code_block_blocks_trivial_bucket() {
        // "rename" alone would be Trivial, but with a code block it should NOT be Trivial
        // (the heuristic explicitly excludes code blocks from the simple-keyword path).
        let t = task("rename foo\n```rust\nlet foo = 1;\n```\nto bar");
        let result = IntentClassifier.classify(&t);
        assert!(!matches!(result, ComplexityHint::Trivial), "got {result:?}");
    }
}
