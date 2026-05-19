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

interface FleetConfig {
  onboardingComplete: boolean;
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
    setConfig: (config: FleetConfig) => Promise<boolean>;
    openFolderDialog: () => Promise<string | null>;
    setWindowSize: (
      width: number,
      height: number,
      opts?: { center?: boolean; animate?: boolean }
    ) => Promise<boolean>;
    setTrafficLightPosition: (x: number, y: number) => Promise<boolean>;
    minimizeWindow: () => Promise<boolean>;
    maximizeWindow: () => Promise<boolean>;
    closeWindow:    () => Promise<boolean>;
    installProvider: (
      toolKey: string
    ) => Promise<{ success: boolean; output?: string; error?: string }>;
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
    authProvider: (
      toolKey: string
    ) => Promise<{
      ok: boolean;
      urlOpened?: boolean;
      exitCode?: number | null;
      error?: string;
    }>;
    checkGithubAuth: () => Promise<{
      ok: boolean;
      username?: string;
      error?: string;
    }>;
    onAuthUrl: (
      cb: (info: { toolKey: string; url: string }) => void
    ) => () => void;
    openExternal: (url: string) => Promise<boolean>;
    showItemInFolder: (path: string) => Promise<boolean>;
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

    // ── Git branch picker ──
    listGitBranches: (folder: string) => Promise<{
      current: string | null;
      local: string[];
      remote: string[];
    }>;
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
      disconnect: () => Promise<{ ok: boolean; error?: string }>;
      refreshLink: () => Promise<
        | { ok: true; link: GitHubLinkPayload }
        | { ok: false; code: string; error: string }
      >;
      openInstallation: () => Promise<{ ok: boolean; error?: string }>;
      onLinkChanged: (cb: (payload: { link: GitHubLinkPayload | null }) => void) => () => void;
      offLinkChanged: (cb: (payload: { link: GitHubLinkPayload | null }) => void) => void;
      onBrowserFallback: (cb: (payload: { url: string }) => void) => () => void;
      offBrowserFallback: (cb: (payload: { url: string }) => void) => void;
    };
  };
}
