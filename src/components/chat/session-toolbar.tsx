/**
 * SessionToolbar — chip row above the chat input for an agent session.
 *
 * Reference shape (Claude Code):
 *
 *   [💻 Local]  [📁 maestro]  [🌿 main | ☑ worktree]  [✦ Claude · Sonnet]  [🔒 Ask]  [📝 Note]  [+]
 *
 * Each chip is a self-contained micro-control. Most open a small
 * popover; folder opens the OS dialog directly; the worktree
 * checkbox toggles inline. Notes get their own popover with a
 * textarea so the user can attach context to the session without
 * needing to send it as a chat message.
 *
 * Visual language: Fleet's chip surface (--c-srf2 / --c-brd / 7px
 * radius / Geist sans), the existing ProviderLogo SVGs for Claude /
 * Codex / Gemini, and lucide icons for the rest. Active chip pulls
 * the brighter --c-brd2 border and a slightly elevated background;
 * hover does the same. Required-but-empty (folder) wears a soft
 * amber dot top-right of its icon — same calm cue used elsewhere.
 *
 * Persistence:
 *   - folder, tool, model_name, permission_mode, notes → PATCH
 *     /sessions/:id immediately on change. No "save" button.
 *   - worktree toggle is local-only for now (real wiring lives in
 *     the existing per-session worktree creation on PATCH).
 */
import { useState, useEffect, useRef, useCallback } from "react";
import {
  FolderOpen, Monitor, Lock, History, Plus, Check, ChevronDown,
  GitBranch, Search as SearchIcon,
  Search, Github, Server, Box,
} from "lucide-react";
import { ClaudeLogo, OpenAILogo, GeminiLogo, ProviderLogo } from "@/components/ui/provider-logo";
import { updateSession as apiUpdateSession, cloneRepository, listUserRepos, listModels, fetchClaudeSessions, fetchClaudeHistory, type ClaudeSession, type GhRepo, type CatalogProvider } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import type { ChatMessage } from "@/types/chat";
import type { Session } from "@/types/session";
import { RemoteSshPanel } from "./remote-ssh-panel";
import { DockerContainerPanel } from "./docker-container-panel";
import { folderName as folderNameUtil } from "@/lib/utils";

type MenuId = "source" | "git" | "model" | "perms" | "history" | null;

interface ProviderDef {
  id: "claude" | "codex" | "gemini" | "openai";
  label: string;
  Logo: React.FC<{ size?: number }>;
  /** ctx field mirrors the chat-input MODELS table so the toolbar
   *  surfaces the same context-window label the bottom-right "Sonnet
   *  4.6 1M · High" indicator shows. note is optional and lights a
   *  small "Preview" / "Legacy" pill next to the row. */
  models: { id: string; label: string; ctx: string; note?: string }[];
}

// Provider logos — picked by id when we render a fetched provider.
// Looking these up by literal id keeps the fetched catalog flexible
// (backend can add a provider without us shipping a new logo, the UI
// just falls back to the OpenAI mark for unknown providers).
const PROVIDER_LOGOS: Record<string, React.FC<{ size?: number }>> = {
  claude: ClaudeLogo,
  codex:  OpenAILogo,
  openai: OpenAILogo,
  gemini: GeminiLogo,
};

