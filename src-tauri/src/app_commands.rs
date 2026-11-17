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
// from local origins too: a command missing here is refused at runtime. A
// test keeps this list equal to the `generate_handler!` block.
//
// No `//!` docs here: build.rs pulls this file in with `include!`.

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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::APP_COMMANDS;

    /// The commands `lib.rs` registers in its `generate_handler!` block, by
    /// name (the last segment of each path), in order.
    fn registered_commands() -> Vec<&'static str> {
        const LIB_RS: &str = include_str!("lib.rs");
        const OPEN: &str = "generate_handler![";
        assert_eq!(
            LIB_RS.matches(OPEN).count(),
            1,
            "lib.rs registers its commands in one generate_handler! block"
        );
        let start = LIB_RS.find(OPEN).unwrap() + OPEN.len();
        let len = LIB_RS[start..]
            .find(']')
            .expect("the generate_handler! block closes");
        LIB_RS[start..start + len]
            .lines()
            .map(|line| line.find("//").map_or(line, |comment| &line[..comment]))
            .flat_map(|line| line.split(','))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(|path| {
                assert!(
                    path.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':'),
                    "not a command path in generate_handler!: {path}"
                );
                path.rsplit("::").next().unwrap_or(path)
            })
            .collect()
    }

    #[test]
    fn the_app_manifest_lists_every_registered_command() {
        let registered = registered_commands();
        let registered_set: BTreeSet<&str> = registered.iter().copied().collect();
        let listed: BTreeSet<&str> = APP_COMMANDS.iter().copied().collect();
        assert_eq!(
            registered_set.len(),
            registered.len(),
            "lib.rs registers a command twice"
        );
        assert_eq!(
            listed.len(),
            APP_COMMANDS.len(),
            "APP_COMMANDS lists a command twice"
        );
        let unlisted: Vec<_> = registered_set.difference(&listed).collect();
        let unregistered: Vec<_> = listed.difference(&registered_set).collect();
        assert!(
            unlisted.is_empty() && unregistered.is_empty(),
            "APP_COMMANDS (src/app_commands.rs) must list exactly the commands lib.rs registers.\n\
             registered but not listed, so refused at runtime: {unlisted:?}\n\
             listed but not registered: {unregistered:?}"
        );
    }
}
