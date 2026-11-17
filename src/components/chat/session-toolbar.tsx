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
import { claimEscape } from "@/hooks/use-escape-to-stop";
import {
  FolderOpen, Monitor, History, Plus, Check, ChevronDown,
  GitBranch, Search as SearchIcon,
  Github, Server, Box,
} from "lucide-react";
import { updateSession as apiUpdateSession, cloneRepository, fetchClaudeSessions, fetchClaudeHistory, listRemoteBranches, dockerContainers, type ClaudeSession } from "@/lib/api";
import { registerConfigPatch } from "@/lib/session-config-sync";
import { extractOwnerRepo } from "@/lib/git-url";
import { GitSourceTab } from "./git-source-tab";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import type { ChatMessage } from "@/types/chat";
import type { Session } from "@/types/session";
import { RemoteSshPanel } from "./remote-ssh-panel";
import { DockerContainerPanel } from "./docker-container-panel";
import { SessionRulesChip } from "./session-rules-chip";
import { folderName as folderNameUtil } from "@/lib/utils";
import {
  isHostPath, containerIdFromPath, normalizeBranches, EMPTY_BRANCHES,
  leafName, parentDir, relativeWithin, displayBranch, attachDisplay,
  type BranchList, type ExecMode,
} from "@/lib/exec-target";

type MenuId = "source" | "git" | "history" | null;