// Hardcoded fallback — used when the /api/models fetch fails (no
// backend, auth blip, cold start). Mirrors backend/app/utils/models.py
// in shape but trimmed to the Sonnet/Opus/etc. set the user is most
// likely to reach for.
const FALLBACK_PROVIDERS: ProviderDef[] = [
  { id: "claude", label: "Claude", Logo: ClaudeLogo, models: [
    { id: "claude-opus-4-7",           label: "Opus 4.7",   ctx: "200K" },
    { id: "claude-sonnet-4-6",         label: "Sonnet 4.6", ctx: "200K" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5",  ctx: "200K" },
  ]},
  { id: "codex",  label: "Codex",  Logo: OpenAILogo, models: [
    { id: "gpt-5.2", label: "GPT-5.2", ctx: "200K" },
    { id: "gpt-5.4", label: "GPT-5.4", ctx: "200K" },
    { id: "gpt-5.5", label: "GPT-5.5", ctx: "200K" },
  ]},
  { id: "openai", label: "OpenAI", Logo: OpenAILogo, models: [
    { id: "gpt-4o",      label: "GPT-4o",  ctx: "128K" },
    { id: "gpt-4o-mini", label: "4o mini", ctx: "128K" },
    { id: "o3",          label: "o3",      ctx: "200K" },
  ]},
  { id: "gemini", label: "Gemini", Logo: GeminiLogo, models: [
    { id: "gemini-3.1-pro-preview",        label: "3.1 Pro",  ctx: "1M" },
    { id: "gemini-3-flash-preview",        label: "3 Flash",  ctx: "1M" },
    { id: "gemini-3.1-flash-lite-preview", label: "3.1 Lite", ctx: "1M" },
  ]},
];

const PERMS: { id: string; label: string; desc: string }[] = [
  { id: "default",           label: "Ask",          desc: "Confirm before edits & shell" },
  { id: "acceptEdits",       label: "Accept edits", desc: "Auto-approve file edits" },
  { id: "bypassPermissions", label: "Bypass permissions", desc: "All tools without asking" },
  { id: "plan",              label: "Plan only",    desc: "No execution — just a plan" },
];

export function SessionToolbar({
  sessionId,
  projectPath,
  tool,
  model,
  permissionMode,
  claudeSessionId,
  useWorktree,
}: {
  sessionId: string;
  projectPath: string | null;
  tool: string;
  model: string | null;
  permissionMode: string;
  /** Currently-selected Claude CLI session UUID to resume from.
   *  Drives the History chip's "selected" badge + loaded-history
   *  state. Null when starting fresh. */
  claudeSessionId: string | null;
  /** Whether the session should run inside a per-session worktree
   *  (Conductor-style isolated checkout) or directly in project_path
   *  (single-tree mode). Drives the Worktree chip's on/off state. */
  useWorktree: boolean;
}) {
  const updateSessionLocal = useAppStore(s => s.updateSession);
  const setDraftField      = useAppStore(s => s.setDraftField);
  const setMessages        = useChatStore(s => s.setMessages);
  // Are we configuring an in-flight (compose-phase) session right now?
  // When true, the chip strip writes to the local-only session entry
  // only — NO backend PATCH, NO worktree creation, NO row anywhere —
  // because the session doesn't exist server-side yet. The first user
  // message will commit it via commitDraft().
  const session = useAppStore(s => s.sessions.find(x => x.id === sessionId));
  const isDraft = session?.local_only === true;
  const [openMenu, setOpenMenu] = useState<MenuId>(null);

  // ── Git branch chip data ──
  // Reads the picked folder's local + remote branches via the
  // Electron IPC (which shells out to `git for-each-ref`). Refreshed
  // whenever the folder changes; debounced so picking a folder then
  // browsing branches doesn't race the IPC.
  const [branches, setBranches]       = useState<{ local: string[]; remote: string[]; current: string | null }>({ local: [], remote: [], current: null });
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchFilter, setBranchFilter]       = useState("");
  const [branchSwitching, setBranchSwitching] = useState(false);
  const branchesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadBranches = useCallback(async () => {
    if (!projectPath || !window.electronAPI?.listGitBranches) {
      setBranches({ local: [], remote: [], current: null });
      return;
    }
    setBranchesLoading(true);
    try {
      // Conductor-style auto-init: if this folder isn't a git repo
      // yet, lay one down with the Fleet user's identity baked into
      // the initial commit so every project is git-managed from
      // first open. ensureRepo is a no-op when the folder is
      // already a repo, so it's safe to call on every reload.
      try {
        let name: string | undefined;
        let email: string | undefined;
        const raw = localStorage.getItem("fleet:user");
        if (raw) {
          const u = JSON.parse(raw) as { name?: string; email?: string };
          name = u?.name; email = u?.email;
        }
        await window.electronAPI?.gitEnsureRepo?.(projectPath, { name, email });
      } catch { /* non-fatal — fall through, list will just be empty */ }
      const r = await window.electronAPI.listGitBranches(projectPath);
      setBranches(r ?? { local: [], remote: [], current: null });
    } catch {
      setBranches({ local: [], remote: [], current: null });
    } finally {
      setBranchesLoading(false);
    }
  }, [projectPath]);
  useEffect(() => {
    setBranches({ local: [], remote: [], current: null });
    if (!projectPath) return;
    if (branchesTimer.current) clearTimeout(branchesTimer.current);
    branchesTimer.current = setTimeout(() => { void reloadBranches(); }, 250);
    return () => {
      if (branchesTimer.current) clearTimeout(branchesTimer.current);
    };
  }, [projectPath, reloadBranches]);

  // ── History chip data ──
  // Claude Code stores every conversation as a JSONL file under
  // ~/.claude/projects/<encoded-path>/<uuid>.jsonl. The backend's
  // /api/claude-sessions endpoint walks that directory for the picked
  // folder and returns the list (id, summary, mtime). We fetch on
  // every project_path change so the History chip reflects the
  // *picked folder's* native CLI history — NOT Fleet's own session
  // list (the sidebar already shows that). Picking an entry sets
  // claude_session_id on the current session so the next dispatch
  // resumes that conversation instead of starting fresh.
  const [cliHistory, setCliHistory] = useState<ClaudeSession[]>([]);
  const [cliHistoryLoading, setCliHistoryLoading] = useState(false);
  const cliHistoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Reset immediately when the folder changes so stale entries don't
    // flash before the next fetch settles.
    setCliHistory([]);
    if (!projectPath || tool !== "claude") return;
    if (cliHistoryTimer.current) clearTimeout(cliHistoryTimer.current);
    cliHistoryTimer.current = setTimeout(async () => {
      setCliHistoryLoading(true);
      try {
        const rows = await fetchClaudeSessions(projectPath);
        // Filter out empty / system-leaked previews — same heuristic
        // the legacy new-agent dialog used. Avoids surfacing rows
        // whose summary is "<local-command-stdout>" or "No
        // conversations found".
        const clean = rows.filter(r =>
          r.summary
          && !r.summary.includes("<local-command-stdout>")
          && !r.summary.toLowerCase().startsWith("no conversations found")
          && r.summary.trim().length > 0
        );
        setCliHistory(clean);
      } catch { setCliHistory([]); }
      finally { setCliHistoryLoading(false); }
    }, 350);
    return () => {
      if (cliHistoryTimer.current) clearTimeout(cliHistoryTimer.current);
    };
  }, [projectPath, tool]);
  // Clone-from-URL inline state. Lives in the folder picker popover:
  // the user types a git URL, hits Clone, we fetch backend, on success
  // the popover closes and the new path PATCHes through the existing
  // project_path flow (which auto-creates the worktree).
  const [cloneUrl,    setCloneUrl]    = useState("");
  const [cloning,     setCloning]     = useState(false);
  const [cloneError,  setCloneError]  = useState<string | null>(null);
  // Source tab — Local (browse), Git (user's GitHub repos + URL),
  // Remote (SSH host management), Container (running Docker containers).
  const [sourceTab,   setSourceTab]   = useState<"local" | "git" | "remote" | "container">("local");
  // GitHub repo list state — lazy-loaded the first time the user
  // switches to the Git tab so we don't hit gh on every toolbar mount.
  const [ghRepos,        setGhRepos]        = useState<GhRepo[] | null>(null);
  const [ghReposLoading, setGhReposLoading] = useState(false);
  const [ghReposError,   setGhReposError]   = useState<string | null>(null);
  const [repoFilter,     setRepoFilter]     = useState("");
  // Fetched model catalog — replaces the hardcoded list once /api/models
  // returns. Falls back to FALLBACK_PROVIDERS during the in-flight
  // window or when the API is unreachable.
  const [providers, setProviders] = useState<ProviderDef[]>(FALLBACK_PROVIDERS);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Pull the full provider/model catalog from the backend once. Any
  // failure leaves the fallback in place — the picker stays usable.
  useEffect(() => {
    let cancelled = false;
    listModels().then(r => {
      if (cancelled) return;
      if (!r.providers || r.providers.length === 0) return;
      const mapped: ProviderDef[] = r.providers
        // Only keep providers the bridge can actually drive. Filter
        // happens BEFORE the map so the resulting items are typed
        // narrowly enough to satisfy ProviderDef["id"].
        .filter((p: CatalogProvider) =>
          p.id === "claude" || p.id === "codex" || p.id === "openai" || p.id === "gemini"
        )
        .map((p: CatalogProvider) => ({
          id: p.id as ProviderDef["id"],
          label: p.label,
          Logo: PROVIDER_LOGOS[p.id] ?? OpenAILogo,
          models: p.models.map(m => ({
            id: m.id, label: m.label, ctx: m.ctx ?? "", note: m.note,
          })),
        }));
      if (mapped.length > 0) setProviders(mapped);
    }).catch(() => { /* silent — fallback already wired */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  // Open the source picker on a specific tab when an external
  // affordance asks (the Fleet hub's empty-state cards). Window
  // event so any caller can opt in without the toolbar exposing a
  // ref. Detail can be "local" / "git" / "remote" / "container";
  // unknown values are ignored.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: "local" | "git" | "remote" | "container" }>).detail;
      const tab = detail?.tab;
      if (tab === "local" || tab === "git" || tab === "remote" || tab === "container") {
        setSourceTab(tab);
        setOpenMenu("source");
      }
    };
    window.addEventListener("fleet:open-source-tab", onOpen);
    return () => window.removeEventListener("fleet:open-source-tab", onOpen);
  }, []);

  const patch = useCallback(async (updates: Record<string, unknown>) => {
    if (isDraft) {
      // Draft mode — purely client-side. The chip strip is letting
      // the user settle folder / model / permission / etc. on a
      // session that doesn't exist yet. commitDraft (fired by the
      // first user message) will POST these in one shot.
      setDraftField(updates as Partial<Session>);
      return;
    }
    updateSessionLocal(sessionId, updates as Partial<Session>);
    try { await apiUpdateSession(sessionId, updates); }
    catch (e) { console.error("toolbar patch failed:", e); }
  }, [isDraft, setDraftField, sessionId, updateSessionLocal]);

  /** Derive a sensible session title from a folder/repo path so the
   *  backend's worktree creator gets a real slug to work with.
   *  Without this, the worktree branch becomes `fleet/new-chat-<id>`
   *  (the placeholder draft title) instead of e.g.
   *  `fleet/ai-social-media-agents-<id>`. We patch title and
   *  project_path in the SAME PATCH so the backend sees the new
   *  title before it spins up the worktree. */
  const titleFromPath = (p: string): string => {
    const name = p.split("/").filter(Boolean).pop() ?? "";
    if (!name) return "Session";
    // Strip noisy prefixes/suffixes — clones land at
    // ~/.fleetify/clones/<name>/, sometimes with a trailing .git slug.
    return name.replace(/\.git$/, "").trim() || "Session";
  };

  const pickFolder = useCallback(async () => {
    const w = window as unknown as { electronAPI?: { openFolderDialog?: () => Promise<string | null> } };
    if (w.electronAPI?.openFolderDialog) {
      const p = await w.electronAPI.openFolderDialog();
      if (p) {
        await patch({ project_path: p, title: titleFromPath(p) });
        setOpenMenu(null);
      }
      return;
    }
    const p = window.prompt("Project folder path");
    if (p) {
      await patch({ project_path: p, title: titleFromPath(p) });
      setOpenMenu(null);
    }
  }, [patch]);

  const submitClone = useCallback(async (overrideUrl?: string) => {
    const url = (overrideUrl ?? cloneUrl).trim();
    if (!url || cloning) return;
    setCloning(true); setCloneError(null);
    try {
      const r = await cloneRepository(url);
      await patch({ project_path: r.path, title: titleFromPath(r.path) });
      setCloneUrl("");
      setOpenMenu(null);
    } catch (e) {
      setCloneError(e instanceof Error ? e.message : "Clone failed");
    } finally {
      setCloning(false);
    }
  }, [cloneUrl, cloning, patch]);

  // Lazy-load the user's GitHub repos the first time the Git tab is
  // opened. Cache lives for the lifetime of the toolbar instance —
  // re-fetched when the user re-mounts the toolbar (new session).
  useEffect(() => {
    if (openMenu !== "source" || sourceTab !== "git") return;
    if (ghRepos !== null || ghReposLoading) return;
    setGhReposLoading(true); setGhReposError(null);
    listUserRepos()
      .then(rs => setGhRepos(rs))
      .catch((e: Error) => setGhReposError(e.message || "Failed to load repos"))
      .finally(() => setGhReposLoading(false));
  }, [openMenu, sourceTab, ghRepos, ghReposLoading]);

  const pickPerm = useCallback((id: string) => {
    patch({ permission_mode: id });
    setOpenMenu(null);
  }, [patch]);

  const folderName = projectPath
    ? (folderNameUtil(projectPath) || projectPath)
    : null;

  const providerDef = providers.find(p => p.id === tool) ?? providers[0]!;
  const modelLabel  = providerDef.models.find(m => m.id === model)?.label ?? model ?? "Model";
  const permLabel   = PERMS.find(p => p.id === permissionMode)?.label ?? permissionMode;

  // Pick a model from any provider. Selecting a model from a
  // different provider also flips the tool, so the chip and bridge
  // stay coherent. Combined into ONE menu to avoid the user
  // bouncing between two dropdowns to land on the right model.
  const pickAnyModel = useCallback((providerId: ProviderDef["id"], modelId: string) => {
    const updates: Record<string, unknown> = { model_name: modelId };
    if (providerId !== tool) updates.tool = providerId;
    patch(updates);
    setOpenMenu(null);
  }, [patch, tool]);

  return (
    <div
      ref={wrapRef}
      style={{
        display: "flex", flexWrap: "wrap", alignItems: "center",
        // Slightly more breathing room than before — 4 was too tight,
        // chips ran into each other visually.
        rowGap: 6, columnGap: 6,
        padding: "0 0 8px",
        // overflow MUST stay visible so chip dropdowns aren't clipped.
        // Setting overflow-x: auto silently flips overflow-y to auto
        // too (CSS spec quirk), which was hiding every popover.
        overflow: "visible",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* ── Source chip — opens a popover with three source tabs
            (Local / Git / Remote). The cloned repo lands at
            ~/.fleetify/clones/<repo>/ and becomes the session's
            project_path; the existing PATCH flow then spins up a
            fleet/<slug>-<id> worktree off that clone exactly like
            a local folder.

            The chip's own LABEL flips based on what the user
            actually used: a project_path under ~/.fleetify/clones/ is
            unambiguously a Git clone, otherwise we trust the
            currently-selected tab (so even before a pick lands the
            label tracks the user's intent). ── */}
      <Chip
        active={openMenu === "source"}
        chevron
        onClick={() => setOpenMenu(openMenu === "source" ? null : "source")}
      >
        {(() => {
          // Detect source kind from the project_path:
          //   docker://...               → Container
          //   ssh://...                  → Remote (SSH)
          //   ~/.fleetify/clones/<name>/    → Git (clone helper convention)
          //   anything else              → Local
          // When no path is set yet, fall back to whichever tab the
          // user has open so the chip tracks intent before the pick
          // lands.
          const isContainer =
            (projectPath && projectPath.startsWith("docker://")) ||
            (!projectPath && sourceTab === "container");
          const isRemote =
            !isContainer && (
              (projectPath && projectPath.startsWith("ssh://")) ||
              (!projectPath && sourceTab === "remote")
            );
          const isGitOrigin =
            !isContainer && !isRemote && (
              (projectPath && projectPath.includes("/.fleetify/clones/")) ||
              (!projectPath && sourceTab === "git")
            );
          const SrcIcon =
            isContainer ? Box
            : isRemote ? Server
            : isGitOrigin ? Github
            : Monitor;
          const srcLabel =
            isContainer ? "Container"
            : isRemote ? "Remote"
            : isGitOrigin ? "Git"
            : "Local";
          return (
            <>
              <SrcIcon size={11} style={{ color: "var(--c-dim, #9a9a9a)" }} />
              <span>{srcLabel}</span>
            </>
          );
        })()}
        {openMenu === "source" && (
          <Menu width={340} padding={0}>
            {/* Tab strip — Local / Git / Remote. Sits flush against
                the popover edge so the section beneath gets all the
                breathing room. Active tab is the brighter --c-fg
                with a 1px underline; the rest live at --c-dim. */}
            <div style={{
              display: "flex", alignItems: "center",
              padding: "0 10px",
              borderBottom: "1px solid var(--c-brd)",
              gap: 14,
            }}>
              <SourceTab active={sourceTab === "local"}     onClick={() => setSourceTab("local")}>Local</SourceTab>
              <SourceTab active={sourceTab === "git"}       onClick={() => setSourceTab("git")}>Git</SourceTab>
              <SourceTab active={sourceTab === "remote"}    onClick={() => setSourceTab("remote")}>Remote</SourceTab>
              <SourceTab active={sourceTab === "container"} onClick={() => setSourceTab("container")}>Container</SourceTab>
            </div>

            {/* ── Local tab ── */}
            {sourceTab === "local" && (
              <div style={{ padding: 4 }}>
                <button
                  onClick={pickFolder}
                  style={{
                    width: "100%", textAlign: "left",
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none", outline: "none", cursor: "pointer",
                    borderRadius: 5,
                    color: "var(--c-fg)",
                    fontFamily: "var(--font-sans)",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.06))"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <FolderOpen size={13} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
                  <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>Browse local folder</span>
                    <span style={{ fontSize: 11, color: "var(--c-dim)" }}>Pick a folder already on your machine</span>
                  </span>
                </button>
              </div>
            )}

            {/* ── Git tab — user's repos + URL fallback ──
                Three vertical sections, each with consistent 10px
                horizontal padding so the rows align with the tab
                strip above:
                  1. Filter row (search icon + input)
                  2. Scroll list (repos)
                  3. URL fallback (label + input + button)             */}
            {sourceTab === "git" && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {/* Filter row — search icon inside a borderless input
                    so it reads as part of the popover chrome rather
                    than a separate form field. */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "7px 10px",
                  borderBottom: "1px solid var(--c-brd)",
                }}>
                  <Search size={11} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
                  <input
                    value={repoFilter}
                    onChange={e => setRepoFilter(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    placeholder="Filter repositories…"
                    spellCheck={false}
                    autoFocus
                    style={{
                      flex: 1, minWidth: 0,
                      padding: 0,
                      background: "transparent",
                      border: "none",
                      color: "var(--c-fg)",
                      fontFamily: "var(--font-sans)",
                      fontSize: 11.5,
                      outline: "none",
                    }}
                  />
                </div>

                {/* Repo list — scrollable. Tight rows, single-line
                    name, single-line description ellipsized. Trail
                    timestamp lives on the right at --c-dim so the
                    eye can scan recency. */}
                <div style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  padding: "4px 4px",
                  display: "flex", flexDirection: "column",
                }}>
                  {ghReposLoading && (
                    <div style={{ padding: "18px 12px", textAlign: "center", fontSize: 11.5, color: "var(--c-dim)" }}>
                      Loading repositories…
                    </div>
                  )}
                  {ghReposError && (
                    <div style={{ padding: 10, fontSize: 11, color: "#ef4444", fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>
                      {ghReposError}
                    </div>
                  )}
                  {ghRepos && ghRepos
                    .filter(r => !repoFilter.trim() || r.nameWithOwner.toLowerCase().includes(repoFilter.toLowerCase()))
                    .map(r => (
                      <RepoRow
                        key={r.nameWithOwner}
                        repo={r}
                        disabled={cloning}
                        onClick={() => void submitClone(r.url)}
                      />
                    ))}
                  {ghRepos && ghRepos.length === 0 && !ghReposLoading && !ghReposError && (
                    <div style={{ padding: "18px 12px", textAlign: "center", fontSize: 11.5, color: "var(--c-dim)" }}>
                      No repositories found.
                    </div>
                  )}
                </div>

                {/* URL fallback — paint as a single unified input
                    pill: a compact row with a leading link icon, the
                    URL field, and the action button "stuck" to the
                    right edge with a subtle 1px divider. Reads as one
                    object instead of three separate controls. */}
                <div style={{
                  borderTop: "1px solid var(--c-brd)",
                  padding: "9px 10px 10px",
                  display: "flex", flexDirection: "column", gap: 6,
                }}>
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    fontSize: 9.5, fontWeight: 600,
                    letterSpacing: 0.6, textTransform: "uppercase",
                    color: "var(--c-dim)",
                  }}>
                    <span>Paste a URL</span>
                    <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, fontSize: 10 }}>
                      Public or private
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex", alignItems: "stretch",
                      background: "var(--c-srf2)",
                      border: "1px solid var(--c-brd)",
                      borderRadius: 6,
                      overflow: "hidden",
                      transition: "border-color 0.12s",
                    }}
                    onFocusCapture={e => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = "var(--c-brd2)";
                    }}
                    onBlurCapture={e => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = "var(--c-brd)";
                    }}
                  >
                    <span style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      paddingLeft: 9, paddingRight: 7,
                      color: "var(--c-dim)",
                      flexShrink: 0,
                    }}>
                      <Github size={11} />
                    </span>
                    <input
                      value={cloneUrl}
                      onChange={e => { setCloneUrl(e.target.value); setCloneError(null); }}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submitClone(); } }}
                      placeholder="github.com/owner/repo"
                      disabled={cloning}
                      spellCheck={false}
                      style={{
                        flex: 1, minWidth: 0,
                        padding: "6px 0",
                        background: "transparent",
                        border: "none",
                        color: "var(--c-fg)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        outline: "none",
                        opacity: cloning ? 0.6 : 1,
                      }}
                    />
                    <button
                      onClick={() => void submitClone()}
                      disabled={!cloneUrl.trim() || cloning}
                      style={{
                        padding: "0 12px",
                        fontSize: 11, fontWeight: 600,
                        fontFamily: "var(--font-sans)",
                        color: cloneUrl.trim() && !cloning ? "var(--card, #0a0a0a)" : "var(--c-dim)",
                        background: cloneUrl.trim() && !cloning ? "var(--c-fg)" : "transparent",
                        border: "none",
                        borderLeft: "1px solid var(--c-brd)",
                        cursor: cloneUrl.trim() && !cloning ? "pointer" : "default",
                        outline: "none",
                        flexShrink: 0,
                        transition: "background 0.12s, color 0.12s",
                      }}
                    >
                      {cloning ? "…" : "Clone"}
                    </button>
                  </div>
                  {cloneError && (
                    <span style={{
                      fontSize: 10.5, color: "#ef4444",
                      fontFamily: "var(--font-mono)",
                      wordBreak: "break-word",
                    }}>{cloneError}</span>
                  )}
                </div>
              </div>
            )}

            {/* ── Remote tab — SSH host management.
                MVP: register hosts, test the connection, browse the
                remote filesystem, commit a workspace path. The
                project_path lands as `ssh://user@host:port/abs/path`
                so the rest of the app can recognise it as remote and
                gate behaviour later (agent execution over SSH is
                still on the roadmap — "sonrasında genişleteceğiz"). */}
            {sourceTab === "remote" && (
              <RemoteSshPanel
                onPick={(remoteUrl) => {
                  void patch({ project_path: remoteUrl, title: titleFromPath(remoteUrl) });
                  setOpenMenu(null);
                }}
              />
            )}

            {/* ── Container tab — running Docker containers as
                workspaces. Same MVP shape as Remote: pick a container,
                browse its filesystem, commit a path. project_path
                lands as `docker://<id>:/abs/path`. */}
            {sourceTab === "container" && (
              <DockerContainerPanel
                onPick={(containerUrl) => {
                  void patch({ project_path: containerUrl, title: titleFromPath(containerUrl) });
                  setOpenMenu(null);
                }}
              />
            )}
          </Menu>
        )}
      </Chip>

      {/* ── Folder / Repo readout — what the second chip shows
            depends on which source tab the user has active:
              · "local"  → folder icon + "Pick folder" (or folder name)
              · "git"    → github icon  + "Select repo"  (or repo name)
              · "remote" → folder icon  + "Pick folder"  (placeholder)
            Click jumps straight to the right place: local mode
            opens the OS folder dialog; git mode pops the source
            picker open with the Git tab pre-selected so the user
            doesn't have to re-navigate the tab strip. ── */}
      {(() => {
        const isContainerPath = !!(projectPath && projectPath.startsWith("docker://"));
        const isRemotePath    = !!(projectPath && projectPath.startsWith("ssh://"));
        const inGitMode       = sourceTab === "git";
        const inRemoteMode    = sourceTab === "remote";
        const inContainerMode = sourceTab === "container";
        const isPickerMode    = inGitMode || inRemoteMode || inContainerMode;
        const Icon =
          isContainerPath ? Box
          : isRemotePath ? Server
          : inGitMode ? Github
          : inContainerMode ? Box
          : FolderOpen;
        const placeholder =
          inGitMode ? "Select repo"
          : inRemoteMode ? "Pick remote folder"
          : inContainerMode ? "Pick container path"
          : "Pick folder";
        // Strip the scheme prefix so the chip shows just the
        // workspace name (last path segment), not a wall of URL.
        const display = (() => {
          if (!projectPath) return null;
          if (isContainerPath) {
            const tail = projectPath.replace(/^docker:\/\/[^/]+/, "").replace(/\/+$/, "");
            return tail.split("/").filter(Boolean).pop() ?? "Container";
          }
          if (isRemotePath) {
            const tail = projectPath.replace(/^ssh:\/\/[^/]+/, "").replace(/\/+$/, "");
            return tail.split("/").filter(Boolean).pop() ?? "Remote";
          }
          return folderName;
        })();
        const label = display ?? placeholder;
        const onClick = () => {
          if (folderName || isRemotePath || isContainerPath) {
            if (isPickerMode || isRemotePath || isContainerPath) {
              setOpenMenu("source");
            } else {
              void pickFolder();
            }
            return;
          }
          if (isPickerMode) {
            setOpenMenu("source");
          } else {
            void pickFolder();
          }
        };
        return (
          <Chip onClick={onClick}>
            <Icon size={11} style={{ color: "var(--c-dim, #9a9a9a)" }} />
            <span style={{ color: projectPath ? "var(--c-fg, #e6e6e6)" : "var(--c-dim, #9a9a9a)" }}>
              {label}
            </span>
          </Chip>
        );
      })()}

      {/* ── Model — single chip carrying the provider logo + the
            current model name. The dropdown is a grouped list of
            every provider's models so the user lands on what they
            want in one click rather than bouncing between two
            chips. ── */}
      <Chip
        active={openMenu === "model"}
        chevron
        onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
      >
        <ProviderLogo tool={providerDef.id} size={12} />
        <span>{modelLabel}</span>
        {openMenu === "model" && (
          <ModelMenu
            tool={tool}
            model={model}
            providers={providers}
            onPick={pickAnyModel}
          />
        )}
      </Chip>

      {/* ── Permission ── */}
      <Chip
        active={openMenu === "perms"}
        chevron
        onClick={() => setOpenMenu(openMenu === "perms" ? null : "perms")}
      >
        <Lock size={11} style={{ color: "var(--c-dim, #9a9a9a)" }} />
        <span>{permLabel}</span>
        {openMenu === "perms" && (
          <Menu>
            {PERMS.map(p => (
              <MenuRow
                key={p.id}
                active={permissionMode === p.id}
                onClick={() => pickPerm(p.id)}
                primary={p.label}
                secondary={p.desc}
              />
            ))}
          </Menu>
        )}
      </Chip>

      {/* ── Git branch + worktree (composite chip) ──
            Two click targets glued together inside a single chip
            shell — mirrors the reference design where the branch
            picker and the worktree toggle share one outline with a
            hairline between them.
              LEFT  → branch trigger, opens the Local/Remote menu
              RIGHT → worktree on/off toggle (white-tick checkbox)
            Both segments individually disable when no folder is
            picked. ── */}
      {(() => {
        const disabled = !projectPath;
        const noRepo = !disabled && !branchesLoading && branches.current === null && branches.local.length === 0;
        const branchDisabled = disabled || noRepo;
        const current = branches.current ?? "—";
        const filter = branchFilter.trim().toLowerCase();
        const matchedLocal  = branches.local.filter(b => !filter || b.toLowerCase().includes(filter));
        const matchedRemote = branches.remote.filter(b => !filter || b.toLowerCase().includes(filter));
        const branchTitle =
          disabled  ? "Pick a folder first to see branches"
          : noRepo  ? "Git unavailable in this folder"
          : branchSwitching ? "Switching branch…"
          : `On '${current}'. Click to switch.`;
        const wtTitle =
          disabled  ? "Pick a folder first"
          : useWorktree
            ? "Working in an isolated worktree — parallel-safe. Click to disable."
            : "Working directly in the project — no worktree. Click to enable.";
        const isOpen = openMenu === "git";

        // Shared chip-shell visuals — pulled from the Chip primitive
        // so this composite reads as a single chip in the strip.
        const shellBg = isOpen
          ? "var(--c-srf, rgba(255,255,255,0.07))"
          : "var(--c-srf2, rgba(255,255,255,0.04))";
        const shellBorder = isOpen
          ? "var(--c-brd2, rgba(255,255,255,0.20))"
          : "var(--c-brd, rgba(255,255,255,0.10))";

        return (
          <div
            style={{
              position: "relative",
              display: "inline-flex", alignItems: "stretch",
              height: 24,
              borderRadius: 6,
              border: `1px solid ${shellBorder}`,
              background: shellBg,
              flexShrink: 0,
              transition: "background 0.12s, border-color 0.12s",
              overflow: "visible",
            }}
          >
            {/* ── LEFT: branch trigger ── */}
            <button
              onClick={() => {
                if (branchDisabled) return;
                setOpenMenu(isOpen ? null : "git");
                if (!isOpen) {
                  setBranchFilter("");
                  reloadBranches();
                }
              }}
              onMouseDown={e => e.preventDefault()}
              title={branchTitle}
              disabled={branchDisabled}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "0 10px 0 8px",
                background: "transparent", border: "none",
                color: "var(--c-fg, #e6e6e6)",
                fontFamily: "var(--font-sans)",
                fontSize: 11.5, fontWeight: 500, lineHeight: 1,
                cursor: branchDisabled ? "default" : "pointer",
                opacity: branchDisabled ? 0.5 : 1,
                outline: "none",
                whiteSpace: "nowrap",
              }}
            >
              <GitBranch size={11} style={{
                color: branchDisabled ? "var(--c-dim, #9a9a9a)" : "var(--c-fg, #e6e6e6)",
              }} />
              <span style={{
                color: branchDisabled ? "var(--c-dim, #7a7a7a)" : undefined,
                maxWidth: 140,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {branchDisabled ? "Branch" : current}
              </span>
            </button>

            {/* ── Separator ── */}
            <span style={{
              width: 1, alignSelf: "stretch",
              background: shellBorder,
              transition: "background 0.12s",
            }} />

            {/* ── RIGHT: worktree toggle ── */}
            <button
              onClick={() => {
                if (disabled) return;
                patch({ use_worktree: !useWorktree });
              }}
              onMouseDown={e => e.preventDefault()}
              title={wtTitle}
              disabled={disabled}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "0 9px",
                background: "transparent", border: "none",
                color: "var(--c-fg, #e6e6e6)",
                fontFamily: "var(--font-sans)",
                fontSize: 11.5, fontWeight: 500, lineHeight: 1,
                cursor: disabled ? "default" : "pointer",
                opacity: disabled ? 0.5 : 1,
                outline: "none",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{
                width: 11, height: 11, borderRadius: 3,
                flexShrink: 0,
                border: "1.5px solid " + (useWorktree ? "var(--c-fg, #ffffff)" : "var(--c-dim, #8a8a8a)"),
                background: useWorktree ? "var(--c-fg, #ffffff)" : "transparent",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.12s, border-color 0.12s",
              }}>
                {useWorktree && (
                  <Check size={8} strokeWidth={3.5} style={{ color: "var(--card, #0c0c0c)" }} />
                )}
              </span>
              <span style={{
                color: disabled
                  ? "var(--c-dim, #7a7a7a)"
                  : useWorktree ? undefined : "var(--c-dim, #8a8a8a)",
              }}>
                worktree
              </span>
            </button>

            {/* ── Branch menu — anchored to the chip shell ── */}
            {isOpen && (
              <Menu width={300}>
                <div style={{
                  padding: "6px 8px 4px",
                  display: "flex", alignItems: "center", gap: 6,
                  borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
                }}>
                  <SearchIcon size={11} style={{ color: "var(--c-dim, #8a8a8a)", flexShrink: 0 }} />
                  <input
                    autoFocus
                    value={branchFilter}
                    onChange={e => setBranchFilter(e.target.value)}
                    placeholder="Search branches"
                    style={{
                      flex: 1, minWidth: 0,
                      background: "transparent", border: "none", outline: "none",
                      fontSize: 12.5, color: "var(--c-fg, #e6e6e6)",
                      fontFamily: "inherit",
                    }}
                  />
                  {branchesLoading && (
                    <span style={{ fontSize: 10.5, color: "var(--c-dim, #8a8a8a)" }}>Loading…</span>
                  )}
                </div>
                {matchedLocal.length > 0 && (
                  <>
                    <div style={{
                      padding: "6px 10px 2px", fontSize: 10.5, fontWeight: 500,
                      letterSpacing: 0.3, textTransform: "uppercase",
                      color: "var(--c-dim, #7a7a7a)",
                    }}>Local</div>
                    {matchedLocal.map(b => (
                      <MenuRow
                        key={`local-${b}`}
                        onClick={async () => {
                          if (b === branches.current || branchSwitching) {
                            setOpenMenu(null);
                            return;
                          }
                          setBranchSwitching(true);
                          try {
                            const res = await window.electronAPI?.gitCheckout?.(projectPath!, b);
                            if (res?.ok) {
                              setBranches(prev => ({ ...prev, current: b }));
                            } else if (res?.error) {
                              alert(`Couldn't switch: ${res.error}`);
                            }
                          } finally {
                            setBranchSwitching(false);
                            setOpenMenu(null);
                          }
                        }}
                        primary={b}
                        right={b === branches.current
                          ? <Check size={11} style={{ color: "var(--c-fg, #ffffff)" }} />
                          : undefined}
                      />
                    ))}
                  </>
                )}
                {matchedRemote.length > 0 && (
                  <>
                    <div style={{
                      padding: "8px 10px 2px", fontSize: 10.5, fontWeight: 500,
                      letterSpacing: 0.3, textTransform: "uppercase",
                      color: "var(--c-dim, #7a7a7a)",
                    }}>Remote</div>
                    {matchedRemote.map(b => (
                      <MenuRow
                        key={`remote-${b}`}
                        onClick={async () => {
                          if (branchSwitching) return;
                          setBranchSwitching(true);
                          try {
                            const res = await window.electronAPI?.gitCheckout?.(projectPath!, b);
                            if (res?.ok) {
                              const local = b.includes("/") ? b.split("/").slice(1).join("/") : b;
                              setBranches(prev => ({ ...prev, current: local }));
                              reloadBranches();
                            } else if (res?.error) {
                              alert(`Couldn't check out: ${res.error}`);
                            }
                          } finally {
                            setBranchSwitching(false);
                            setOpenMenu(null);
                          }
                        }}
                        primary={b}
                      />
                    ))}
                  </>
                )}
                {!branchesLoading && matchedLocal.length === 0 && matchedRemote.length === 0 && (
                  <div style={{
                    padding: "10px 12px 14px",
                    fontSize: 12, color: "var(--c-low, #b0b0b0)",
                  }}>
                    No branches match "{branchFilter}".
                  </div>
                )}
              </Menu>
            )}
          </div>
        );
      })()}

      {/* ── History — Claude CLI native conversations for the picked
            folder. Reads ~/.claude/projects/<encoded>/*.jsonl via the
            backend's /claude-sessions endpoint; picking one stamps
            claude_session_id on this session so the next dispatch
            resumes that conversation. Disabled until a folder is
            picked (and currently Claude-only — Codex / Gemini land
            in follow-ups). ── */}
      {(() => {
        const count = cliHistory.length;
        const disabled = !projectPath || tool !== "claude";
        // Resume target settled? Two display modes for the chip:
        //   • no claudeSessionId → "History" + count badge (picker)
        //   • claudeSessionId set → green dot + the picked summary
        //                            (active resume target)
        const resumed = cliHistory.find(r => r.session_id === claudeSessionId) ?? null;
        const isResumed = !!claudeSessionId;
        const disabledReason =
          !projectPath
            ? "Pick a folder first to see previous Claude conversations"
            : tool !== "claude"
              ? "History resume currently supports Claude only"
              : isResumed
                ? `Resuming "${resumed?.summary ?? claudeSessionId.slice(0, 8)}". Click to change.`
                : count > 0
                  ? `${count} previous conversation${count === 1 ? "" : "s"} on this folder`
                  : cliHistoryLoading
                    ? "Loading previous conversations…"
                    : "No previous Claude conversations on this folder";
        return (
          <Chip
            active={openMenu === "history" || isResumed}
            disabled={disabled}
            title={disabledReason}
            onClick={() => {
              if (disabled) return;
              setOpenMenu(openMenu === "history" ? null : "history");
            }}
          >
            {isResumed ? (
              <>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "rgb(74,222,128)",
                  display: "inline-block", flexShrink: 0,
                }} />
                <span style={{
                  maxWidth: 160,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {resumed?.summary || claudeSessionId.slice(0, 8)}
                </span>
              </>
            ) : (
              <>
                <History size={11} style={{
                  color: count > 0 ? "var(--c-fg, #e6e6e6)" : "var(--c-dim, #9a9a9a)",
                }} />
                <span style={{ color: disabled ? "var(--c-dim, #7a7a7a)" : undefined }}>
                  History
                </span>
                {count > 0 && (
                  <span style={{
                    fontSize: 10.5, fontWeight: 600,
                    color: "var(--c-dim, #9a9a9a)",
                    fontVariantNumeric: "tabular-nums",
                    marginLeft: 1,
                  }}>
                    {count}
                  </span>
                )}
              </>
            )}
            {openMenu === "history" && (
              <Menu width={360}>
                <div style={{
                  padding: "6px 10px 4px",
                  fontSize: 10.5, fontWeight: 500,
                  letterSpacing: 0.3, textTransform: "uppercase",
                  color: "var(--c-dim, #7a7a7a)",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <span>Resume from Claude CLI</span>
                  {cliHistoryLoading && (
                    <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>Loading…</span>
                  )}
                </div>
                {count > 0 ? (
                  cliHistory.map(row => {
                    const selected = row.session_id === claudeSessionId;
                    return (
                      <MenuRow
                        key={row.session_id}
                        onClick={async () => {
                          setOpenMenu(null);
                          if (selected) return; // re-click same row → no-op
                          if (isDraft) {
                            // ── Local-only mode: stash only, do NOT commit ──
                            // Previously this branch eagerly committed the
                            // draft to the DB so fetchClaudeHistory had a
                            // real session id to look up. That violated the
                            // "session row only on first user message"
                            // contract: 21 zombie "New chat" rows piled up
                            // because every accidental row click materialised
                            // an empty session. Now we just stash the
                            // claude_session_id; the resumed history will
                            // load naturally once commitDraft fires from
                            // the user's first send.
                            setDraftField({ claude_session_id: row.session_id });
                          } else {
                            // Real session — PATCH claude_session_id
                            // then reload history into the chat view.
                            patch({ claude_session_id: row.session_id });
                            const history = await fetchClaudeHistory(sessionId).catch(() => []);
                            const safe: ChatMessage[] = Array.isArray(history)
                              ? (history as unknown[]).flatMap(h =>
                                  h && typeof h === "object" && "role" in (h as object)
                                    ? [h as ChatMessage]
                                    : [],
                                )
                              : [];
                            setMessages(sessionId, safe);
                          }
                        }}
                        primary={row.summary || row.session_id.slice(0, 8)}
                        secondary={formatRelative(row.updated_at)}
                        left={<ProviderLogo tool="claude" size={11} />}
                        right={selected ? <Check size={11} style={{ color: "var(--c-fg, #ffffff)" }} /> : undefined}
                      />
                    );
                  })
                ) : !cliHistoryLoading ? (
                  <div style={{
                    padding: "10px 12px 14px",
                    fontSize: 12, color: "var(--c-low, #b0b0b0)",
                    lineHeight: 1.5,
                  }}>
                    No previous Claude conversations were found in
                    <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--c-med, #d4d4d4)" }}>
                      {" "}~/.claude/projects/
                    </span>
                    {" "}for this folder. New sessions will start fresh.
                  </div>
                ) : null}
              </Menu>
            )}
          </Chip>
        );
      })()}

      {/* ── Add slot — placeholder for future "add another worktree /
            additional folder" affordance. Visible but inert for now
            so the row matches the reference shape. ── */}
      <Chip onClick={pickFolder} title="Add another folder">
        <Plus size={11} style={{ color: "var(--c-dim, #9a9a9a)" }} />
      </Chip>
    </div>
  );
}

