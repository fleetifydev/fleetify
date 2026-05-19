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
    // Feedback bridge lands with the github/feedback IPC in a later phase.
    sendFeedback: function () {
      return Promise.resolve({ ok: false, error: "not-implemented", status: -1 });
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
      openExternal: function (url) { return invoke("shell_open_external", { url: String(url || "") }); },
      showItemInFolder: function (p) { return invoke("shell_show_item_in_folder", { path: String(p || "") }); },
      writeText: function (t) { return invoke("clipboard_write", { text: String(t || "") }); },
      minimizeWindow: function () { return invoke("window_minimize"); },
      maximizeWindow: function () { return invoke("window_maximize"); },
      closeWindow: function () { return invoke("window_close"); },
      setWindowSize: function (w, h) { return invoke("window_set_size", { width: Number(w), height: Number(h) }); },
      readDirectory: function (p) { return invoke("fs_read_directory", { dirPath: String(p || "") }); },
      readFile: function (p) { return invoke("fs_read_file", { filePath: String(p || "") }); },
      getExtension: function (p) { return invoke("fs_get_extension", { filePath: String(p || "") }); },
      getProjectRoot: function () { return invoke("fs_get_project_root"); },
      openFolderDialog: function () { return invoke("dialog_open_folder"); },
      getGitContext: function (folder) { return invoke("git_get_context", { folder: String(folder || "") }); },
      hasGhCli: function () { return invoke("git_has_gh_cli"); },
      listGitBranches: function (folder) { return invoke("git_list_branches", { folder: String(folder || "") }); },
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