export function SessionToolbar({
  sessionId,
  projectPath,
  tool,
  claudeSessionId,
  useWorktree,
}: {
  sessionId: string;
  projectPath: string | null;
  tool: string;
  model: string | null;
  permissionMode: string;
  /** Controlled effort level — passed from chat-view so the toolbar
   *  reflects the composer's effort on a draft without needing a real
   *  session row. Falls back to session?.effort, then "high". */
  effort?: string;
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
  const pendingCloneBranch = useAppStore(s => s.composer.pendingCloneBranch);
  const composerExecMode = useAppStore(s => s.composer.execMode);
  const composerMountCreds = useAppStore(s => s.composer.containerMountCredentials);
  const composerImage = useAppStore(s => s.composer.containerImage);
  const isDraft = composerOpen || session?.local_only === true;
  // Where this session's agent runs. Falls back to parsing project_path so a
  // row written before the exec_mode column resolves the same way the
  // backend's `Session::exec_target` does, rather than reading as a host
  // session and re-showing the Git surface.
  // Draft sessions have no backend row, so the pick lives in composer state
  // until the first message commits it. Reading only `session` here made the
  // chip look inert while configuring a new session.
  const execMode: ExecMode =
    (isDraft ? composerExecMode : session?.exec_mode) ??
    (projectPath?.startsWith("docker://") ? "docker-attach" : "host");
  const containerId = session?.container_id ?? containerIdFromPath(projectPath);
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

  // ── Git-draft branch data (pre-clone) ──
  // While the clone is deferred (Git tab, pendingCloneUrl set) the branch
  // chip lists the REMOTE's branches via the backend's ls-remote endpoint —
  // no disk writes, no clone. Selection is a draft-field write; the pick is
  // honoured at commit (clone --branch, or the worktree's checkout).
  const [remoteInfo, setRemoteInfo] = useState<{ url: string; def: string | null; branches: string[] } | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  // No reset-on-url-change effect: staleness is handled by KEYING the data
  // to its url — consumers ignore an entry whose url no longer matches, and
  // the menu-open handler refetches on mismatch.
  const loadRemoteBranches = useCallback(async (url: string) => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const r = await listRemoteBranches(url);
      setRemoteInfo({ url, def: r.default_branch, branches: r.branches });
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteLoading(false);
    }
  }, []);

  // ── Git branch chip data ──
  // Reads the picked folder's local + remote branches via the
  // Electron IPC (which shells out to `git for-each-ref`). Refreshed
  // whenever the folder changes; debounced so picking a folder then
  // browsing branches doesn't race the IPC.
  const [branches, setBranches]       = useState<BranchList>(EMPTY_BRANCHES);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchFilter, setBranchFilter]       = useState("");
  const [branchSwitching, setBranchSwitching] = useState(false);
  const branchesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadBranches = useCallback(async () => {
    // Host git can only act on a host checkout. Running `listGitBranches`
    // against a `docker://…` (or `ssh://…`) path shells out to git in a
    // directory that does not exist, and the malformed result it returns
    // then crashed the render — `branches.local` came back undefined and
    // `.filter` blew up the whole toolbar. Guarding the CHIP was not enough;
    // the fetch itself must not run.
    if (!projectPath || !isHostPath(projectPath) || !window.electronAPI?.listGitBranches) {
      setBranches(EMPTY_BRANCHES);
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
      // Normalise rather than trusting the shape: `r ?? default` only guards
      // a null result, not one that came back missing its arrays.
      setBranches(normalizeBranches(r));
    } catch {
      setBranches(EMPTY_BRANCHES);
    } finally {
      setBranchesLoading(false);
    }
  }, [projectPath]);
  useEffect(() => {
    setBranches(EMPTY_BRANCHES);
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
  /** Resume-picker UI: filter to a single Claude account ("All" → every row).
   *  Resets when the popover closes so a fresh open lands on "All". */
  const [historyAccountFilter, setHistoryAccountFilter] = useState<string | null>(null);
  /** Resume-picker UI: free-text filter over the summary preview. */
  const [historyQuery, setHistoryQuery] = useState("");
  /** Resume-picker UI: scope. "all" walks every project across every account
   *  (the user has multiple cwd encodings for the same topic — e.g. `ct` vs
   *  `canadiantire` — so a folder-scoped picker hides legit history); "folder"
   *  filters to the active project. Default = "all" so nothing's hidden. */
  const [historyScope, setHistoryScope] = useState<"all" | "folder">("all");
  const cliHistoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Reset immediately when the folder changes so stale entries don't
    // flash before the next fetch settles.
    setCliHistory([]);
    if (!projectPath || tool !== "claude-code") return;
    if (cliHistoryTimer.current) clearTimeout(cliHistoryTimer.current);
    cliHistoryTimer.current = setTimeout(async () => {
      setCliHistoryLoading(true);
      try {
        // Scope: "all" → global (no path, every account × every project).
        // Powers the UX where the same logical topic lives under multiple
        // cwds (e.g. `ct` vs `canadiantire`) — folder-scoped would hide one.
        const rows = await fetchClaudeSessions(
          historyScope === "folder" ? projectPath : undefined,
        );
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
  }, [projectPath, tool, historyScope]);
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
      if (e.key !== "Escape") return;
      // Claim the key so closing this does nothing else: no stop, no back
      // to Fleet, no permission deny. This document listener runs before
      // those window ones.
      claimEscape(e);
      setOpenMenu(null);
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
    // Track the PATCH so a WS send waits for it to commit (model/tool changes
    // otherwise race the send over a different channel — see session-config-sync).
    const p = apiUpdateSession(sessionId, updates);
    registerConfigPatch(sessionId, p);
    try { await p; }
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

  // Folder pick for the Container tab's run recipes: same OS dialog, but
  // the picker STAYS open — the user is mid-setup (image/Dockerfile/compose
  // fields still to fill), and closing the menu on them lost the flow.
  // Dockerfile / compose pick, via the OS FILE dialog. The file is the
  // primary object; the project folder is inferred from it rather than
  // asked for twice:
  //   · no folder yet            → folder := the file's directory
  //   · file inside the folder   → store it relative (pretty, and robust
  //                                to the folder moving)
  //   · compose outside          → the folder FOLLOWS the file. Compose's
  //                                own default is project-dir = file-dir,
  //                                and a folder that contradicts the stack
  //                                it hosts helps nobody.
  //   · dockerfile outside       → keep the folder (it is the build
  //                                context — `docker build -f` explicitly
  //                                supports a Dockerfile outside it) and
  //                                store the file absolute.
  const pickProjectFile = useCallback(async (kind: "dockerfile" | "compose"): Promise<string | null> => {
    const w = window as unknown as {
      electronAPI?: {
        openFileDialog?: (opts: { defaultDir?: string; extensions?: string[]; title?: string }) => Promise<string | null>;
      };
    };
    const hostFolder = projectPath && isHostPath(projectPath) ? projectPath : null;
    const picked = w.electronAPI?.openFileDialog
      ? await w.electronAPI.openFileDialog({
          defaultDir: hostFolder ?? undefined,
          // A Dockerfile has no extension, so a filter would hide it —
          // that kind gets an unfiltered dialog.
          extensions: kind === "compose" ? ["yml", "yaml"] : undefined,
          title: kind === "compose" ? "Choose a compose file" : "Choose a Dockerfile",
        })
      : window.prompt(kind === "compose" ? "Compose file path" : "Dockerfile path");
    if (!picked) return null;

    if (!hostFolder) {
      await patch({ project_path: parentDir(picked) });
      return leafName(picked);
    }
    const rel = relativeWithin(picked, hostFolder);
    if (rel) return rel;
    if (kind === "compose") {
      await patch({ project_path: parentDir(picked) });
      return leafName(picked);
    }
    return picked;
  }, [patch, projectPath]);

  // Cancel the container target. The exec fields alone are NOT enough for
  // an attach session: its project_path IS the `docker://` marker, and the
  // backend re-derives docker-attach from the marker at create — so a
  // "cancelled" draft quietly came back as a container session. The marker
  // has to be replaced too: a draft can fall back to no-folder-picked, but
  // a real session's PATCH rejects a blank path, so there the user picks
  // the folder to land on and cancelling the dialog cancels the detach.
  const clearContainerTarget = useCallback(async () => {
    const hostFields = {
      exec_mode: "host" as const,
      container_source: "image" as const,
      container_image: null,
      container_file: null,
      container_service: null,
      container_id: null,
    };
    if (!projectPath?.startsWith("docker://")) {
      await patch(hostFields);
      setOpenMenu(null);
      return;
    }
    if (isDraft) {
      await patch({ ...hostFields, project_path: "" });
      setOpenMenu(null);
      return;
    }
    const w = window as unknown as { electronAPI?: { openFolderDialog?: () => Promise<string | null> } };
    const picked = w.electronAPI?.openFolderDialog
      ? await w.electronAPI.openFolderDialog()
      : window.prompt("Folder to work in instead");
    if (!picked) return; // dialog cancelled → stay attached
    await patch({ ...hostFields, project_path: picked });
    setOpenMenu(null);
  }, [patch, projectPath, isDraft]);

  const pickFolderForMount = useCallback(async () => {
    const w = window as unknown as { electronAPI?: { openFolderDialog?: () => Promise<string | null> } };
    const picked = w.electronAPI?.openFolderDialog
      ? await w.electronAPI.openFolderDialog()
      : window.prompt("Project folder path");
    if (picked) await patch({ project_path: picked });
  }, [patch]);

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

  const folderName = projectPath
    ? (folderNameUtil(projectPath) || projectPath)
    : null;


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
          // Container is no longer a source, so this is purely "does the
          // project path itself live inside a container" — i.e. attach mode.
          // A docker-run session's source is still Local or Git.
          const isContainer = !!(projectPath && projectPath.startsWith("docker://"));
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

            {/* ── Container tab — where the agent RUNS.
                Semantically still an execution target (exec_mode is
                orthogonal to the source columns), but presented as a tab:
                in practice it is picked at the same moment as the source,
                and a separate chip buried it. Attach replaces the project
                path with the container's own URL; the run recipes keep the
                HOST folder — pickable right here — and mount it, which is
                what keeps branches and worktrees working. */}
            {sourceTab === "container" && (
              <DockerContainerPanel
                sourcePath={projectPath}
                execMode={execMode}
                providerId={tool}
                onAttach={(containerUrl) => {
                  void patch({ project_path: containerUrl });
                  setOpenMenu(null);
                }}
                onRun={(payload) => {
                  void patch({
                    exec_mode: "docker-run",
                    container_source: payload.source,
                    container_image: payload.image ?? null,
                    container_file: payload.file ?? null,
                    container_service: payload.service ?? null,
                    container_mount_credentials: payload.mountCredentials,
                  });
                  setOpenMenu(null);
                }}
                onClear={() => { void clearContainerTarget(); }}
                onPickFolder={() => { void pickFolderForMount(); }}
                onPickFile={pickProjectFile}
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
        // Attach sessions carry the container URL as their project path, so
        // the readout chip still has a container flavour even though there
        // is no container *tab* any more.
        const inContainerMode = isContainerPath;
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
            // Attached at the container root, the old leaf-of-path logic had
            // nothing to show and fell through to the literal "Container" —
            // which says nothing about WHICH one. The short id does.
            return attachDisplay(projectPath);
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

      {/* ── Container chip — status only.
            Visible only while the session actually executes in a container:
            the container's name and a live/dead dot polled off `docker ps`.
            Configuration lives in the source picker's Container tab —
            clicking the chip jumps straight there. A dead container used to
            be discovered at the next turn's re-probe, i.e. by the turn
            failing; the dot says it first. ── */}
      {execMode !== "host" && (
        <ContainerChip
          containerId={containerId}
          containerImage={isDraft ? composerImage : session?.container_image ?? null}
          mode={execMode}
          mountsCredentials={isDraft ? composerMountCreds : session?.container_mount_credentials === true}
          onOpenPicker={() => {
            setSourceTab("container");
            setOpenMenu("source");
          }}
        />
      )}

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
        // A `docker-attach` session's files live inside a container we did
        // not create, so there is no host checkout for git to act on and the
        // whole chip is meaningless. `docker-run` is the opposite: it
        // bind-mounts a HOST checkout, so branches and worktrees apply
        // exactly as they do for a plain local session — that orthogonality
        // is the point of the mode, and gating on "is it containerised"
        // rather than "is there a host workspace" would take it away.
        const gitMissing = gitPresent === false || execMode === "docker-attach";
        // Git draft mode: repo picked, clone deferred — both segments work
        // off the REMOTE (ls-remote list; worktree is just a flag until
        // commit), so a local path is not required.
        const inGitDraft = isDraft && !!pendingCloneUrl && !projectPath;
        // Ignore a fetched list that belongs to a previously-picked repo.
        const liveRemote = remoteInfo && remoteInfo.url === pendingCloneUrl ? remoteInfo : null;
        const disabled = gitMissing || (!projectPath && !inGitDraft);
        const noRepo = !inGitDraft && !disabled && !branchesLoading && branches.current === null && branches.local.length === 0;
        const branchDisabled = disabled || noRepo;
        const pickedRemote = inGitDraft ? (pendingCloneBranch ?? liveRemote?.def ?? null) : null;
        // displayBranch: the real HEAD branch now that the IPC reports one,
        // falling back to main/master for detached or just-initialised
        // repos — "—" on a healthy repo read as "this folder has no git".
        const current = inGitDraft
          ? (pickedRemote ?? "default")
          : (displayBranch(branches.current, branches.local) ?? "—");
        const filter = branchFilter.trim().toLowerCase();
        const matchedLocal  = branches.local.filter(b => !filter || b.toLowerCase().includes(filter));
        const matchedRemote = branches.remote.filter(b => !filter || b.toLowerCase().includes(filter));
        const matchedRemoteOnly = (liveRemote?.branches ?? []).filter(b => !filter || b.toLowerCase().includes(filter));
        const branchTitle =
          gitMissing ? "Git not detected — install Git to use branches"
          : inGitDraft ? (pendingCloneBranch
            ? `Cloning '${pendingCloneBranch}'. Click to change.`
            : "Repo's default branch. Click to pick another.")
          : disabled  ? "Pick a folder first to see branches"
          : noRepo  ? "Git unavailable in this folder"
          : branchSwitching ? "Switching branch…"
          : `On '${current}'. Click to switch.`;
        const wtTitle =
          gitMissing ? "Git not detected — worktrees require Git"
          : disabled  ? "Pick a folder or repo first"
          : useWorktree
            ? "Working in an isolated worktree — parallel-safe. Click to disable."
            : "Working directly in the project — no worktree. Click to enable.";
        const isOpen = openMenu === "git";

        // Shared chip-shell visuals — pulled from the Chip primitive
        // so this composite reads as a single chip in the strip.
        // Ghost-minimal to match the standalone chips: transparent box,
        // a faint fill only while the branch menu is open. The internal
        // separator keeps the branch | worktree segments reading as one
        // grouped control even without a surrounding outline.
        const shellBg = isOpen ? "rgba(var(--fg-rgb),0.10)" : "transparent";
        const shellBorder = "transparent";
        const shellSep = "rgba(var(--fg-rgb),0.12)";

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
            onMouseEnter={e => { if (!disabled && !isOpen) e.currentTarget.style.background = "rgba(var(--fg-rgb),0.06)"; }}
            onMouseLeave={e => { if (!isOpen) e.currentTarget.style.background = "transparent"; }}
          >
            {/* ── LEFT: branch trigger ── */}
            <button
              onClick={() => {
                if (branchDisabled) return;
                setOpenMenu(isOpen ? null : "git");
                if (!isOpen) {
                  setBranchFilter("");
                  if (inGitDraft) {
                    if (!remoteInfo || remoteInfo.url !== pendingCloneUrl) {
                      void loadRemoteBranches(pendingCloneUrl!);
                    }
                  } else {
                    reloadBranches();
                  }
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
              background: shellSep,
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
                  {(branchesLoading || remoteLoading) && (
                    <span style={{ fontSize: 10.5, color: "var(--c-dim, #8a8a8a)" }}>Loading…</span>
                  )}
                </div>
                {/* ── Git draft: the REMOTE's branches (pre-clone pick) ── */}
                {inGitDraft && (
                  <>
                    {remoteError && (
                      <div style={{ padding: "8px 12px", fontSize: 11.5, color: "rgb(248,113,113)" }}>
                        {remoteError}
                      </div>
                    )}
                    {matchedRemoteOnly.map(b => (
                      <MenuRow
                        key={`clone-${b}`}
                        onClick={() => {
                          // A draft-field write only — the pick is honoured at
                          // commit (clone --branch, or the worktree checkout).
                          setDraftField({ pending_clone_branch: b });
                          setOpenMenu(null);
                        }}
                        primary={b}
                        right={b === (pendingCloneBranch ?? liveRemote?.def)
                          ? <Check size={11} style={{ color: "var(--c-fg, #ffffff)" }} />
                          : b === liveRemote?.def
                            ? <span style={{ fontSize: 10, color: "var(--c-dim, #8a8a8a)" }}>default</span>
                            : undefined}
                      />
                    ))}
                    {!remoteLoading && !remoteError && matchedRemoteOnly.length === 0 && (
                      <div style={{ padding: "10px 12px 14px", fontSize: 12, color: "var(--c-low, #b0b0b0)" }}>
                        {liveRemote ? `No branches match "${branchFilter}".` : "Loading branches…"}
                      </div>
                    )}
                  </>
                )}
                {!inGitDraft && matchedLocal.length > 0 && (
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
                {!inGitDraft && matchedRemote.length > 0 && (
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
                {!inGitDraft && !branchesLoading && matchedLocal.length === 0 && matchedRemote.length === 0 && (
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
        const disabled = !projectPath || tool !== "claude-code";
        // Resume target settled? Two display modes for the chip:
        //   • no claudeSessionId → "History" + count badge (picker)
        //   • claudeSessionId set → green dot + the picked summary
        //                            (active resume target)
        const resumed = cliHistory.find(r => r.session_id === claudeSessionId) ?? null;
        const isResumed = !!claudeSessionId;
        const disabledReason =
          !projectPath
            ? "Pick a folder first to see previous Claude conversations"
            : tool !== "claude-code"
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
            {openMenu === "history" && (() => {
              // Per-account counts + a stable colour key, computed once on
              // open so the filter chips don't re-flicker as the user types.
              const counts: Record<string, number> = {};
              for (const r of cliHistory) {
                const k = r.account_label || "System";
                counts[k] = (counts[k] || 0) + 1;
              }
              const accounts = Object.keys(counts).sort();
              const filtered = cliHistory.filter((r) => {
                const k = r.account_label || "System";
                if (historyAccountFilter && k !== historyAccountFilter) return false;
                if (historyQuery && !r.summary.toLowerCase().includes(historyQuery.toLowerCase())) return false;
                return true;
              });
              return (
              <Menu width={440}>
                {/* Title row */}
                <div style={{
                  padding: "8px 12px 6px",
                  fontSize: 10.5, fontWeight: 600,
                  letterSpacing: 0.3, textTransform: "uppercase",
                  color: "var(--c-dim)",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <span>Resume from Claude CLI</span>
                  {cliHistoryLoading && (
                    <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>Loading…</span>
                  )}
                </div>

                {/* Scope switch — "All projects" (default) vs "This folder".
                    Same logical bug bounty often spans multiple cwds (e.g.
                    `~/Desktop/projects/ct` for the canadiantire bounty and
                    `~/Desktop/projects/canadiantire` for follow-ups). A folder
                    scope hides one or the other; default-global keeps both
                    reachable. The folder option stays for users who DO want
                    to narrow down. */}
                <div style={{
                  display: "flex", gap: 0,
                  padding: "0 10px 6px",
                }}>
                  {([
                    { id: "all", label: "All projects" },
                    { id: "folder", label: "This folder" },
                  ] as const).map((opt, i) => {
                    const active = historyScope === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => setHistoryScope(opt.id)}
                        onMouseDown={e => e.preventDefault()}
                        style={{
                          flex: 1, height: 26, padding: "0 10px",
                          background: active ? "rgba(var(--fg-rgb),0.10)" : "rgba(var(--fg-rgb),0.03)",
                          border: "1px solid var(--c-brd)",
                          borderLeftWidth: i === 0 ? 1 : 0,
                          borderTopLeftRadius: i === 0 ? 6 : 0,
                          borderBottomLeftRadius: i === 0 ? 6 : 0,
                          borderTopRightRadius: i === 1 ? 6 : 0,
                          borderBottomRightRadius: i === 1 ? 6 : 0,
                          color: active ? "var(--c-high)" : "var(--c-low)",
                          fontSize: 11.5, fontWeight: 500, cursor: "pointer",
                          fontFamily: "inherit",
                          transition: "background 0.1s, color 0.1s",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {/* Account filter chips. "All" first, then each discovered
                    account with its row count. Active chip = filled tonal,
                    others ghost — same family as the rest of the toolbar. */}
                <div style={{ display: "flex", gap: 4, padding: "0 10px 6px", flexWrap: "wrap" }}>
                  {([null, ...accounts] as (string | null)[]).map((acc) => {
                    const active = historyAccountFilter === acc;
                    const dot = acc === null ? null : accountDotColor(acc);
                    const label = acc === null ? "All" : acc === "System" ? "Main" : acc.replace(/^\./, "");
                    const n = acc === null ? cliHistory.length : (counts[acc] || 0);
                    return (
                      <button
                        key={acc ?? "_all"}
                        onClick={() => setHistoryAccountFilter(acc)}
                        onMouseDown={e => e.preventDefault()}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 5,
                          height: 22, padding: "0 8px", borderRadius: 5,
                          background: active ? "rgba(var(--fg-rgb),0.10)" : "rgba(var(--fg-rgb),0.04)",
                          border: "1px solid var(--c-brd)",
                          color: active ? "var(--c-high)" : "var(--c-low)",
                          fontSize: 11, fontWeight: 500, cursor: "pointer",
                          fontFamily: "inherit",
                          transition: "background 0.1s, color 0.1s",
                        }}
                      >
                        {dot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: dot }}/>}
                        {label}
                        <span style={{ color: "var(--c-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{n}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Search box — quick free-text over the conversation
                    summary. Inline, no border, just a low-contrast pill. */}
                <div style={{ padding: "0 10px 6px" }}>
                  <input
                    placeholder="Search conversations…"
                    value={historyQuery}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    style={{
                      width: "100%", height: 26, padding: "0 9px",
                      background: "rgba(var(--fg-rgb),0.04)",
                      border: "1px solid var(--c-brd)", borderRadius: 5,
                      color: "var(--c-high)", fontSize: 11.5,
                      fontFamily: "inherit", outline: "none",
                    }}
                  />
                </div>

                {/* Conversation list. Each row carries a 2px coloured left rail
                    keyed to the account, the primary summary, and a meta line
                    with timestamp + folder badge. Selected row highlights. */}
                {filtered.length > 0 ? (
                  <div style={{ maxHeight: 360, overflowY: "auto", padding: "2px 6px 6px" }}>
                    {filtered.map(row => {
                      const selected = row.session_id === claudeSessionId;
                      const accKey = row.account_label || "System";
                      const accColor = accountDotColor(accKey);
                      const accDisplay = accKey === "System" ? "Main" : accKey.replace(/^\./, "");
                      const folder = row.project_path
                        ? row.project_path.split("/").filter(Boolean).pop()
                        : null;
                      return (
                        <button
                          key={row.session_id + "::" + accKey}
                          onClick={async () => {
                            setOpenMenu(null);
                            if (selected) return;
                            if (isDraft) {
                              setDraftField({ claude_session_id: row.session_id });
                            } else {
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
                          onMouseDown={e => e.preventDefault()}
                          style={{
                            position: "relative",
                            display: "flex", alignItems: "center", gap: 9,
                            width: "100%", textAlign: "left",
                            padding: "8px 10px 8px 14px",
                            background: selected ? "rgba(var(--fg-rgb),0.07)" : "transparent",
                            border: "none", outline: "none", cursor: "pointer",
                            borderRadius: 6,
                            fontFamily: "inherit",
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.04)"; }}
                          onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                        >
                          {/* 2px coloured rail on the left edge — instantly
                              keys the row to its account without needing to
                              read the badge. */}
                          <span aria-hidden style={{
                            position: "absolute", left: 5, top: 8, bottom: 8,
                            width: 2, borderRadius: 1, background: accColor,
                          }}/>
                          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                            <span style={{
                              fontSize: 12.5, color: "var(--c-high)", fontWeight: 500,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}>{row.summary || row.session_id.slice(0, 8)}</span>
                            <span style={{
                              display: "inline-flex", alignItems: "center", gap: 6,
                              fontSize: 10.5, color: "var(--c-dim)",
                              fontFamily: "var(--font-mono)",
                            }}>
                              <span>{formatRelative(row.updated_at)}</span>
                              <span style={{ opacity: 0.4 }}>·</span>
                              <span style={{
                                display: "inline-flex", alignItems: "center", gap: 4,
                                color: "var(--c-low)",
                              }}>
                                <span style={{ width: 4, height: 4, borderRadius: "50%", background: accColor }}/>
                                {accDisplay}
                              </span>
                              {folder && (
                                <>
                                  <span style={{ opacity: 0.4 }}>·</span>
                                  <span style={{
                                    color: "var(--c-low)",
                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180,
                                  }} title={row.project_path}>{folder}</span>
                                </>
                              )}
                            </span>
                          </span>
                          {selected && (
                            <Check size={12} strokeWidth={2.4} style={{ color: "var(--c-high)", flexShrink: 0 }}/>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : !cliHistoryLoading ? (
                  <div style={{
                    padding: "12px 14px 16px",
                    fontSize: 12, color: "var(--c-low)",
                    lineHeight: 1.5, textAlign: "center",
                  }}>
                    {historyAccountFilter || historyQuery
                      ? "No conversations match this filter."
                      : "No previous Claude conversations found."}
                  </div>
                ) : null}
              </Menu>
              );
            })()}
          </Chip>
        );
      })()}

      {/* ── Session rules — per-session instructions written into the
            session's working-dir rule file. Only for a committed session;
            a draft has no row or working dir to materialize into yet. ── */}
      {!isDraft && <SessionRulesChip sessionId={sessionId} />}

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
/** Running-in-container chip.
 *
 *  Two jobs the toolbar had no way to do before: say out loud that this
 *  session executes somewhere other than this machine, and show when that
 *  somewhere has stopped. Previously a dead container was discovered at the
 *  next turn's re-probe — i.e. the user found out by the turn failing.
 *
 *  Liveness is polled off `docker ps` (the container list the picker already
 *  uses) rather than a dedicated endpoint, so a stopped container drops out
 *  of the list and the chip goes dead without any new backend surface. */
/** Container chip — status only.
 *
 *  Rendered only while the session executes in a container. The
 *  configuration surface moved into the source picker's Container tab, so
 *  this chip's whole job is the two things the tab cannot do from a closed
 *  popover: say at a glance that this session is NOT running on this
 *  machine, and show when its container has died — polled off `docker ps`,
 *  because discovering a dead container at the next turn's re-probe means
 *  discovering it by the turn failing. Clicking jumps to the tab. */
function ContainerChip({
  containerId, containerImage, mode, mountsCredentials, onOpenPicker,
}: {
  containerId: string | null;
  /** Fallback label while a docker-run session has no container yet —
   *  provisioning waits for the first turn, so the id can be legitimately
   *  absent while the intent is already set. */
  containerImage: string | null;
  mode: "docker-attach" | "docker-run";
  mountsCredentials: boolean;
  onOpenPicker: () => void;
}) {
  // The probe answer carries the id it belongs to, so switching containers
  // does not need a synchronous reset inside the effect (which triggers a
  // cascading render) — a mismatched id simply reads as "not answered yet".
  const [probe, setProbe] = useState<{ id: string; alive: boolean; name: string | null } | null>(null);
  const answer = probe && probe.id === containerId ? probe : null;

  useEffect(() => {
    if (!containerId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const { containers } = await dockerContainers();
        if (cancelled) return;
        // `docker ps` reports short ids; a session may hold either the short
        // id or a name, so match on both ends rather than requiring equality.
        const hit = containers.find(
          c =>
            c.id === containerId ||
            c.name === containerId ||
            containerId.startsWith(c.id) ||
            c.id.startsWith(containerId),
        );
        setProbe({ id: containerId, alive: !!hit, name: hit?.name ?? null });
      } catch {
        // Daemon unreachable is not literally "container stopped", but from
        // the session's point of view the effect is identical: the next turn
        // cannot run. Show it as dead rather than pretending.
        if (!cancelled) setProbe({ id: containerId, alive: false, name: null });
      }
    };
    void check();
    const t = setInterval(check, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [containerId]);

  const alive = answer?.alive ?? null;
  const label =
    answer?.name ??
    containerId?.slice(0, 12) ??
    containerImage ??
    "container";
  // No id yet = provisioning is deferred to the first turn; that is a
  // pending state, not a dead one.
  const state = !containerId ? "pending" : alive === null ? "unknown" : alive ? "live" : "dead";
  const dot =
    state === "live" ? "var(--c-low, #4a9)"
    : state === "dead" ? "var(--c-err, #d66)"
    : "rgba(var(--fg-rgb),0.35)";
  const title =
    state === "pending"
      ? "Starts when you send the first message. Click to change the container setup."
    : state === "dead"
      ? `Container '${label}' isn't running — start it, or switch back to this machine.`
    : mode === "docker-run"
      ? "Running in a container Fleetify started. Click to change the setup."
      : `Running inside your container '${label}'. Fleetify never stops it.`;

  return (
    <Chip
      onClick={onOpenPicker}
      title={mountsCredentials ? `${title} Your credentials are mounted into it.` : title}
    >
      <span
        data-testid="container-chip"
        data-state={state}
        data-mode={mode}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Box size={13} strokeWidth={1.75} style={{ opacity: 0.9 }} />
        <span
          aria-hidden
          style={{
            width: 6, height: 6, borderRadius: "50%", background: dot,
            // A dead container is the one state worth interrupting for.
            boxShadow: state === "dead"
              ? `0 0 0 3px color-mix(in srgb, ${dot} 22%, transparent)`
              : "none",
          }}
        />
        <span style={{ maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
      </span>
    </Chip>
  );
}

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
  // Ghost-minimal, matching the chat composer's toolbar buttons: no
  // resting border or fill, a faint wash on hover, a slightly stronger
  // one while the menu is open. Fully monochrome — borders stay
  // transparent so the layout never shifts between states.
  const baseBg     = "transparent";
  const hoverBg    = "rgba(var(--fg-rgb),0.06)";
  const activeBg   = "rgba(var(--fg-rgb),0.10)";
  const baseBorder = "transparent";
  const hotBorder  = "transparent";

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

/** Per-account rail/dot tone in the resume picker. Monochrome by design —
 *  the app's whole design language is neutral, so account identity is carried
 *  by the text label, never a hue. We still vary the grey brightness slightly
 *  so sibling accounts aren't pixel-identical, but no colour ever enters the
 *  picker. Theme-aware via --fg-rgb (white-ish in dark, near-black in light).
 *  Ordering is by account label, so a freshly-added account inherits the next
 *  free slot without disturbing the others. */
function accountDotColor(label: string): string {
  if (label === "System") return "rgba(var(--fg-rgb),0.55)";
  const TONES = [
    "rgba(var(--fg-rgb),0.46)",
    "rgba(var(--fg-rgb),0.36)",
    "rgba(var(--fg-rgb),0.50)",
    "rgba(var(--fg-rgb),0.40)",
    "rgba(var(--fg-rgb),0.32)",
  ];
  const m = /(\d+)/.exec(label);
  const idx = m ? Math.max(0, parseInt(m[1] ?? "2", 10) - 2) : 0;
  return TONES[idx % TONES.length] ?? TONES[0]!;
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
      // The menu renders INSIDE the Chip's <button>, and buttons default to
      // `text-align: center` — which every descendant inherits. That is why
      // popover rows each had to re-declare `textAlign: "left"`, and why any
      // row that forgot came out centred. Reset it once, here.
      textAlign: "left",
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
  secondary?: React.ReactNode;
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
        borderRadius: 6,
        color: "var(--c-fg, #dcdcdc)",
        fontFamily: "var(--font-sans)",
        transition: "background 0.1s",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.06)"; }}
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