/* ─── Chip — base chip atom shared by every entry above ─── */
function Chip({
  children, onClick, active, chevron, title, disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  chevron?: boolean;
  title?: string;
  disabled?: boolean;
}) {
  const baseBg     = "var(--c-srf2, rgba(255,255,255,0.04))";
  const hoverBg    = "var(--c-srf, rgba(255,255,255,0.07))";
  const activeBg   = "var(--c-srf, rgba(255,255,255,0.07))";
  const baseBorder = "var(--c-brd, rgba(255,255,255,0.10))";
  const hotBorder  = "var(--c-brd2, rgba(255,255,255,0.20))";

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseDown={e => e.preventDefault()}
      title={title}
      disabled={disabled}
      style={{
        position: "relative",
        display: "inline-flex", alignItems: "center", gap: 5,
        height: 24,
        padding: "0 8px",
        background: active ? activeBg : baseBg,
        border: "1px solid " + (active ? hotBorder : baseBorder),
        borderRadius: 6,
        color: "var(--c-fg, #e6e6e6)",
        fontFamily: "var(--font-sans)",
        fontSize: 11.5, fontWeight: 500,
        lineHeight: 1,
        cursor: disabled ? "default" : (onClick ? "pointer" : "default"),
        opacity: disabled ? 0.5 : 1,
        outline: "none",
        whiteSpace: "nowrap",
        flexShrink: 0,
        transition: "background 0.12s, border-color 0.12s, opacity 0.12s",
      }}
      onMouseEnter={e => {
        if (!onClick || disabled) return;
        e.currentTarget.style.background = active ? activeBg : hoverBg;
        e.currentTarget.style.borderColor = hotBorder;
      }}
      onMouseLeave={e => {
        if (!onClick || disabled) return;
        e.currentTarget.style.background = active ? activeBg : baseBg;
        e.currentTarget.style.borderColor = active ? hotBorder : baseBorder;
      }}
    >
      {children}
      {chevron && (
        <ChevronDown
          size={10} strokeWidth={2}
          style={{
            color: "var(--c-dim, #9a9a9a)",
            marginLeft: -1,
            transform: active ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
        />
      )}
    </button>
  );
}

/* ─── SourceTab — section tab in the source picker popover.
     Active tab paints a 1.5px underline that sits on the popover's
     own bottom border (the parent's borderBottom), so the visual
     reads like a tabbed sheet rather than a button. Inactive tabs
     are --c-dim text only — no background. Disabled gets a "soon"
     shadow so the tab still reads as belonging to the strip. ─── */
function SourceTab({
  active, onClick, disabled, children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseDown={e => e.preventDefault()}
      disabled={disabled}
      style={{
        position: "relative",
        padding: "10px 0 9px",
        fontSize: 11.5,
        fontWeight: active ? 600 : 500,
        fontFamily: "var(--font-sans)",
        color: disabled
          ? "var(--c-dim)"
          : active ? "var(--c-fg)" : "var(--c-dim)",
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        outline: "none",
        opacity: disabled ? 0.45 : 1,
        transition: "color 0.12s",
      }}
      onMouseEnter={e => { if (!active && !disabled) (e.currentTarget as HTMLButtonElement).style.color = "var(--c-fg)"; }}
      onMouseLeave={e => { if (!active && !disabled) (e.currentTarget as HTMLButtonElement).style.color = "var(--c-dim)"; }}
    >
      {children}
      {active && (
        <span aria-hidden style={{
          position: "absolute",
          left: 0, right: 0, bottom: -1,
          height: 1.5,
          background: "var(--c-fg)",
          borderRadius: 1,
        }} />
      )}
    </button>
  );
}

/* ─── RepoRow — single repo entry in the Git tab list.
     One-line layout: status dot · name · description · time.
     Description ellipsizes hard so the row never grows the menu
     wider than its set width. ─── */
function RepoRow({
  repo, disabled, onClick,
}: {
  repo: GhRepo;
  disabled: boolean;
  onClick: () => void;
}) {
  const stamp = formatRelative(repo.updatedAt);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseDown={e => e.preventDefault()}
      style={{
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr) auto",
        alignItems: "center",
        columnGap: 8,
        padding: "5px 8px",
        background: "transparent",
        border: "none", outline: "none",
        cursor: disabled ? "default" : "pointer",
        borderRadius: 4,
        textAlign: "left",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "var(--font-sans)",
        color: "var(--c-fg)",
        width: "100%",
      }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.06))"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      title={repo.description || repo.nameWithOwner}
    >
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: repo.isPrivate ? "var(--c-dim)" : "rgba(120,180,140,0.95)",
        justifySelf: "center",
      }} />
      <span style={{
        minWidth: 0,
        display: "flex", alignItems: "baseline", gap: 7,
        overflow: "hidden",
      }}>
        <span style={{
          fontSize: 11.75, fontWeight: 500,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          flexShrink: 0,
          maxWidth: "60%",
        }}>{repo.nameWithOwner}</span>
        {repo.description && (
          <span style={{
            fontSize: 10.75, color: "var(--c-dim)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            minWidth: 0, flex: 1,
          }}>{repo.description}</span>
        )}
      </span>
      <span style={{
        fontSize: 10, color: "var(--c-dim)",
        flexShrink: 0,
        fontVariantNumeric: "tabular-nums",
      }}>{stamp}</span>
    </button>
  );
}

