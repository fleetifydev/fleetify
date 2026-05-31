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
  Github, Server, Box,
} from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { updateSession as apiUpdateSession, cloneRepository, fetchClaudeSessions, fetchClaudeHistory, fetchAgentModels, fetchProviderModels, type ClaudeSession } from "@/lib/api";
import { extractOwnerRepo } from "@/lib/git-url";
import { GitSourceTab } from "./git-source-tab";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { wsManager } from "@/services/ws-manager";
import type { ChatMessage } from "@/types/chat";
import type { Session } from "@/types/session";
import { RemoteSshPanel } from "./remote-ssh-panel";
import { DockerContainerPanel } from "./docker-container-panel";
import { folderName as folderNameUtil } from "@/lib/utils";
import { UnifiedModelPicker, type Effort as UMEffort } from "./unified-model-picker";
import {
  buildPickerGroups,
  resolveDispatchTool,
  resolveModelChip,
  type PickerGroup,
  type PickerModel,
} from "@/lib/picker-groups";
import { useProvidersConfig } from "@/hooks/use-providers-config";

type MenuId = "source" | "git" | "model" | "perms" | "history" | null;

// The `id` values double as both the CLI agents' `--permission-mode`
// flag AND the agentic-loop autonomy switch for HTTP-provider sessions
// (mapping lives in `chat.rs` + `bridges/antigravity_sdk.rs`). HTTP
// providers ALWAYS get workspace context regardless of choice — the
// tiers control which tools (read / edit / shell) the model can run
// unattended.
const PERMS: { id: string; label: string; desc: string }[] = [
  { id: "default",           label: "Ask",          desc: "Read tools auto; edits & shell denied (HTTP) / confirm (CLI)" },
  { id: "acceptEdits",       label: "Accept edits", desc: "Read + write auto; shell denied (HTTP) / confirm (CLI)" },
  { id: "bypassPermissions", label: "Bypass permissions", desc: "All tools without asking" },
  { id: "plan",              label: "Plan only",    desc: "No execution — just a plan (CLI agents only)" },
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
  // Are we configuring a not-yet-committed session right now? Two
  // signals collapse into one boolean:
  //   • composer.open  — Phase-7 composer is the canonical source; the
  //                      session doesn't exist in sessions[] yet and
  //                      its render fields come from chat-view's
  //                      virtual-session synthesis.
  //   • legacy local_only — kept for any remaining call sites that
  //                         still pass a real `sessions[]` row with the
  //                         old draft flag (none should after Phase 7c
  //                         but the check is cheap defensiveness).
  // While isDraft, the chip strip writes to composer / draft state
  // only — NO backend PATCH, NO worktree creation, NO row anywhere —
  // because the session doesn't exist server-side yet. The first user
  // message commits it via commitDraft → commitComposer.
  const session = useAppStore(s => s.sessions.find(x => x.id === sessionId));
  const composerOpen = useAppStore(s => s.composer.open);
  const pendingCloneUrl = useAppStore(s => s.composer.pendingCloneUrl);
  const isDraft = composerOpen || session?.local_only === true;
  const [openMenu, setOpenMenu] = useState<MenuId>(null);

  // ── git binary presence ──
  // Same probe new-agent-dialog's WorktreeToggle runs. When git
  // isn't on PATH, branch + worktree chips become disabled with a
  // helpful tooltip — every backend git op (init, worktree carve,
  // Create PR) would hard-fail without it. Forced `use_worktree=false`
  // below mirrors the dialog's auto-off behaviour so the session
  // doesn't get persisted with a flag we can't honour.
  const [gitPresent, setGitPresent] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.electronAPI?.hasGit?.();
        if (!cancelled) setGitPresent(!!r?.ok);
      } catch {
        if (!cancelled) setGitPresent(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (gitPresent === false && useWorktree) {
      // Mirror the new-agent-dialog auto-off — never let the session
      // carry use_worktree=true on a git-less host.
      if (isDraft) {
        setDraftField({ use_worktree: false });
      }
    }
  }, [gitPresent, useWorktree, isDraft, setDraftField]);

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
  // Source tab — Local (browse), Git (repo list + clone-by-URL),
  // Remote (SSH host management), Container (running Docker containers).
  // The Git tab's repo-list state lives inside <GitSourceTab/>.
  const [sourceTab,   setSourceTab]   = useState<"local" | "git" | "remote" | "container">("local");
  const wrapRef = useRef<HTMLDivElement>(null);

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

  // Folder-pick / clone handlers only patch `project_path` now. The
  // session's title (and therefore the branch name) is derived from
  // the folder basename downstream — `commitComposer` falls back to
  // `folderName(projectPath)` when composer.title is the "New chat"
  // placeholder, and the BranchStrip's `computeBranchName(label, id,
  // projectPath)` mirrors the same fallback for the planned-branch
  // label. This way Windows path edge cases (titleFromPath used to
  // split on `/` only, producing slugs like `fleet/C-Users-Lenovo-
  // Desktop-foo-…` when run on `C:\Users\Lenovo\Desktop\foo`) live
  // in one place: `folderName` in `@/lib/utils`, which already
  // handles both separators.

  const pickFolder = useCallback(async () => {
    const w = window as unknown as { electronAPI?: { openFolderDialog?: () => Promise<string | null> } };
    if (w.electronAPI?.openFolderDialog) {
      const p = await w.electronAPI.openFolderDialog();
      if (p) {
        await patch({ project_path: p });
        setOpenMenu(null);
      }
      return;
    }
    const p = window.prompt("Project folder path");
    if (p) {
      await patch({ project_path: p });
      setOpenMenu(null);
    }
  }, [patch]);

  // Repo picker handler. Two paths:
  //   • draft mode (composer is open) → stash the URL in
  //     pendingCloneUrl + clear projectPath. The actual `git clone`
  //     is deferred until commitComposer runs on first chat send.
  //   • committed session → fall back to the legacy immediate-clone
  //     flow (the session already has a real backend row + worktree,
  //     so changing repo mid-session needs an immediate path swap).
  const pickRepo = useCallback(async (url: string) => {
    const u = url.trim();
    if (!u) return;
    if (isDraft) {
      setDraftField({ pending_clone_url: u, project_path: "" });
      setOpenMenu(null);
      return;
    }
    try {
      const r = await cloneRepository(u);
      await patch({ project_path: r.path });
      setOpenMenu(null);
    } catch (e) {
      console.error("toolbar pickRepo clone failed:", e);
    }
  }, [isDraft, setDraftField, patch]);

  const pickPerm = useCallback((id: string) => {
    patch({ permission_mode: id });
    setOpenMenu(null);
  }, [patch]);

  const folderName = projectPath
    ? (folderNameUtil(projectPath) || projectPath)
    : null;

  const permLabel   = PERMS.find(p => p.id === permissionMode)?.label ?? permissionMode;

  const { tiles: providerTiles } = useProvidersConfig();
  const effort: UMEffort = session?.effort ?? "high";
  const enabledAgentIds = providerTiles
    .filter((t) => t.spec.kind === "cli" && t.connected)
    .map((t) => t.spec.id);
  // OpenCode and Cursor source their model list from the live ACP session
  // (catalog default_models is empty). Two sources feed the picker rail:
  //   1. The ACTIVE session's live list — pushed by the bridge via
  //      `available_models_update` once it cold-starts (freshest, only for
  //      the running agent), keyed by the session's own tool.
  //   2. A discovered FULL catalog for every live-model agent, fetched lazily
  //      from the backend (`opencode models` / a Cursor ACP probe) when the
  //      model menu opens — so the rail shows the complete real list even
  //      before any session of that agent has cold-started.
  // Both override the static CLI_MODELS fallback in buildPickerGroups.
  const sessionDynModels = useChatStore((s) => s.dynamicModels[sessionId]);
  // OpenRouter is a connected HTTP provider whose live catalog (hundreds of
  // models) is discovered on demand. Only worth fetching when it's actually
  // enabled — the picker rail won't render otherwise.
  const openrouterConnected = providerTiles.some(
    (t) => t.spec.id === "openrouter" && t.connected,
  );
  const [discoveredModels, setDiscoveredModels] = useState<Record<string, PickerModel[]>>({});
  useEffect(() => {
    if (openMenu !== "model") return; // discover lazily, only when the picker opens
    let cancelled = false;
    for (const agentId of ["opencode", "cursor", "github-copilot"]) {
      void fetchAgentModels(agentId, projectPath ?? "").then((models) => {
        if (cancelled || models.length === 0) return; // empty → keep static fallback
        setDiscoveredModels((prev) => ({
          ...prev,
          [agentId]: models.map((m) => ({ id: m.id, label: m.label, supports_effort: false })),
        }));
      });
    }
    // OpenRouter's full catalog comes from the backend's live `/models` proxy.
    if (openrouterConnected) {
      void fetchProviderModels("openrouter").then((models) => {
        if (cancelled || models.length === 0) return; // empty → keep curated fallback
        setDiscoveredModels((prev) => ({
          ...prev,
          openrouter: models.map((m) => ({
            id: m.id,
            label: m.label,
            ctx: m.ctx,
            supports_effort: false,
          })),
        }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [openMenu, projectPath, openrouterConnected]);
  const dynamicModels: Record<string, PickerModel[]> | undefined = (() => {
    const merged: Record<string, PickerModel[]> = { ...discoveredModels };
    if (sessionDynModels && sessionDynModels.models.length > 0) {
      merged[tool] = sessionDynModels.models.map((m) => ({
        id: m.id,
        label: m.label,
        supports_effort: false,
      }));
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  })();
  const groups: PickerGroup[] = buildPickerGroups(
    providerTiles,
    enabledAgentIds,
    dynamicModels,
  );

  return (
    <div
      ref={wrapRef}
      style={{
        display: "flex", flexWrap: "wrap", alignItems: "center",
        // Slightly more breathing room than before — 4 was too tight,
        // chips ran into each other visually.
        rowGap: 6, columnGap: 6,
        padding: "0 0 8px",
        // position:relative makes this row the containing block for the
        // model picker popover rendered below, so the picker's `left:0`
        // anchors to the toolbar's LEFT edge (left of the pick-folder chip)
        // and opens upward — not next to the model chip on the right.
        position: "relative",
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
              <GitSourceTab onPick={(url) => void pickRepo(url)} />
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
                  void patch({ project_path: remoteUrl });
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
                  void patch({ project_path: containerUrl });
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
        const isClonePath     = !!(projectPath && projectPath.includes("/.fleetify/clones/"));
        const hasPendingClone = !!pendingCloneUrl;
        const inGitMode       = sourceTab === "git" || hasPendingClone || isClonePath;
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
        // Display preference:
        //   1. pendingCloneUrl set → owner/repo derived from the URL
        //      the user just picked (clone deferred until commit).
        //   2. projectPath under ~/.fleetify/clones/ → owner/repo from
        //      the clone-key path layout (host/owner/repo).
        //   3. container/remote URL → last path segment after stripping
        //      the scheme prefix.
        //   4. plain folder → leaf name (existing behaviour).
        const display = (() => {
          if (hasPendingClone) {
            return extractOwnerRepo(pendingCloneUrl!) ?? "Repository";
          }
          if (!projectPath) return null;
          if (isContainerPath) {
            const tail = projectPath.replace(/^docker:\/\/[^/]+/, "").replace(/\/+$/, "");
            return tail.split("/").filter(Boolean).pop() ?? "Container";
          }
          if (isRemotePath) {
            const tail = projectPath.replace(/^ssh:\/\/[^/]+/, "").replace(/\/+$/, "");
            return tail.split("/").filter(Boolean).pop() ?? "Remote";
          }
          if (isClonePath) {
            return extractOwnerRepo(projectPath) ?? folderName;
          }
          return folderName;
        })();
        const label = display ?? placeholder;
        const hasSelection = !!(projectPath || hasPendingClone);
        const onClick = () => {
          if (hasSelection) {
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
            <span style={{ color: hasSelection ? "var(--c-fg, #e6e6e6)" : "var(--c-dim, #9a9a9a)" }}>
              {label}
            </span>
          </Chip>
        );
      })()}

      {/* ── Model — single chip carrying the provider logo + the
            current model name + effort. Opens UnifiedModelPicker
            (three-column: providers | models | effort). ── */}
      {(() => {
        // Shared resolver — keeps this chip byte-for-byte identical to the
        // chat composer's model chip (chat-input.tsx uses the same
        // resolveModelChip + the same groups), so the two can never disagree.
        const { dispatchTool, label: modelLabel } = resolveModelChip(groups, tool, model);
        const effortShort: Record<UMEffort, string> = {
          low: "Low", medium: "Med", high: "High", extra_high: "X-Hi", max: "Max",
        };
        return (
          <Chip
            active={openMenu === "model"}
            chevron
            onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
          >
            <ProviderLogo tool={dispatchTool} size={12} />
            <span>{modelLabel}</span>
            <span style={{ color: "var(--c-dim)", fontSize: 10 }}>·</span>
            <span style={{ color: "var(--c-low)", fontSize: 10.5 }}>{effortShort[effort]}</span>
          </Chip>
        );
      })()}

      {/* Model picker popover — rendered at the TOOLBAR-ROOT level (a direct
          child of the position:relative chip row), NOT inside the model
          Chip, for two reasons: (1) a <button> can't legally contain the
          picker's <button> rows, and the old nesting let row clicks bubble
          to the Chip's onClick and close the menu mid-select; (2) with the
          picker's built-in `left:0` it now anchors to the toolbar's LEFT
          edge (left of the pick-folder chip) and opens upward — matching the
          chat composer's far-left placement. */}
      {openMenu === "model" && (
        <UnifiedModelPicker
          tool={tool}
          model={model}
          effort={effort}
          groups={groups}
          onPickModel={(groupId, modelId) => {
            if (groupId === "auto") {
              // Auto is Fleet-owned: the backend routes via Fleet's own Not
              // Diamond key (.env), independent of the user's Settings →
              // Routers config. Just pin the routing sentinel.
              void patch({ tool: "auto", model_name: "auto" });
              return;
            }
            const next = resolveDispatchTool(groupId);
            const updates: Record<string, unknown> = { model_name: modelId };
            if (next !== tool) updates.tool = next;
            patch(updates);
            // OpenCode + Cursor source models at runtime — switch the
            // live ACP session too (the patch alone only affects the next
            // cold start). Skipped for drafts (no live bridge yet).
            if ((next === "opencode" || next === "cursor") && !isDraft) {
              wsManager.switchModel(sessionId, modelId);
            }
          }}
          onPickEffort={(e) => {
            patch({ effort: e });
            // OpenCode + Cursor apply effort live via set_config_option.
            if ((tool === "opencode" || tool === "cursor") && !isDraft) {
              wsManager.switchConfig(sessionId, "effort", e);
            }
          }}
          onClose={() => setOpenMenu(null)}
          // Open UPWARD (above the toolbar / "Local" area), matching the
          // other toolbar menus and the chat composer's picker.
          anchor="bottom"
        />
      )}

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
        // Git missing on the host disables both segments — neither the
        // branch picker nor the worktree toggle has anything to do
        // without git. We pass through to the same `disabled` /
        // `branchDisabled` flags so the rest of the chip's visuals
        // (opacity, cursor, etc.) just work.
        const gitMissing = gitPresent === false;
        const disabled = !projectPath || gitMissing;
        const noRepo = !disabled && !branchesLoading && branches.current === null && branches.local.length === 0;
        const branchDisabled = disabled || noRepo;
        const current = branches.current ?? "—";
        const filter = branchFilter.trim().toLowerCase();
        const matchedLocal  = branches.local.filter(b => !filter || b.toLowerCase().includes(filter));
        const matchedRemote = branches.remote.filter(b => !filter || b.toLowerCase().includes(filter));
        const branchTitle =
          gitMissing ? "Git not detected — install Git to use branches"
          : disabled  ? "Pick a folder first to see branches"
          : noRepo  ? "Git unavailable in this folder"
          : branchSwitching ? "Switching branch…"
          : `On '${current}'. Click to switch.`;
        const wtTitle =
          gitMissing ? "Git not detected — worktrees require Git"
          : disabled  ? "Pick a folder first"
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
