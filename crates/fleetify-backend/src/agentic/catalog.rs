//! The 7-tool catalog. Names + parameter shapes intentionally mirror
//! Claude Code's tools so users who've worked with Claude in any agentic
//! IDE see the same names everywhere in Fleetify.
//!
//! Per-tool design notes
//! ---------------------
//!
//! - `read_file` defaults to offset=0, limit=2000 lines. Same defaults
//!   as Claude Code. Models that don't specify offset get the head.
//! - `edit_file` uses exact-string replace with a uniqueness invariant
//!   (the `old_string` must appear exactly once unless `replace_all=true`).
//!   Narrower than a diff-patch tool on purpose — the model gets
//!   immediate failure on ambiguous edits rather than silent corruption.
//! - `write_file` is for FULL rewrites or new files. Models that try to
//!   use write for a small change get a worse outcome than edit (they
//!   re-emit the whole file, more tokens, more drift); the system prompt
//!   (Commit 2) nudges them toward edit.
//! - `list_dir` excludes hidden files by default — most code work doesn't
//!   need `.git/`, `node_modules`, `target/`. `include_hidden: true` opt-in.
//! - `grep` runs against the workspace; max 100 matches returned (the
//!   model doesn't need to drown in matches; can re-grep with a tighter
//!   pattern if needed).
//! - `glob` is fast file lookup — sorted by mtime newest-first like
//!   Claude Code's Glob tool. Capped at 100 paths.
//! - `run_command` defaults to a 60s timeout, capped at 300s. cwd is
//!   relative to the workspace root and resolved via `Workspace::resolve`
//!   so a malicious cwd can't escape the sandbox at spawn time.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the tool's input. Each provider adapter renders
    /// this into the provider's preferred shape — Anthropic uses it
    /// verbatim (`input_schema`), OpenAI nests under
    /// `function.parameters`, Gemini under `functionDeclarations[].parameters`.
    pub parameters: Value,
}

/// The v1 catalog. Adding a tool requires (a) a new entry here, (b) a
/// match arm in [`super::executor::execute`], and (c) a single-line
/// update in each adapter's tool-schema renderer.
pub fn catalog_v1() -> Vec<Tool> {
    vec![
        Tool {
            name: "read_file",
            description: "Read the contents of a file from the workspace. Returns up to `limit` lines starting at `offset`. Output is line-number-prefixed so subsequent edit_file calls can refer back unambiguously.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to workspace root, or absolute path within the workspace."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "default": 0,
                        "description": "Line number to start from (0-indexed)."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 2000,
                        "default": 2000,
                        "description": "Max lines to read."
                    }
                },
                "required": ["path"]
            }),
        },
        Tool {
            name: "edit_file",
            description: "Perform an exact-string replacement in a file. `old_string` MUST appear exactly once in the file unless `replace_all=true`. Include enough surrounding context in `old_string` to make it unique. Fails fast on ambiguity rather than corrupting silently.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": {
                        "type": "string",
                        "description": "The exact text to replace. Include surrounding context to make it unique."
                    },
                    "new_string": {
                        "type": "string",
                        "description": "The replacement text."
                    },
                    "replace_all": {
                        "type": "boolean",
                        "default": false,
                        "description": "Replace every occurrence of old_string instead of requiring a unique match."
                    }
                },
                "required": ["path", "old_string", "new_string"]
            }),
        },
        Tool {
            name: "write_file",
            description: "Write a file, overwriting if it exists. Use `edit_file` for surgical changes; reserve this for full rewrites or new files. Parent directories are created automatically.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
        },
        Tool {
            name: "list_dir",
            description: "List files and subdirectories in a workspace directory. Hidden entries (starting with `.`) are excluded by default. Directories are listed first, both groups sorted alphabetically.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "default": ".",
                        "description": "Directory path relative to workspace root."
                    },
                    "include_hidden": {
                        "type": "boolean",
                        "default": false
                    }
                }
            }),
        },
        Tool {
            name: "grep",
            description: "Search for a regex pattern across workspace files. Returns matching lines prefixed with `relative_path:line_number:`. Skips common noise dirs (`.git`, `node_modules`, `target`, `.venv`, `__pycache__`). Capped at 100 matches.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for."
                    },
                    "path": {
                        "type": "string",
                        "default": ".",
                        "description": "Directory to search in (relative to workspace)."
                    },
                    "glob": {
                        "type": "string",
                        "description": "Optional glob pattern to filter files (e.g. '*.py', '**/*.ts')."
                    }
                },
                "required": ["pattern"]
            }),
        },
        Tool {
            name: "glob",
            description: "Find files matching a glob pattern. Returns paths relative to workspace root, sorted by modification time (newest first). Capped at 100 results. Skips common noise dirs.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern (e.g. 'src/**/*.tsx', '**/Cargo.toml')."
                    }
                },
                "required": ["pattern"]
            }),
        },
        Tool {
            name: "run_command",
            description: "Run a shell command in the workspace. Returns stdout, stderr, and exit code. Default timeout 60s (max 300s). The cwd is resolved against the workspace root.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Shell command. Runs under `cmd /C` on Windows, `sh -c` elsewhere."
                    },
                    "cwd": {
                        "type": "string",
                        "default": ".",
                        "description": "Working directory relative to workspace root."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "default": 60,
                        "minimum": 1,
                        "maximum": 300
                    }
                },
                "required": ["command"]
            }),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_seven_tools_with_unique_names() {
        let cat = catalog_v1();
        assert_eq!(cat.len(), 7, "v1 catalog ships exactly 7 tools");
        let mut names: Vec<&str> = cat.iter().map(|t| t.name).collect();
        names.sort();
        let mut deduped = names.clone();
        deduped.dedup();
        assert_eq!(
            names, deduped,
            "tool names must be unique within the catalog"
        );
    }

    #[test]
    fn each_tool_has_object_schema_with_properties() {
        for tool in catalog_v1() {
            assert_eq!(
                tool.parameters.get("type").and_then(|v| v.as_str()),
                Some("object"),
                "tool {} parameters must be type:object",
                tool.name
            );
            assert!(
                tool.parameters.get("properties").is_some(),
                "tool {} must have a properties block",
                tool.name
            );
        }
    }

    #[test]
    fn every_required_param_is_declared_in_properties() {
        // Defends against typos in `required` that would silently make a
        // field unenforced by JSON-Schema-aware adapters.
        for tool in catalog_v1() {
            let props = tool
                .parameters
                .get("properties")
                .and_then(|v| v.as_object())
                .expect("properties block");
            if let Some(req) = tool.parameters.get("required").and_then(|v| v.as_array()) {
                for r in req {
                    let name = r.as_str().expect("required entry is a string");
                    assert!(
                        props.contains_key(name),
                        "tool {} declares required={name} but it's not in properties",
                        tool.name
                    );
                }
            }
        }
    }

    #[test]
    fn tool_names_match_executor_match_arms() {
        // If you add a tool here, the executor's match in
        // executor::execute will reject it as "unknown tool" until the
        // matching branch lands. This test pins the contract so the two
        // files stay in lockstep.
        let expected = [
            "read_file",
            "edit_file",
            "write_file",
            "list_dir",
            "grep",
            "glob",
            "run_command",
        ];
        let actual: std::collections::HashSet<&str> = catalog_v1().iter().map(|t| t.name).collect();
        for name in expected {
            assert!(
                actual.contains(name),
                "expected catalog to contain `{name}` (executor has a match arm for it)"
            );
        }
        assert_eq!(
            actual.len(),
            expected.len(),
            "catalog drifted from executor"
        );
    }
}