/** Compact relative-time formatter for repo "updated" stamps.
 *  ("3d", "2w", "5mo", "1y") — keeps the row compact while still
 *  giving the user a recency cue. Falls back to empty string for
 *  unparseable timestamps. */
function formatRelative(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60)               return "now";
  if (sec < 3600)             return `${Math.floor(sec / 60)}m`;
  if (sec < 86400)            return `${Math.floor(sec / 3600)}h`;
  if (sec < 86400 * 7)        return `${Math.floor(sec / 86400)}d`;
  if (sec < 86400 * 30)       return `${Math.floor(sec / (86400 * 7))}w`;
  if (sec < 86400 * 365)      return `${Math.floor(sec / (86400 * 30))}mo`;
  return `${Math.floor(sec / (86400 * 365))}y`;
}

function Menu({ children, width, padding }: {
  children: React.ReactNode;
  width?: number;
  /** Override default 4px chrome — useful for menus that paint
   *  full-bleed sections (e.g. the source picker's tab strip). */
  padding?: number | string;
}) {
  // Toolbar lives just above the chat input which is pinned to the
  // bottom of the viewport — there's almost never room below the
  // chip for a downward menu (it gets clipped under the input).
  // Open UPWARD: bottom anchor + a complementary slide-up animation.
  //
  // We pin BOTH width and maxWidth: setting only minWidth lets a
  // single overflowing description row blow the menu out to viewport
  // width (the bug from the first pass — repo descriptions were
  // nowrap, so the flex layout grew the whole menu sideways instead
  // of ellipsizing inside it).
  const w = width ?? 320;
  return (
    <div role="menu" style={{
      position: "absolute", bottom: "calc(100% + 6px)", left: 0,
      width: w, maxWidth: w,
      maxHeight: "min(60vh, 420px)", overflowY: "auto",
      // Theme-aware popover surface — --popover is white in light
      // mode and near-black (#161616) in dark. Was hard-coded
      // #0D0D0D which painted a black popover over the white
      // chrome in light theme.
      background: "var(--popover, #0D0D0D)",
      border: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
      borderRadius: 8,
      padding: padding ?? 4,
      boxShadow: "0 -14px 36px rgba(0,0,0,0.35)",
      zIndex: 100,
      color: "var(--c-fg)",
      fontFamily: "var(--font-sans)",
      animation: "fleet-popover-up 0.14s ease-out both",
    }}
    // Stop BOTH click and mousedown from reaching the parent Chip
    // <button>. Without mousedown isolation, inputs inside the
    // popover can't receive focus — the Chip's own
    // onMouseDown={preventDefault()} (added so chips don't steal
    // focus from the chat textarea) fires on the bubble path and
    // cancels the default focus action on whatever was clicked
    // inside. Result: clicks landed but the URL input never
    // accepted text. Stopping mousedown here keeps the focus-
    // stealing fix on chip clicks while letting popover form
    // controls work normally.
    onClick={e => e.stopPropagation()}
    onMouseDown={e => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function MenuRow({
  active, onClick, primary, secondary, left, tag, right,
}: {
  active?: boolean;
  onClick: () => void;
  primary: string;
  secondary?: string;
  left?: React.ReactNode;
  /** Optional small label rendered after `primary` ("Preview",
   *  "Legacy"). Quiet styling — it's a context cue, not a CTA. */
  tag?: string;
  /** Optional element rendered on the trailing edge (right side of
   *  the row). Used by the History chip to show a green check on
   *  the currently-resumed conversation. */
  right?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%", textAlign: "left",
        display: "flex", alignItems: "center", gap: 10,
        padding: "7px 10px",
        background: "transparent",
        border: "none", outline: "none", cursor: "pointer",
        borderRadius: 5,
        color: "var(--c-fg, #dcdcdc)",
        fontFamily: "var(--font-sans)",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.06))"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
    >
      {left && <span style={{ display: "inline-flex", flexShrink: 0 }}>{left}</span>}
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{
          display: "flex", alignItems: "center", gap: 6, minWidth: 0,
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
          color: active ? "var(--c-fg, #ffffff)" : "var(--c-fg, #e6e6e6)",
        }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {primary}
          </span>
          {tag && (
            <span style={{
              flexShrink: 0,
              fontSize: 9.5, fontWeight: 600,
              letterSpacing: 0.3, textTransform: "uppercase",
              padding: "0.5px 5px", borderRadius: 3,
              color: "var(--c-ghost, #7a7a7a)",
              background: "var(--c-srf2, rgba(255,255,255,0.04))",
              border: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
            }}>{tag}</span>
          )}
        </span>
        {secondary && (
          <span style={{ fontSize: 11, color: "var(--c-dim, #8a8a8a)" }}>{secondary}</span>
        )}
      </span>
      {right ? <span style={{ flexShrink: 0, display: "inline-flex" }}>{right}</span>
        : active ? <Check size={12} strokeWidth={2.5} style={{ color: "var(--c-fg, #e6e6e6)", flexShrink: 0 }} /> : null}
    </button>
  );
}

/* ─── ModelMenu — provider list with hover-revealed model panel ───
   Replaces the old "every model from every provider in one flat
   scroll" dropdown. Two columns:
     LEFT  — one row per provider (Claude / Codex / OpenAI / Gemini)
     RIGHT — that provider's models, swapped in on hover or click

   Hover on a provider row immediately swaps the right panel to its
   models (no click required) so a user landing on the menu can scan
   without committing. Click on a model commits + closes. Keeps the
   "currently active" provider highlighted on the left, and the
   currently active model checkmarked on the right when its provider
   is the visible one. */
function ModelMenu({
  tool, model, providers, onPick,
}: {
  tool: string;
  model: string | null;
  providers: ProviderDef[];
  onPick: (providerId: ProviderDef["id"], modelId: string) => void;
}) {
  // The provider whose models are currently shown on the right. Defaults
  // to the active tool so the user lands looking at "what they already
  // have" instead of an arbitrary first item.
  const initial = (providers.find(p => p.id === tool) ?? providers[0]!).id;
  const [hoveredId, setHoveredId] = useState<ProviderDef["id"]>(initial);
  const visible = providers.find(p => p.id === hoveredId) ?? providers[0]!;
  return (
    <div
      role="menu"
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: "absolute",
        // Open UPWARD — toolbar lives at the bottom of the chat
        // surface, so a downward menu was getting clipped past the
        // window edge. Bottom-anchored matches the standard Menu
        // (Local/Git/perms/history all open up too).
        bottom: "calc(100% + 6px)",
        left: 0,
        zIndex: 60,
        display: "flex",
        background: "var(--popover, #1a1a1a)",
        border: "1px solid var(--c-brd, rgba(255,255,255,0.10))",
        borderRadius: 8,
        boxShadow: "0 -14px 36px rgba(0,0,0,0.45)",
        animation: "fleet-popover-up 0.14s ease-out both",
        overflow: "hidden",
        textAlign: "left",
      }}
    >
      {/* Provider rail */}
      <div style={{
        display: "flex", flexDirection: "column",
        padding: 4, minWidth: 132,
        borderRight: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
      }}>
        {providers.map(p => {
          const isHovered = p.id === hoveredId;
          const isActive  = p.id === tool;
          return (
            <button
              key={p.id}
              onMouseEnter={() => setHoveredId(p.id)}
              onFocus={() => setHoveredId(p.id)}
              onClick={() => setHoveredId(p.id)}
              style={{
                display: "flex", alignItems: "center", gap: 9,
                width: "100%", textAlign: "left",
                padding: "6px 10px",
                background: isHovered
                  ? "var(--c-srf, rgba(255,255,255,0.06))"
                  : "transparent",
                border: "none", outline: "none", cursor: "pointer",
                borderRadius: 5,
                color: "var(--c-fg, #e6e6e6)",
                fontFamily: "var(--font-sans)",
                fontSize: 12.5, fontWeight: isActive ? 600 : 500,
              }}
            >
              <p.Logo size={12} />
              <span style={{ flex: 1 }}>{p.label}</span>
              {isActive && (
                <span style={{
                  width: 5, height: 5, borderRadius: "50%",
                  background: "var(--c-fg, #e6e6e6)",
                  flexShrink: 0,
                }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Model panel — height matches the 4-row provider rail so the
          popover stays compact ("provider'lerin büyüklüğünde olsun"
          per the user). Long catalogs scroll inside this fixed box;
          short ones leave neutral whitespace at the bottom. Stable
          height also prevents the bottom-anchored popover's top edge
          from jumping when the user hovers between providers. */}
      <div style={{
        display: "flex", flexDirection: "column",
        padding: 4, width: 260,
        height: 240, overflowY: "auto",
      }}>
        <div style={{
          padding: "5px 10px 4px",
          fontSize: 10.5, fontWeight: 500,
          letterSpacing: 0.3, textTransform: "uppercase",
          color: "var(--c-dim, #7a7a7a)",
          position: "sticky", top: 0,
          background: "var(--popover, #1a1a1a)",
          zIndex: 1,
        }}>
          {visible.label} models
        </div>
        {visible.models.map(m => (
          <MenuRow
            key={m.id}
            active={model === m.id && tool === visible.id}
            onClick={() => onPick(visible.id, m.id)}
            primary={m.label}
            secondary={m.ctx}
            tag={m.note}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Path matching helpers (for the History chip) ─────────────────
   Sessions on the "same project" can disagree on exact path because
   a clone of `foo/bar.git` lands at `~/.fleetify/clones/bar` and a
   subsequent fork mounts as `~/.fleetify/worktrees/bar-abc123/`. Match
   either by exact path or by sharing the same leaf directory name
   (`bar` in this case) — strongest "same project" signal we have
   client-side without a real DB join. */
/* (matchByLeafDir / leafDir removed — the old History chip used them
   to fuzzy-match worktree clones of the same source repo against each
   other when filtering Fleet's own sessions. The new History chip
   targets Claude CLI's native conversation log on the SELECTED path
   only, so fuzzy worktree matching isn't needed any more.) */
