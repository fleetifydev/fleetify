// The app's own Tauri commands, by name: every command `lib.rs` registers
// with `tauri::generate_handler!`.
//
// This list is the app's ACL manifest. `build.rs` includes this file and
// hands the list to tauri-build (`AppManifest::commands`), which generates an
// `allow-<command>` and a `deny-<command>` permission for each, with
// underscores turned into hyphens. `permissions/app-commands.toml` gathers
// every `allow-*` into the `app-commands` set, and
// `capabilities/default.json` grants that set to the main webview only.
//
// With a manifest declared, Tauri checks every app command against the ACL,
// from local origins too: a command missing here is refused at runtime.
// build.rs checks this list against the `generate_handler!` block
// ([`manifest_drift`]) and fails the build when they differ; a test runs the
// same check.
//
// No `//!` docs here: build.rs pulls this file in with `include!`.

use std::collections::BTreeSet;

/// Every command registered in `lib.rs`'s `tauri::generate_handler!`.
pub const APP_COMMANDS: &[&str] = &[
    "auth_sign_in",
    "auth_sign_out",
    "auth_userinfo",
    "auth_get_access_token",
    "auth_get_state",
    "config_get",
    "config_set",
    "telemetry_get_config",
    "telemetry_set_posthog_enabled",
    "telemetry_set_cloud_enabled",
    "shell_open_external",
    "shell_show_item_in_folder",
    "shell_open_path",
    "detect_editors",
    "open_in_editor",
    "clipboard_write",
    "browser_embed_create",
    "browser_embed_navigate",
    "browser_embed_set_bounds",
    "browser_embed_set_select",
    "browser_embed_nav",
    "browser_embed_devtools",
    "browser_embed_clear_data",
    "browser_embed_close",
    "window_start_dragging",
    "window_minimize",
    "window_maximize",
    "window_close",
    "window_set_size",
    "window_set_taskbar_icon",
    "fs_read_directory",
    "fs_read_file",
    "fs_get_extension",
    "fs_get_project_root",
    "fs_scaffold_plugin",
    "dialog_open_folder",
    "dialog_open_file",
    "git_get_context",
    "git_working_diff",
    "git_has_gh_cli",
    "git_has_git",
    "git_list_branches",
    "git_set_base_branch",
    "git_checkout",
    "git_commit",
    "git_push",
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_kill",
    "pty_buffer",
    "git_ensure_repo",
    "git_pull_latest",
    "git_diff_summary",
    "git_open_pr",
    "git_create_pr",
    "git_get_pr_status",
    "git_list_prs",
    "git_merge_pr",
    "git_rerun_check_job",
    "git_rerun_failed_checks",
    "git_delete_remote_branch",
    "git_pr_ready",
    "git_sync_main",
    "git_fetch_base",
    "git_carve_next_round",
    "git_preflight_check",
    "shell_check_github_auth",
    "gh_auth_login_launch",
    "gh_auth_login_capture",
    "gh_auth_login_cancel",
    "shell_install_provider",
    "shell_check_python_runtime",
    "shell_install_ollama",
    "git_watch_head",
    "git_unwatch_head",
    "github_get_link",
    "github_begin_oauth",
    "github_cancel_oauth",
    "github_refresh_link",
    "github_disconnect",
    "github_open_installation",
    "github_list_repos",
    "github_list_installations",
    "voice_list_devices",
    "voice_start_recording",
    "voice_stop_recording",
    "voice_transcribe",
    "voice_set_byok_key",
    "voice_has_byok_key",
    "voice_list_models",
    "voice_download_model",
    "voice_cancel_download",
    "routers_list_routers",
    "routers_connect",
    "routers_disconnect",
    "routers_set_active",
    "routers_set_master_toggle",
    "routers_test_router",
    "routers_get_key_preview",
    "providers_list_catalog",
    "providers_set_key",
    "providers_get_key_preview",
    "providers_delete_key",
    "providers_set_enabled",
    "providers_set_default",
    "providers_set_connected_bulk",
    "providers_test_connection",
    "providers_ollama_probe",
    "providers_ollama_ps",
    "providers_ollama_pull",
    "providers_ollama_pull_cancel",
    "providers_ollama_delete",
    "providers_set_enabled_models",
    "providers_set_ollama_base_url",
    "providers_set_ollama_cloud_base_url",
    "providers_set_cloudflare_account_id",
    "providers_set_account_key",
    "providers_get_account_key_preview",
    "providers_delete_account_key",
    "providers_open_account_login",
    "agent_login_default",
    "git_generate_commit_message",
    "git_generate_pr_summary",
    "git_review_diff",
    "git_diagnose_failure",
    "git_apply_recovery",
    "git_apply_preflight_fix",
    "git_diff_summary_simple",
    "app_log",
    "logs_export",
    "logs_open_folder",
    "feedback_send",
];

