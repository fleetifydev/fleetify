/// <reference types="vite/client" />

interface FileEntry {
  name: string;
  type: "file" | "folder";
  path: string;
}

interface FileContent {
  content?: string;
  size?: number;
  error?: string;
}

interface GitHubRepoEntry {
  nameWithOwner: string;
  description: string | null;
  url: string;
  sshUrl: string;
  isPrivate: boolean;
  updatedAt: string;
}

interface GitHubLinkPayload {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  github_login: string;
  github_user_id: number;
  github_avatar_url: string;
  installation_id: number;
  connected_at: string;
}

interface RouterTileMetadata {
  id: string;
  display_name: string;
  capabilities: ("decision" | "proxy")[];
  modes: ("managed" | "self_hosted")[];
  connected: boolean;
  active_for_decision: boolean;
  active_for_proxy: boolean;
  metadata?: Record<string, unknown> | null;
}

type RoutersListResult =
  | { ok: true; tiles: RouterTileMetadata[]; enabled: boolean }
  | { ok: false; error: string; tiles: RouterTileMetadata[]; enabled: boolean };

type RoutersConnectResult =
  | { ok: true }
  | { ok: false; code: "NO_USER" | "KEYCHAIN" | "CONFIG"; error: string };

type RoutersTestResult =
  | { ok: true; always_available?: boolean; has_secret?: boolean }
  | { ok: false; code: "NO_USER" | "NO_SECRET" | "KEYCHAIN"; error?: string };

type RoutersKeyPreviewResult =
  | { ok: true; preview: string | null }
  | { ok: false; code: "NO_USER" | "KEYCHAIN"; error?: string };

interface PythonRuntimeResult {
  installed: boolean;
  version: string | null;
  path: string | null;
}

interface FleetConfig {
  onboardingComplete: boolean;
  /** Device-scoped "first-launch tour seen" flag. Durable (lives in
   *  fleet.config.json, like onboardingComplete) so the guided tour fires
   *  once per device and never returns across port / run-mode / reinstall
   *  changes — the old localStorage marker is origin-scoped and got dropped,
   *  which made the tour replay on every launch. */
  tourComplete?: boolean;
  apiKeys: {
    anthropic?: string;
    openai?: string;
    gemini?: string;
    groq?: string;
  };
  projectPath?: string;
  userName?: string;
  gitName?: string;
  gitEmail?: string;
  defaultFolder?: string;
  /** Default agent permission mode for new sessions. */
  permissionMode?: "ask" | "auto-safe" | "auto-all";
  /** Monthly cost cap in USD; null/undefined means no cap. */
  monthlyBudgetUsd?: number | null;
  /** Default provider Fleet drives when multiple are configured. */
  defaultProvider?: string;
  /** GitHub personal access token (kept locally, never round-tripped). */
  githubToken?: string;
  /** GitHub login (e.g. "octocat") returned by /user when the token validated. */
  githubUsername?: string;
  /** Default model for new agent sessions. Persisted from Settings → Models. */
  defaultModel?: string;
  /** Sessions Default — the provider a brand-new manual session opens with.
   *  Distinct from `defaultProvider` (the Fleet default): when set it takes
   *  precedence in `openComposer`. Settings → Providers → "Sessions Default". */
  sessionDefaultProvider?: string;
  /** Sessions Default model — paired with `sessionDefaultProvider`. */
  sessionDefaultModel?: string;
  /** Sessions Default reasoning effort — paired with `sessionDefaultProvider`.
   *  Seeds a new session's effort in `openComposer`; only meaningful for models
   *  that expose an effort lever. Settings → Providers → "Sessions Default". */
  sessionDefaultEffort?: "low" | "medium" | "high" | "extra_high" | "max" | "ultra_code";
  /** Master toggle for OS-level notifications (completion, errors,
   *  budget warnings). When false, all per-event notification toggles are
   *  ignored. Default true. */
  notificationsEnabled?: boolean;
  /** Toggle for "notify me when an agent errors out". Default true. */
  notifyErrorsEnabled?: boolean;
  /** Toggle for "notify me when an agent nears its budget cap". Default true. */
  notifyBudgetEnabled?: boolean;
  /** Mute all notifications regardless of the other toggles. Default false. */
  doNotDisturb?: boolean;
  /** Launch Fleetify on system startup. Default false. Honored when the
   *  Tauri autostart plugin is wired; otherwise the toggle stores intent
   *  only and surfaces a "Restart required" hint. */
  launchOnStartup?: boolean;
  /** Restore the last session on launch (vs. start at the workspace
   *  picker). Default true. */
  restoreLastSession?: boolean;
  /** Automatic updates: check when Fleetify starts and every six hours, and
   *  download a newer version in the background; it installs on Restart to
   *  update. Default true; anything but `false` counts as on, as the shell
   *  reads it (`auto_updates_enabled`). Settings → General → Updates. */
  updatesAuto?: boolean;
  /** Ignored. Written by the old "Update channel" row; Fleetify has one
   *  stable channel, and nothing reads this. */
  updatesChannel?: "stable" | "beta" | "canary";
  /** Legacy: written by the old privacy card's analytics switch; nothing
   *  writes it now. An explicit `false` still counts as a saved dashboard
   *  sync opt-out while no newer choice is saved (`cloud_choice_from` in
   *  the shell). */
  telemetryEnabled?: boolean;
  /** Legacy: written by the old "Crash reports" switch. Nothing reads it. */
  crashReportsEnabled?: boolean;
  /** Credit Fleetify in the commits it makes (`Co-Authored-By: Fleetify`
   *  trailer) and the pull requests it opens (footer). Default true;
   *  anything but `false` counts as on. Read by the shell on every
   *  Create-PR. Settings → General → Attribution. */
  gitAttribution?: boolean;
  /** Keep Fleetify running when its window is closed: the window hides,
   *  and Fleetify stays in the notification area on Windows (its icon opens
   *  the window again and quits) or in the Dock on macOS. Default true;
   *  anything but `false` counts as on, as the shell reads it, each time the
   *  window is closed (`keep_running_from`). Linux ignores it: closing the
   *  window quits. Settings → General → Window. */
  keepRunningOnClose?: boolean;
}

