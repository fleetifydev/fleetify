// Reconstructs the Electron preload surface on Tauri. Phase 1b: real
// `window.fleetify` (auth) → Tauri commands/events. `window.electronAPI`
// stays a boot-safe no-op Proxy until Phase 1c wires its ~51 channels.
// __TAURI__ is referenced lazily (withGlobalTauri injects it).
(function () {
  function core() { return window.__TAURI__ && window.__TAURI__.core; }
  function ev() { return window.__TAURI__ && window.__TAURI__.event; }
  function invoke(cmd, args) {
    var c = core();
    return c ? c.invoke(cmd, args || {}) : Promise.reject(new Error("tauri-ipc-unavailable"));
  }

  window.fleetify = {
    signIn: function () { return invoke("auth_sign_in"); },
    signOut: function () { return invoke("auth_sign_out"); },
    userinfo: function () { return invoke("auth_userinfo"); },
    getAccessToken: function (opts) {
      return invoke("auth_get_access_token", { force: !!(opts && opts.force) });
    },
    getState: function () { return invoke("auth_get_state"); },
    onAuthEvent: function (cb) {
      var unlisten = null;
      var e = ev();
      if (e) {
        e.listen("fleet:auth-event", function (m) { cb(m.payload); }).then(function (u) {
          unlisten = u;
        });
      }
      return function () { if (unlisten) unlisten(); };
    },
    // Feedback bridge — POST <issuer>/api/feedback (multipart) via the
    // `feedback_send` Tauri command. Mirrors the Electron build's
    // payload shape: { comment, email?, attachments? } where each
    // attachment is { name, data_url } with a `data:image/…;base64,…`
    // URL. Resolves to { ok: true, data } on 2xx, { ok: false, error,
    // code, status, requestId? } on every failure (including the
    // synthetic NO_BEARER short-circuit when no access token is cached).
    sendFeedback: function (body) {
      return invoke("feedback_send", { body: body || {} });
    },
  };

  // window.electronAPI: boot-safe until Phase 1c. Async no-op for unknown
  // methods, evNoop for on* listeners.
  var asyncNoop = function () { return Promise.resolve(undefined); };
  var evNoop = function () { return function () {}; };
  window.electronAPI = new Proxy(
    {
      // Real-backed by Tauri commands (Phase 2 increments).
      getConfig: function () { return invoke("config_get"); },
      setConfig: function (c) { return invoke("config_set", { config: c || {} }); },
      telemetryGetConfig: function () { return invoke("telemetry_get_config"); },
      telemetrySetPosthogEnabled: function (enabled) {
        return invoke("telemetry_set_posthog_enabled", { enabled: !!enabled });
      },
      openExternal: function (url) { return invoke("shell_open_external", { url: String(url || "") }); },
      showItemInFolder: function (p) { return invoke("shell_show_item_in_folder", { path: String(p || "") }); },
      writeText: function (t) { return invoke("clipboard_write", { text: String(t || "") }); },
      minimizeWindow: function () { return invoke("window_minimize"); },
      maximizeWindow: function () { return invoke("window_maximize"); },
      closeWindow: function () { return invoke("window_close"); },
      setWindowSize: function (w, h, opts) {
        var o = opts || {};
        return invoke("window_set_size", {
          width: Number(w),
          height: Number(h),
          // `animate` was an Electron-era affordance that Tauri doesn't
          // expose — silently dropped. `center` matters: every screen
          // mode (onboarding 760×740, onboarding-chat 760×820, main
          // 1500×960) has a different size, so after a resize the window
          // would otherwise stay anchored to its previous top-left
          // corner. Forward it so the Rust handler can recenter.
          center: !!o.center,
        });
      },
      // System-theme-aware OS taskbar icon. variant: "light" | "dark".
      // Light theme ⇒ pass "dark" (dark logo on light taskbar). Dark
      // theme ⇒ pass "light".
      setTaskbarIcon: function (variant) { return invoke("window_set_taskbar_icon", { variant: String(variant || "dark") }); },
      readDirectory: function (p) { return invoke("fs_read_directory", { dirPath: String(p || "") }); },
      readFile: function (p) { return invoke("fs_read_file", { filePath: String(p || "") }); },
      getExtension: function (p) { return invoke("fs_get_extension", { filePath: String(p || "") }); },
      getProjectRoot: function () { return invoke("fs_get_project_root"); },
      scaffoldPlugin: function (opts) {
        var o = opts || {};
        return invoke("fs_scaffold_plugin", {
          parentFolder: String(o.parentFolder || ""),
          pluginSlug: String(o.pluginSlug || ""),
          files: o.files || {},
        });
      },
      openFolderDialog: function () { return invoke("dialog_open_folder"); },
      checkGithubAuth: function () { return invoke("shell_check_github_auth"); },
      // Launches `gh auth login --web` in a fresh terminal so the user
      // can complete the device-code flow. Renderer should poll
      // `hasGhCli()` after calling this to detect when auth finishes.
      ghAuthLoginLaunch: function () { return invoke("gh_auth_login_launch"); },
      // In-process gh auth flow — captures the one-time device code so we
      // can surface it inside the app instead of asking the user to dig
      // through a separate terminal window. Pair with onGhAuthEvent for
      // live progress, and call ghAuthLoginCancel to kill the child.
      ghAuthLoginCapture: function () { return invoke("gh_auth_login_capture"); },
      ghAuthLoginCancel:  function () { return invoke("gh_auth_login_cancel"); },
      onGhAuthEvent: function (cb) {
        var unsub = null;
        var e = ev();
        if (e) {
          e.listen("gh-auth-event", function (m) {
            try { cb(m && m.payload); } catch (_) {}
          }).then(function (u) { unsub = u; });
        }
        return function () { try { unsub && unsub(); } catch (_) {} };
      },
      installProvider: function (toolKey) { return invoke("shell_install_provider", { toolKey: String(toolKey || "") }); },
      checkPythonRuntime: function () { return invoke("shell_check_python_runtime"); },
      installOllama: function () { return invoke("shell_install_ollama"); },
      generateCommitMessage: function (folder, opts) {
        var o = opts || {};
        return invoke("git_generate_commit_message", {
          folder: String(folder || ""),
          tool: o.tool || null,
          isInitial: !!o.isInitial,
        });
      },
      generatePRSummary: function (folder, opts) {
        var o = opts || {};
        return invoke("git_generate_pr_summary", {
          folder: String(folder || ""),
          baseBranch: o.baseBranch || null,
          tool: o.tool || null,
        });
      },
      reviewDiff: function (folder, opts) {
        var o = opts || {};
        return invoke("git_review_diff", {
          folder: String(folder || ""),
          baseBranch: o.baseBranch || null,
          tool: o.tool || null,
        });
      },
      diagnoseFailure: function (folder, opts) {
        var o = opts || {};
        return invoke("git_diagnose_failure", {
          folder: String(folder || ""),
          errorMessage: String(o.errorMessage || ""),
          tool: o.tool || null,
          context: o.context || null,
          baseBranch: o.baseBranch || null,
        });
      },
      applyRecovery: function (folder, opts) {
        var o = opts || {};
        return invoke("git_apply_recovery", {
          folder: String(folder || ""),
          action: String(o.action || "manual"),
          baseBranch: o.baseBranch || null,
          command: o.command || null,
        });
      },
      applyPreflightFix: function (folder, opts) {
        var o = opts || {};
        return invoke("git_apply_preflight_fix", {
          folder: String(folder || ""),
          action: String(o.action || ""),
          data: o.data || null,
        });
      },
      diffSummary: function (folder, opts) {
        var o = opts || {};
        return invoke("git_diff_summary_simple", {
          folder: String(folder || ""),
          baseBranch: o.baseBranch || null,
        });
      },
      watchHead: function (folder, key) { return invoke("git_watch_head", { folder: String(folder || ""), key: String(key || "") }); },
      unwatchHead: function (key) { return invoke("git_unwatch_head", { key: String(key || "") }); },
      onHeadChanged: function (cb) {
        var unsub = null;
        Promise.resolve(window.__TAURI__.event.listen("git:head-changed", function (e) {
          try { cb(e && e.payload); } catch (_) {}
        })).then(function (u) { unsub = u; });
        return function () { try { unsub && unsub(); } catch (_) {} };
      },
      // ── routers (Settings → Routers tile management) ──
      // Mirrors the routers_* Tauri commands; secrets cross IPC only on
      // the connect call (renderer → keychain via main). list/disconnect
      // /setActive/setMasterToggle/testRouter never carry secrets.
      routers: {
        list:            function () { return invoke("routers_list_routers"); },
        connect:         function (id, secret, metadata) {
          return invoke("routers_connect", {
            id: String(id || ""),
            secret: String(secret || ""),
            metadata: metadata || {},
          });
        },
        disconnect:      function (id) { return invoke("routers_disconnect", { id: String(id || "") }); },
        setActive:       function (category, id) {
          return invoke("routers_set_active", {
            category: String(category || ""),
            id: String(id || ""),
          });
        },
        setMasterToggle: function (enabled) { return invoke("routers_set_master_toggle", { enabled: !!enabled }); },
        testRouter:      function (id) { return invoke("routers_test_router", { id: String(id || "") }); },
        getKeyPreview:   function (id) { return invoke("routers_get_key_preview", { id: String(id || "") }); },
      },
      // ── providers (Settings → Models + Agents tile management) ──
      // Same shape as `routers` above. Secrets only on setKey + testConnection
      // (where the test consumes the user's draft input but doesn't persist).
      // listCatalog returns the static spec + per-provider state so the
      // renderer can render Settings from a single round-trip.
      providers: {
        listCatalog:      function () { return invoke("providers_list_catalog"); },
        setKey:           function (id, key) {
          return invoke("providers_set_key", {
            id: String(id || ""),
            key: String(key || ""),
          });
        },
        getKeyPreview:    function (id) { return invoke("providers_get_key_preview", { id: String(id || "") }); },
        deleteKey:        function (id) { return invoke("providers_delete_key", { id: String(id || "") }); },
        setEnabled:       function (id, enabled) {
          return invoke("providers_set_enabled", {
            id: String(id || ""),
            enabled: !!enabled,
          });
        },
        setDefault:       function (id) {
          return invoke("providers_set_default", { id: String(id || "") });
        },
        testConnection:   function (id, key) {
          return invoke("providers_test_connection", {
            id: String(id || ""),
            key: String(key || ""),
          });
        },
        ollamaProbe:      function (baseUrl) {
          return invoke("providers_ollama_probe", {
            baseUrl: baseUrl == null ? null : String(baseUrl),
          });
        },
        setEnabledModels: function (id, models) {
          return invoke("providers_set_enabled_models", {
            id: String(id || ""),
            models: Array.isArray(models) ? models.map(String) : [],
          });
        },
        setOllamaBaseUrl: function (baseUrl) {
          return invoke("providers_set_ollama_base_url", { baseUrl: String(baseUrl || "") });
        },
        // Fires when any providers_* mutation lands. Renderer's
        // useProvidersConfig store listens so cross-tab edits (e.g.
        // Settings → Models change while the chat composer is open)
        // refresh the picker without a manual reload.
        onChanged: function (cb) {
          var unsub = null;
          var e = ev();
          if (e) {
            e.listen("providers-config-changed", function (m) {
              try { cb(m && m.payload); } catch (_) {}
            }).then(function (u) { unsub = u; });
          }
          return function () { try { unsub && unsub(); } catch (_) {} };
        },
      },
      // ── github (mirrors window.electronAPI.github in the Electron build) ──
      // Token never crosses IPC; only `link` envelopes do. Faithful with
      // the original `electron/github-link.cjs` surface.
      github: {
        getLink:          function () { return invoke("github_get_link"); },
        beginOAuth:       function () { return invoke("github_begin_oauth"); },
        // Best-effort abort of the in-flight beginOAuth for this Fleetify
        // user. Resolves the awaiting beginOAuth promise with
        // { ok: false, code: "ABORTED" } so the Connect button re-enables
        // immediately. Safe to call on cleanup paths whether or not an
        // OAuth is actually running — backend treats no-attempt as ok.
        cancelOAuth:      function () { return invoke("github_cancel_oauth"); },
        disconnect:       function () { return invoke("github_disconnect"); },
        refreshLink:      function () { return invoke("github_refresh_link"); },
        openInstallation: function () { return invoke("github_open_installation"); },
        // Resolve the user's repo list: gh-first, OAuth fallback, else
        // { ok:false, code:"NOT_CONNECTED" }. Used by the Git source tab.
        listRepos:        function () { return invoke("github_list_repos"); },
        onLinkChanged: function (cb) {
          var unsub = null;
          Promise.resolve(window.__TAURI__.event.listen("github-link-changed", function (e) {
            try { cb(e && e.payload); } catch (_) {}
          })).then(function (u) { unsub = u; });
          return function () { try { unsub && unsub(); } catch (_) {} };
        },
        onBrowserFallback: function (cb) {
          var unsub = null;
          Promise.resolve(window.__TAURI__.event.listen("github-link-browser-fallback", function (e) {
            try { cb(e && e.payload); } catch (_) {}
          })).then(function (u) { unsub = u; });
          return function () { try { unsub && unsub(); } catch (_) {} };
        },
      },
      getGitContext: function (folder) { return invoke("git_get_context", { folder: String(folder || "") }); },
      hasGhCli: function (opts) {
        return invoke("git_has_gh_cli", { refresh: !!(opts && opts.refresh) });
      },
      // Probe whether `git` is on PATH. Returns { ok, version?, path? }.
      // Drives the WorktreeToggle in the New Session UI — without git
      // the toggle collapses into a "Git required" notice instead of
      // letting the user opt into a feature we can't deliver.
      hasGit: function () { return invoke("git_has_git"); },
      // ── Logging bridge ────────────────────────────────────────────
      // appLog routes one structured event into the backend's tracing
      // pipeline → stderr + NDJSON log file under the OS log dir.
      // logsExport bundles the last N days + system info into a zip
      // the user can attach to a bug report. logsOpenFolder reveals
      // the log dir in Explorer / Finder / xdg-open.
      appLog: function (level, target, message, fields) {
        return invoke("app_log", {
          level: String(level || "info"),
          target: String(target || "renderer"),
          message: String(message || ""),
          fields: fields == null ? null : fields,
        });
      },
      logsExport: function () { return invoke("logs_export"); },
      logsOpenFolder: function () { return invoke("logs_open_folder"); },
      listGitBranches: function (folder) { return invoke("git_list_branches", { folder: String(folder || "") }); },
      // Promote a branch as this clone's logical base branch (drives the
      // "Create new main branch" picker action). Carves it from the
      // current base if it doesn't exist yet, then pins it via
      // `git config fleetify.baseBranch`. Nondestructive — no rename,
      // no push, no change to remote `HEAD`.
      setBaseBranch: function (folder, branch) {
        return invoke("git_set_base_branch", {
          folder: String(folder || ""),
          branch: String(branch || ""),
        });
      },
      gitCheckout: function (folder, branch, force) { return invoke("git_checkout", { folder: String(folder || ""), branch: String(branch || ""), force: !!force }); },
      gitCommit: function (folder, message) { return invoke("git_commit", { folder: String(folder || ""), message: String(message || "") }); },
      gitPush: function (folder) { return invoke("git_push", { folder: String(folder || "") }); },
      gitEnsureRepo: function (folder, opts) {
        var o = opts || {};
        return invoke("git_ensure_repo", { folder: String(folder || ""), name: o.name || null, email: o.email || null });
      },
      gitPullLatest: function (folder, baseBranch) {
        return invoke("git_pull_latest", { folder: String(folder || ""), baseBranch: String(baseBranch || "main") });
      },
      gitDiffSummary: function (folder, baseBranch) {
        return invoke("git_diff_summary", { folder: String(folder || ""), baseBranch: String(baseBranch || "main") });
      },
      openPR: function (folder) { return invoke("git_open_pr", { folder: String(folder || "") }); },
      createPR: function (folder, opts) {
        var o = opts || {};
        return invoke("git_create_pr", {
          folder: String(folder || ""),
          title: String(o.title || ""),
          body: o.body || null,
          base: o.base || null,
          draft: !!o.draft,
          featureBranch: o.featureBranch || null,
          tool: o.tool || null,
          // "gh" | "cli" → GitHub CLI only, "oauth" | "link" → Fleetify
          // OAuth only, omitted → backend picks (gh-first / link fallback).
          method: o.method || null,
        });
      },
      getPRStatus: function (folder, prNumber) {
        return invoke("git_get_pr_status", {
          folder: String(folder || ""),
          prNumber: prNumber == null ? null : Number(prNumber),
        });
      },
      listPRs: function (folder, limit) {
        return invoke("git_list_prs", {
          folder: String(folder || ""),
          limit: limit == null ? null : Number(limit),
        });
      },
      mergePR: function (folder, prNumber, method) {
        return invoke("git_merge_pr", {
          folder: String(folder || ""),
          prNumber: Number(prNumber),
          method: method || "merge",
        });
      },
      markPRReady: function (folder, prNumber) {
        return invoke("git_pr_ready", {
          folder: String(folder || ""),
          prNumber: Number(prNumber),
        });
      },
      syncMain: function (folder, baseBranch) {
        return invoke("git_sync_main", { folder: String(folder || ""), baseBranch: String(baseBranch || "main") });
      },
      carveNextRound: function (folder, branch, baseBranch) {
        return invoke("git_carve_next_round", {
          folder: String(folder || ""), branch: String(branch || ""), baseBranch: String(baseBranch || "main"),
        });
      },
      preflightCheck: function (folder) { return invoke("git_preflight_check", { folder: String(folder || "") }); },
      ptySpawn: function (opts) {
        var o = opts || {};
        return invoke("pty_spawn", {
          shell: o.shell || null, cwd: o.cwd || null, env: o.env || null,
        });
      },
      ptyWrite: function (id, data) { return invoke("pty_write", { id: String(id), data: String(data) }); },
      ptyResize: function (id, cols, rows) { return invoke("pty_resize", { id: String(id), cols: Number(cols) | 0, rows: Number(rows) | 0 }); },
      ptyKill: function (id) { return invoke("pty_kill", { id: String(id) }); },
      onPtyData: function (id, cb) {
        var un = null;
        var e = ev();
        if (e) {
          e.listen("pty:data:" + id, function (m) { cb((m.payload && m.payload.data) || ""); })
            .then(function (u) { un = u; });
        }
        return function () { if (un) un(); };
      },
      onPtyExit: function (id, cb) {
        var un = null;
        var e = ev();
        if (e) {
          e.listen("pty:exit:" + id, function (m) { cb(m.payload || {}); })
            .then(function (u) { un = u; });
        }
        return function () { if (un) un(); };
      },
    },
    {
      get: function (t, k) {
        if (k in t) return t[k];
        if (typeof k === "string" && k.indexOf("on") === 0) return evNoop;
        return asyncNoop;
      },
    }
  );
})();