/// The commands `lib_rs`, the text of `lib.rs`, registers in its one
/// `generate_handler!` block, by name (the last segment of each path), in
/// order. An error says what it couldn't read.
pub fn registered_commands(lib_rs: &str) -> Result<Vec<&str>, String> {
    const OPEN: &str = "generate_handler![";
    let mut blocks = lib_rs.match_indices(OPEN);
    let (Some((at, _)), None) = (blocks.next(), blocks.next()) else {
        return Err(
            "lib.rs must register its commands in exactly one generate_handler! block".into(),
        );
    };
    let start = at + OPEN.len();
    let len = lib_rs[start..]
        .find(']')
        .ok_or("the generate_handler! block in lib.rs never closes")?;
    lib_rs[start..start + len]
        .lines()
        .map(|line| line.find("//").map_or(line, |comment| &line[..comment]))
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| {
            if path
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
            {
                Ok(path.rsplit("::").next().unwrap_or(path))
            } else {
                Err(format!("not a command path in generate_handler!: {path}"))
            }
        })
        .collect()
}

/// How `registered` (from [`registered_commands`]) and [`APP_COMMANDS`]
/// differ, as a message that says what to fix; `None` when they list the same
/// commands, each once.
pub fn manifest_drift(registered: &[&str]) -> Option<String> {
    let registered_set: BTreeSet<&str> = registered.iter().copied().collect();
    let listed: BTreeSet<&str> = APP_COMMANDS.iter().copied().collect();
    let mut problems = Vec::new();
    if registered_set.len() != registered.len() {
        problems.push("lib.rs registers a command twice".to_string());
    }
    if listed.len() != APP_COMMANDS.len() {
        problems.push("APP_COMMANDS lists a command twice".to_string());
    }
    let unlisted: Vec<_> = registered_set.difference(&listed).collect();
    if !unlisted.is_empty() {
        problems.push(format!(
            "registered in lib.rs but missing from APP_COMMANDS, so refused at runtime: {unlisted:?}"
        ));
    }
    let unregistered: Vec<_> = listed.difference(&registered_set).collect();
    if !unregistered.is_empty() {
        problems.push(format!(
            "in APP_COMMANDS but not registered in lib.rs: {unregistered:?}"
        ));
    }
    (!problems.is_empty()).then(|| {
        format!(
            "src/app_commands.rs must list exactly the commands lib.rs registers in \
             generate_handler!. Add a new command to APP_COMMANDS and its allow-<command> \
             to permissions/app-commands.toml.\n{}",
            problems.join("\n")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{manifest_drift, registered_commands, APP_COMMANDS};

    #[test]
    fn the_app_manifest_lists_every_registered_command() {
        // build.rs runs the same check and fails the build on a mismatch.
        let registered = registered_commands(include_str!("lib.rs")).unwrap();
        assert!(registered.contains(&"auth_sign_in"), "{registered:?}");
        if let Some(drift) = manifest_drift(&registered) {
            panic!("{drift}");
        }
    }

    #[test]
    fn a_drift_says_which_commands_to_fix() {
        let mut registered: Vec<&str> = APP_COMMANDS
            .iter()
            .copied()
            .filter(|command| *command != "config_get")
            .collect();
        registered.push("a_new_command");
        let drift = manifest_drift(&registered).expect("the lists differ");
        assert!(
            drift.contains(r#"so refused at runtime: ["a_new_command"]"#),
            "{drift}"
        );
        assert!(
            drift.contains(r#"not registered in lib.rs: ["config_get"]"#),
            "{drift}"
        );
        registered.push("a_new_command");
        let twice = manifest_drift(&registered).expect("a command twice");
        assert!(
            twice.contains("lib.rs registers a command twice"),
            "{twice}"
        );
        assert_eq!(manifest_drift(APP_COMMANDS), None);
    }

    #[test]
    fn the_generate_handler_block_is_read_by_command_name() {
        let lib_rs = "builder\n    .invoke_handler(tauri::generate_handler![\n        \
                      shell::ipc::config_get, // a comment\n        app_log,\n    ])\n";
        assert_eq!(
            registered_commands(lib_rs),
            Ok(vec!["config_get", "app_log"])
        );
        // Anything it can't read is an error, not a silently shorter list.
        assert!(registered_commands("no handler block").is_err());
        assert!(registered_commands("generate_handler![a] generate_handler![b]").is_err());
        assert!(registered_commands("generate_handler![#[cfg(unix)] a]").is_err());
        assert!(registered_commands("generate_handler![a").is_err());
    }
}