interface Window {
  electronAPI?: {
    platform: string;
    readDirectory: (dirPath: string) => Promise<FileEntry[]>;
    readFile: (filePath: string) => Promise<FileContent>;
    getProjectRoot: () => Promise<string>;
    getExtension: (filePath: string) => Promise<string>;
    scaffoldPlugin: (opts: {
      parentFolder: string;
      pluginSlug: string;
      files: Record<string, string>;
    }) => Promise<{ path?: string; written?: string[]; error?: string }>;
    getConfig: () => Promise<FleetConfig | null>;
    /** Replaces fleet.config.json. A save that failed answers
     *  `{ ok: false, error }` instead of throwing. */
    setConfig: (config: FleetConfig) => Promise<{ ok: boolean; error?: string }>;
    /** Read backend-owned telemetry config: stable per-machine
     *  distinct_id (= device.json device_id), and whether product
     *  analytics (PostHog) and Fleetify cloud sync are on right now (the
     *  backend's live gates). Called at boot to decide whether to start
     *  posthog-js, with the same id the Rust sink uses. `cloud_choice` is
     *  the saved dashboard sync choice, null while there is none: sync
     *  stays off until the dashboard question is answered (onboarding's
     *  step, or <DashboardSyncNotice>). */
    telemetryGetConfig?: () => Promise<{
      distinct_id: string;
      posthog_enabled: boolean;
      cloud_enabled: boolean;
      cloud_choice: boolean | null;
    }>;
    /** Flip the persisted PostHog opt-in AND the backend's live
     *  runtime gate. Used by the onboarding consent step and the
     *  Privacy settings toggle. `ok: false` means the gate changed but
     *  the choice wasn't saved, so it lasts until Fleetify restarts. */
    telemetrySetPosthogEnabled?: (
      enabled: boolean
    ) => Promise<import("@/lib/privacy-choice").PrivacySaveResult>;
    /** Flip the persisted Fleetify cloud sync switch AND the backend's
     *  live gate. Turning it off purges anything still queued. Resolves
     *  like `telemetrySetPosthogEnabled`. */
    telemetrySetCloudEnabled?: (
      enabled: boolean
    ) => Promise<import("@/lib/privacy-choice").PrivacySaveResult>;
    openFolderDialog: () => Promise<string | null>;
    setWindowSize: (
      width: number,
      height: number,
      opts?: { center?: boolean; animate?: boolean }
    ) => Promise<boolean>;
    /** Swap the OS taskbar icon at runtime so it stays legible against
     *  light/dark Windows themes. Pass "dark" (dark logo) for light
     *  systems and "light" (light logo) for dark systems. */
    setTaskbarIcon: (
      variant: "light" | "dark"
    ) => Promise<{ ok: boolean; variant?: string; error?: string }>;
    /** Whether closing the window keeps Fleetify running here, as the
     *  shell decides each close: on Windows only while the
     *  notification-area icon is there, on macOS always, on Linux never.
     *  Settings → General → Window. */
    windowCanKeepRunning?: () => Promise<boolean>;
    setTrafficLightPosition: (x: number, y: number) => Promise<boolean>;
    minimizeWindow: () => Promise<boolean>;
    maximizeWindow: () => Promise<boolean>;
    closeWindow:    () => Promise<boolean>;
    installProvider: (
      toolKey: string
    ) => Promise<{ success: boolean; output?: string; error?: string }>;
    checkPythonRuntime: () => Promise<PythonRuntimeResult>;
    installOllama: () => Promise<{
      success: boolean;
      output?: string;
      error?: string;
      /** True when the handler couldn't run a platform installer and
       *  fell back to opening ollama.com/download in the user's
       *  browser. The renderer should leave the row in a "watching"
       *  state and let the scan poll detect manual install. */
      openedBrowser?: boolean;
    }>;
    checkGithubAuth: () => Promise<{
      ok: boolean;
      username?: string;
      error?: string;
    }>;
    /** Spawns `gh auth login --web` in a fresh terminal window so the
     *  user can complete the device-code flow interactively. The
     *  renderer should poll `hasGhCli()` after to detect completion. */
    ghAuthLoginLaunch: () => Promise<{ ok: boolean; error?: string }>;
    /** In-process gh auth flow: spawns `gh auth login --web` under a PTY
     *  and emits `gh-auth-event` payloads (phase: "code" | "url" | "log"
     *  | "done") so the renderer can surface the one-time device code
     *  inside the app. Resolves once gh exits — `done` events also fire
     *  on the listener so the UI can react without awaiting the promise. */
    ghAuthLoginCapture: () => Promise<
      | { ok: true; login?: string | null }
      | { ok: false; error?: string }
    >;
    /** Kills the gh process started by ghAuthLoginCapture (if any).
     *  Safe to call when nothing is running — returns {ok:true} either way. */
    ghAuthLoginCancel: () => Promise<{ ok: boolean }>;
    /** Subscribe to streaming updates from ghAuthLoginCapture. Phases:
     *   - "code": one-time device code is ready (display it prominently)
     *   - "url":  verification URL (open in browser)
     *   - "log":  verbatim line from gh (for debugging only)
     *   - "done": gh exited; ok flag + resolved login (or error) */
    onGhAuthEvent: (
      cb: (payload:
        | { phase: "code"; code: string }
        | { phase: "url"; url: string }
        | { phase: "log"; line: string }
        | { phase: "done"; ok: boolean; login?: string | null; error?: string | null }
      ) => void
    ) => () => void;
    /** Probes gh CLI presence + auth state. Returns `ok: false` when
     *  the binary isn't on PATH; otherwise reports version + authed
     *  flag + login. Used by the onboarding GitHub picker and the
     *  mid-flow Create-PR auth dialog. */
    hasGhCli: () => Promise<{
      ok: boolean;
      version?: string;
      authed?: boolean;
      ghLogin?: string | null;
      error?: string | null;
    }>;
    /** Probes whether the `git` binary is on PATH. Drives the
     *  WorktreeToggle in the New Session UI — `ok:false` collapses
     *  the toggle into a "Git required" notice. */
    hasGit: () => Promise<{
      ok: boolean;
      version?: string;
      path?: string;
    }>;
    /** Route one structured event from the renderer into the backend
     *  tracing pipeline. Lands in stderr (dev) + the on-disk NDJSON
     *  log file (`fleetify.log.YYYY-MM-DD`). Pair with `lib/log.ts`
     *  which batches these calls under the hood. */
    appLog: (
      level: "trace" | "debug" | "info" | "warn" | "error",
      target: string,
      message: string,
      fields?: Record<string, unknown> | null,
    ) => Promise<{ ok: boolean }>;
    /** Bundle the on-disk log files + system info into a single zip.
     *  Opens a Save As dialog (default location ~/Downloads with a
     *  timestamped suggested filename); the renderer reveals the result
     *  with selection via `showItemInFolder`. Returns `cancelled: true`
     *  when the user closes the dialog so the UI can stay quiet rather
     *  than flashing an error toast. */
    logsExport: () => Promise<
      | { ok: true; path: string; bytes: number }
      | { ok: false; cancelled?: boolean; error?: string }
    >;
    /** Reveal the log directory in Explorer / Finder / xdg-open. */
    logsOpenFolder: () => Promise<
      | { ok: true; path: string }
      | { ok: false; error: string }
    >;
    openExternal: (url: string) => Promise<boolean>;
    showItemInFolder: (path: string) => Promise<boolean>;
    /** Open a local folder, or a document file (Markdown, JSON, TOML, YAML,
     *  text…), with the system's default handler. Anything else is refused. */
    openPath: (path: string) => Promise<{ ok: boolean; error?: string }>;
    writeText: (text: string) => Promise<boolean>;

    // ── PTY bridge ──
    ptySpawn: (opts?: {
      cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[];
    }) => Promise<
      | { ok: true; id: string; pid: number; shell: string; cwd: string }
      | { ok: false; error: string }
    >;
    ptyWrite:  (id: string, data: string) => Promise<boolean>;
    ptyResize: (id: string, cols: number, rows: number) => Promise<boolean>;
    ptyKill:   (id: string) => Promise<boolean>;
    /** Full output a PTY has emitted so far (capped tail) — used to recover
     *  early output dropped by an async `pty:data` listener registration. */
    ptyBuffer: (id: string) => Promise<{ ok: boolean; data: string }>;

    // ── Git branch picker ──
    listGitBranches: (folder: string) => Promise<{
      current: string | null;
      local: string[];
      remote: string[];
    }>;
    /** Pin a branch as this clone's logical base — drives the "Create
     *  new main branch" picker action. Carves it from the current base
     *  if missing, then writes `git config fleetify.baseBranch <name>`.
     *  Nondestructive: doesn't push, rename, or change remote HEAD. */
    setBaseBranch: (
      folder: string,
      branch: string,
    ) => Promise<{ ok: boolean; base?: string; error?: string }>;
    /** `gh pr list --json number,state,headRefName,...` — drives the
     *  per-branch PR badge in BranchPickerMenu without paying for one
     *  `gh pr view` per row. */
    listPRs: (folder: string, limit?: number | null, authMethod?: string | null, authStored?: string | null) => Promise<{
      ok: boolean;
      prs?: Array<{
        number: number;
        state: string;
        headRefName: string;
        isDraft?: boolean;
        mergeable?: string;
      }>;
      error?: string;
    }>;
    /** Carve a fresh `fleet/<topic>-<sha>` branch off `baseBranch`
     *  and switch to it. Used by both the post-merge cleanup and the
     *  BranchPickerMenu's "Create new branch" button. */
    carveNextRound: (
      folder: string,
      branch: string,
      baseBranch?: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    gitCheckout: (
      folder: string,
      branch: string,
      force?: boolean,
    ) => Promise<{ ok: boolean; error?: string }>;
    gitEnsureRepo: (
      folder: string,
      opts?: { name?: string; email?: string },
    ) => Promise<{ ok: boolean; initialized: boolean; error?: string }>;
    onPtyData: (id: string, cb: (data: string) => void) => () => void;
    onPtyExit: (id: string, cb: (info: { exitCode: number; signal?: number }) => void) => () => void;

    // ── GitHub link bridge (OAuth fallback for PR creation) ──
    github?: {
      getLink: () => Promise<{ ok: boolean; link: GitHubLinkPayload | null; error?: string }>;
      beginOAuth: () => Promise<
        | { ok: true; link: GitHubLinkPayload }
        | { ok: false; code: string; error: string }
      >;
      /** Best-effort abort of an in-flight `beginOAuth`. Idempotent —
       *  the backend treats "no attempt in flight" as ok. Resolves the
       *  awaiting beginOAuth promise with code === "ABORTED". */
      cancelOAuth: () => Promise<{ ok: boolean }>;
      disconnect: () => Promise<{ ok: boolean; error?: string }>;
      refreshLink: () => Promise<
        | { ok: true; link: GitHubLinkPayload }
        | { ok: false; code: string; error: string }
      >;
      openInstallation: () => Promise<{ ok: boolean; error?: string }>;
      /** Resolve the user's repos: gh-first → OAuth fallback → not connected. */
      listRepos: () => Promise<
        | { ok: true; source: "gh" | "oauth"; repos: GitHubRepoEntry[] }
        | { ok: false; code: "NOT_CONNECTED" | "GH_AUTH" | "ERROR"; error?: string }
      >;
      onLinkChanged: (cb: (payload: { link: GitHubLinkPayload | null }) => void) => () => void;
      offLinkChanged: (cb: (payload: { link: GitHubLinkPayload | null }) => void) => void;
      onBrowserFallback: (cb: (payload: { url: string }) => void) => () => void;
      offBrowserFallback: (cb: (payload: { url: string }) => void) => void;
    };

    // ── Routers bridge (Settings → Routers tile management) ──
    routers?: {
      list: () => Promise<RoutersListResult>;
      connect: (
        id: string,
        secret: string,
        metadata: Record<string, unknown>,
      ) => Promise<RoutersConnectResult>;
      disconnect: (id: string) => Promise<{ ok: boolean }>;
      setActive: (
        category: "decision" | "proxy",
        id: string,
      ) => Promise<{ ok: boolean; error?: string }>;
      setMasterToggle: (
        enabled: boolean,
      ) => Promise<{ ok: boolean; error?: string }>;
      testRouter: (id: string) => Promise<RoutersTestResult>;
      getKeyPreview: (id: string) => Promise<RoutersKeyPreviewResult>;
    };
  };
}
