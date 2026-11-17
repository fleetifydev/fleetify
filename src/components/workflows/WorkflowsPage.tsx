/**
 * Routines — templated tasks that fire on a schedule (or, later, by API
 * / webhook). A routine carries everything the runtime needs to spin up
 * the right session: provider, model, project folder, permission mode,
 * worktree preference, and an optional built-in agent template. Or it
 * can resume an existing session and post the instructions as a new
 * turn instead.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ← Back to Routines                                              │
 *   │ New local routine                                               │
 *   │ Pick what it should do and when it should run.                  │
 *   │                                                                 │
 *   │ [shield] Local routines only run while your computer is awake.  │
 *   │                                                                 │
 *   │ —— Identity ———————————————————————————————————————————          │
 *   │ Name *               Description *                              │
 *   │                                                                 │
 *   │ —— Instructions ——————————————————————————————————————————       │
 *   │ [textarea]                                                      │
 *   │                                                                 │
 *   │ —— Target —————————————————————————————————————————————          │
 *   │ [New session | Resume session]                                  │
 *   │                                                                 │
 *   │ (new) Folder · Provider tabs · Model · Permissions · Worktree   │
 *   │       Quick agent grid (optional)                               │
 *   │ (res) Session picker                                            │
 *   │                                                                 │
 *   │ —— Schedule ——————————————————————————————————————————————       │
 *   │ [Manual · Hourly · Daily · Weekdays · Weekly]   At [09:00]      │
 *   │                                                                 │
 *   │                                              [Cancel] [Create]  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Persisted to localStorage under `fleet:routines:v2` (v1 was the
 * minimal shape — bumped to make room for the full session config).
 * The cron / webhook runtime that actually executes routines is the
 * follow-up; today the form just lets users author + inspect them.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Zap, ShieldCheck, PanelLeft, Clock, ArrowLeft, ChevronDown, ChevronRight,
  Plus, Trash2, Check, CheckCircle2, AlertCircle, Loader2, FolderOpen, Search, X,
  Filter, Play, MoreHorizontal, ArrowRight,
  Sparkles, Undo2, Info, Wand2, Pencil, Square,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { usesInAppTitleBar, folderName } from "@/lib/utils";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { wsManager } from "@/services/ws-manager";
import {
  loadRoutines, saveRoutines, loadRuns,
  runNow as runtimeRunNow,
  stopRun as runtimeStopRun,
  deleteRun as runtimeDeleteRun,
  updateRoutine as runtimeUpdateRoutine,
  setRoutineEnabled as runtimeSetEnabled,
  isEnabled,
  unmarkSpawned,
  subscribe as subscribeRuns,
  lastRunFor, lastNRuns, successRate as computeSuccess, nextFireAt,
  type Routine, type RoutineRun,
  type Schedule, type Provider, type PermissionMode, type Target,
} from "@/services/routines-runtime";
import { useChatStore } from "@/stores/chat-store";
import { usePinnedSession } from "@/lib/session-pins";
import { parseStoredMessages } from "@/lib/session-messages";
import { apiFetch, fetchMessages } from "@/lib/api";
import { MarkdownBody, rowSummary } from "@/components/chat/message-content";
import type { Session } from "@/types/session";
import type { ChatMessage } from "@/types/chat";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { buildPickerGroups, resolveModelChip, resolveDispatchTool } from "@/lib/picker-groups";
import { useDiscoveredModelsStore } from "@/stores/discovered-models-store";
import { effortLabel } from "@/lib/effort";
import { UnifiedModelPicker, type Effort } from "@/components/chat/unified-model-picker";
import { permissionCapabilityFor, permissionModesFor, isLoudMode } from "@/lib/capabilities";
import type { PermMode } from "@/lib/providers-api";

/* ── Provider / model catalogue ───────────────────────────────────────
   Kept in sync with new-agent-dialog.tsx by hand. If you change models
   here, change them there too — both surfaces should agree on what's
   selectable. Default model per provider is marked. */
interface CatalogProvider {
  id: Provider;
  name: string;
  models: { id: string; label: string; desc: string; default?: boolean }[];
}

/** Provider/model catalogue for routines — built from the SAME source as the
 *  Fleet chat picker (`buildPickerGroups` over the connected provider tiles),
 *  so Routines exposes every activated provider + its models (including live
 *  model lists for OpenCode / Cursor / OpenRouter) rather than a fixed trio.
 *  The "Auto" pseudo-provider is excluded — a routine pins a real provider. */
function useProviderCatalog(): CatalogProvider[] {
  const { tiles } = useProvidersConfig();
  return useMemo(() => {
    const cliIds = tiles
      .filter((t) => t.spec.kind === "cli" && t.connected)
      .map((t) => t.spec.id);
    return buildPickerGroups(tiles, cliIds)
      .filter((g) => g.id !== "auto" && g.models.length > 0)
      .map((g) => ({
        id: g.id,
        name: g.label,
        models: g.models.map((m, i) => ({
          id: m.id,
          label: m.label,
          desc: m.ctx ?? "",
          default: i === 0,
        })),
      }));
  }, [tiles]);
}

/** Raw picker groups (Providers | Models | Effort) for the UnifiedModelPicker —
 *  the exact same source + shape the Fleet chat composer consumes, so the
 *  routine form's model menu can never drift from chat's. Includes the "auto"
 *  group (Fleet-routed) which `useProviderCatalog` strips for the table label. */
function useProviderGroups() {
  const { tiles } = useProvidersConfig();
  // Discovered remote-catalog models (app-wide store) — without them the
  // routine chip/menu can't resolve display names for models the static
  // tables don't know (raw "claude-fable-5" instead of "Fable 5").
  const discovered = useDiscoveredModelsStore((s) => s.models);
  useEffect(() => {
    void useDiscoveredModelsStore.getState().hydrate(tiles);
  }, [tiles]);
  return useMemo(() => {
    const cliIds = tiles
      .filter((t) => t.spec.kind === "cli" && t.connected)
      .map((t) => t.spec.id);
    return buildPickerGroups(tiles, cliIds, Object.keys(discovered).length > 0 ? discovered : undefined);
  }, [tiles, discovered]);
}

/** Look up the display label for a permission mode from the resolved
 *  native modes for the given provider. Falls back to the raw id when
 *  the mode is not in the list (legacy stored value). */
function permLabel(id: PermissionMode, modes: PermMode[]): string {
  return modes.find((m) => m.id === id)?.label ?? id;
}

/* ── Built-in agent templates ─────────────────────────────────────────
   Mirrors new-agent-dialog's AGENT_TEMPLATES grid (id stays stable so
   the backend resolution works the same). We keep just the metadata
   we need to render the picker; the rest (system prompt, MCP wiring)
   lives server-side keyed by `agentTemplate`. */
const AGENT_TEMPLATES: { id: string; icon: string; name: string; description: string }[] = [
  { id: "reverse-engineer", icon: "🔬", name: "Reverse Engineer", description: "Endpoint discovery, JS bundle analysis" },
  { id: "scraper",          icon: "🕷️", name: "Web Scraper",      description: "Scrapes sites, extracts data" },
  { id: "code-review",      icon: "🔍", name: "Code Reviewer",    description: "Bugs, style, security" },
  { id: "research",         icon: "📚", name: "Researcher",       description: "Deep research, reports" },
  { id: "qa",               icon: "✅", name: "QA Engineer",      description: "Tests, edge cases" },
  { id: "devops",           icon: "⚙️", name: "DevOps Agent",     description: "CI/CD, deployments" },
  { id: "data-analyst",     icon: "📊", name: "Data Analyst",     description: "Datasets, insights" },
  { id: "writer",           icon: "✍️", name: "Technical Writer", description: "Docs, READMEs, refs" },
];

interface Template {
  emoji: string;
  name: string;
  description: string;
  scheduleLabel: string;
  works?: string;
  trigger?: string;
  defaults: { schedule: Schedule; scheduleTime: string; instructions: string };
}

const TEMPLATES: Template[] = [
  { emoji: "☀️", name: "Briefing",
    description: "Summary of your calendar, emails, and messages.",
    scheduleLabel: "Runs weekdays at 3:30 PM GMT+3",
    works: "Google Calendar · Gmail · Slack",
    defaults: { schedule: "weekdays", scheduleTime: "15:30",
      instructions: "Give me a concise morning briefing: today's calendar, the highest-priority unread emails, and any unread messages that mention me. Highlight conflicts or things needing a reply." } },
  { emoji: "📨", name: "Email triage",
    description: "Categorize and prioritize your inbox, with draft responses for urgent items.",
    scheduleLabel: "Runs weekdays at 6:00 PM GMT+3",
    works: "Gmail",
    defaults: { schedule: "weekdays", scheduleTime: "18:00",
      instructions: "Triage today's inbox. Group by urgency, flag anything that needs a response within 24h, and draft replies to the urgent ones." } },
  { emoji: "🩺", name: "System health check",
    description: "Monitor infrastructure and services for errors, outages, and performance issues.",
    scheduleLabel: "Runs daily at 3:00 PM GMT+3",
    works: "PagerDuty · Datadog · Sentry",
    defaults: { schedule: "daily", scheduleTime: "15:00",
      instructions: "Check the last 24h of alerts, error spikes, and latency anomalies. Summarize anything ongoing and list incidents from the last week with status." } },
  { emoji: "🎫", name: "Issue triage",
    description: "Review and categorize incoming issues, bugs, and feature requests.",
    scheduleLabel: "Runs weekdays at 6:30 PM GMT+3",
    works: "Linear",
    defaults: { schedule: "weekdays", scheduleTime: "18:30",
      instructions: "Review all new tickets from the last 24h. Suggest labels and priorities, flag anything that looks like a duplicate, and call out items missing repro steps." } },
  { emoji: "🔎", name: "PR review digest",
    description: "Overview of open PRs, review status, and what needs attention.",
    scheduleLabel: "Runs weekdays at 9:00 PM GMT+3",
    defaults: { schedule: "weekdays", scheduleTime: "21:00",
      instructions: "List open PRs in the repo. Group by status (needs review, changes requested, stale). Highlight any that have been waiting more than 48h." } },
  { emoji: "📦", name: "Dependency update check",
    description: "Scan for outdated packages, security patches, and breaking changes.",
    scheduleLabel: "Runs every Monday at 9:30 PM GMT+3",
    defaults: { schedule: "weekly", scheduleTime: "21:30",
      instructions: "Scan the project's dependency manifests. Report outdated packages, separate security/critical fixes from regular bumps, and note any breaking changes in major version jumps." } },
  { emoji: "📝", name: "Release notes drafter",
    description: "Draft user-facing release notes each time a PR merges to the main branch.",
    scheduleLabel: "",
    trigger: "Triggered by pull request closed",
    defaults: { schedule: "manual", scheduleTime: "09:00",
      instructions: "Draft user-facing release notes for the merged PR. Focus on what changed for users, not implementation detail. One concise paragraph per material change." } },
  { emoji: "🎲", name: "Flaky test tracker",
    description: "Find tests that pass and fail intermittently across recent CI runs.",
    scheduleLabel: "Runs every Monday at 7:00 PM GMT+3",
    defaults: { schedule: "weekly", scheduleTime: "19:00",
      instructions: "Look at CI runs from the last 7 days. Find tests that have flipped pass↔fail at least twice on the same commit. List them with failure rate and last failure timestamp." } },
];

/* Storage + runtime live in `services/routines-runtime.ts` — see
   loadRoutines / saveRoutines / loadRuns / subscribe / runNow up in
   the imports. Keeping the runtime free of UI state means a background
   tick fires the schedule even when this surface isn't mounted. */

/** Subscribe to the shared run log; re-renders the caller whenever a
 *  run is appended / updated by the runtime. */
function useRuns(): RoutineRun[] {
  const [runs, setRuns] = useState<RoutineRun[]>(() => loadRuns());
  useEffect(() => subscribeRuns(() => setRuns(loadRuns())), []);
  return runs;
}

/** An agent preset surfaced in Routines → Templates (from
 *  /api/runtime/templates): builtin / plugin / library agent templates.
 *  Picking one seeds a new routine whose `agentTemplate` is the preset name. */
interface AgentPreset {
  name: string;
  title: string;
  description: string;
  providers: string[];
  preferred_tier: string;
  permission_mode: string;
}

type View =
  | { kind: "list" }
  | { kind: "new"; template?: Template; agentPreset?: AgentPreset }
  | { kind: "edit"; routine: Routine }
  | { kind: "detail"; id: string }
  | { kind: "run"; routineId: string; runId: string };

export function WorkflowsPage() {
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  const [routines, setRoutines] = useState<Routine[]>(() => loadRoutines());
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => { saveRoutines(routines); }, [routines]);

  const onCreate = (r: Routine) => {
    const next = [r, ...routines];
    setRoutines(next);
    // Persist synchronously so the runtime can find this routine on
    // the very next tick (the routines→storage useEffect would race
    // behind a setTimeout(runNow) otherwise).
    saveRoutines(next);
    setView({ kind: "list" });
    // Fire the first run immediately when the routine has a real
    // schedule. Manual routines wait for an explicit Run-now click.
    // Pass the routine object so we don't depend on storage lookup.
    if (r.schedule !== "manual") runtimeRunNow(r);
  };

  const onDelete = (id: string) => {
    // Stop any in-flight run + unmark spawned sessions before nuking
    // the routine so we don't leave orphan inflight markers or hide
    // sessions in the sidebar that no longer have a routine owner.
    const routine = routines.find(r => r.id === id);
    const routineRuns = loadRuns().filter(r => r.routineId === id);
    const live = routineRuns.find(r => r.status === "running");
    if (live) runtimeStopRun(live.id);
    if (routine?.target === "new") {
      for (const r of routineRuns) {
        if (r.sessionId) unmarkSpawned(r.sessionId);
      }
    }
    setRoutines(prev => prev.filter(r => r.id !== id));
    if (view.kind === "detail" && view.id === id) setView({ kind: "list" });
  };

  const onUpdate = (r: Routine) => {
    // updateRoutine may clear rollingSessionId when semantic fields
    // change — use whatever it returns so React state matches storage.
    const saved = runtimeUpdateRoutine(r);
    setRoutines(prev => prev.map(x => (x.id === saved.id ? saved : x)));
    setView({ kind: "detail", id: saved.id });
  };

  // ── Confirm dialog state ──
  // Single page-level dialog so we don't reach for window.confirm
  // (native OS modal blew up the theme). Row + detail both route
  // delete intents through `requestDelete`.
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message?: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void;
  }>(null);

  const requestDelete = (routine: Routine) => {
    setConfirm({
      title: `Delete "${routine.name}"?`,
      message: "Its run history will also be removed. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => {
        onDelete(routine.id);
        setConfirm(null);
      },
    });
  };

  const detailRoutine = view.kind === "detail" ? routines.find(r => r.id === view.id) ?? null : null;

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", height: "100%",
      background: "var(--card)",
      color: "var(--c-high)",
      overflow: "hidden",
      animation: "rt-fade-up 0.26s cubic-bezier(0.22, 1, 0.36, 1) both",
    }}>
      <style>{`
        @keyframes rt-fade-up {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <TopBar sidebarCollapsed={sidebarCollapsed} toggleSidebar={toggleSidebar} />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "4px 32px 56px" }}>
          {view.kind === "list" && (
            <ListView
              routines={routines}
              onNew={() => setView({ kind: "new" })}
              onTemplate={t => setView({ kind: "new", template: t })}
              onAgentPreset={p => setView({ kind: "new", agentPreset: p })}
              onOpen={id => setView({ kind: "detail", id })}
              onOpenRun={(routineId, runId) => setView({ kind: "run", routineId, runId })}
              onEdit={r => setView({ kind: "edit", routine: r })}
              onRequestDelete={requestDelete}
            />
          )}
          {view.kind === "new" && (
            <NewRoutineForm
              template={view.template}
              agentPreset={view.agentPreset}
              onCancel={() => setView({ kind: "list" })}
              onSubmit={onCreate}
              mode="create"
            />
          )}
          {view.kind === "edit" && (
            <NewRoutineForm
              existing={view.routine}
              onCancel={() => setView({ kind: "detail", id: view.routine.id })}
              onSubmit={onUpdate}
              mode="edit"
            />
          )}
          {view.kind === "detail" && detailRoutine && (
            <RoutineDetail
              routine={detailRoutine}
              onBack={() => setView({ kind: "list" })}
              onRequestDelete={() => requestDelete(detailRoutine)}
              onEdit={() => setView({ kind: "edit", routine: detailRoutine })}
              onOpenRun={runId => setView({ kind: "run", routineId: detailRoutine.id, runId })}
            />
          )}
          {view.kind === "detail" && !detailRoutine && (
            <div style={{ padding: 32, color: "var(--c-dim)" }}>Routine not found.</div>
          )}
          {view.kind === "run" && (
            <RunDetailView
              routineId={view.routineId}
              runId={view.runId}
              onBack={() => setView({ kind: "detail", id: view.routineId })}
            />
          )}
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          destructive={confirm.destructive}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/* ConfirmDialog moved to src/components/ui/confirm-dialog.tsx — shared
   across the sidebar session delete and routine delete surfaces. */

/* ── Top bar ─────────────────────────────────────────────────────── */

function TopBar({ sidebarCollapsed, toggleSidebar }: { sidebarCollapsed: boolean; toggleSidebar: () => void }) {
  // Windows owns the sidebar toggle in its dedicated title bar above
  // the shell, so the page-level toggle (and its 84px traffic-light
  // inset) is suppressed there. macOS keeps it for traffic-light alignment.
  const inAppBar = usesInAppTitleBar();
  return (
    <div className="drag-region" style={{
      height: 44, flexShrink: 0,
      display: "flex", alignItems: "center",
      padding: "0 16px",
      background: "var(--card)",
      zIndex: 2,
    }}>
      {!inAppBar && sidebarCollapsed && (
        <div className="no-drag" style={{ display: "flex", alignItems: "center", paddingLeft: 84 }}>
          <button
            onClick={toggleSidebar}
            title="Show sidebar"
            style={{
              width: 22, height: 22, borderRadius: 5,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--c-dim)",
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }}
          >
            <PanelLeft size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── List view ───────────────────────────────────────────────────── */

/* ── List view (dense table layout) ───────────────────────────────────
   Linear-style table: ROUTINE / SCHEDULE / LAST 14 RUNS / SUCCESS /
   NEXT RUN. Templates live behind a separate tab so the surface
   doesn't dump them all under the active routines. */
type ListTab = "active" | "all" | "templates" | "logs";

function ListView({ routines, onNew, onTemplate, onAgentPreset, onOpen, onOpenRun, onEdit, onRequestDelete }: {
  routines: Routine[];
  onNew: () => void;
  onTemplate: (t: Template) => void;
  onAgentPreset: (p: AgentPreset) => void;
  onOpen: (id: string) => void;
  onOpenRun: (routineId: string, runId: string) => void;
  onEdit: (routine: Routine) => void;
  onRequestDelete: (routine: Routine) => void;
}) {
  const [tab, setTab] = useState<ListTab>("active");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const filteredRoutines = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return routines;
    return routines.filter(r =>
      r.name.toLowerCase().includes(q)
      || r.description.toLowerCase().includes(q),
    );
  }, [routines, query]);

  const activeCount = routines.length;
  // Without a real run history we can't compute "needs attention" yet;
  // the slot stays in the header but reads 0 until the runtime ships.
  const attentionCount = 0;

  return (
    <>
      {/* ── Header — title + inline counts on the left, action pills on the right. */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 16, marginBottom: 14,
      }}>
        <div style={{
          display: "flex", alignItems: "baseline", gap: 10,
          minWidth: 0,
        }}>
          <h1 style={{
            margin: 0, padding: 0,
            fontSize: 22, fontWeight: 600,
            color: "var(--c-high)",
            letterSpacing: "-0.01em",
            lineHeight: 1.1,
          }}>
            Routines
          </h1>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 8,
            fontSize: 11.5, color: "var(--c-dim)",
            fontVariantNumeric: "tabular-nums",
          }}>
            <Dot />
            <span>{activeCount} active</span>
            {attentionCount > 0 && (
              <>
                <Dot />
                <span style={{ color: "#fb923c" }}>{attentionCount} needs attention</span>
              </>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <HeaderPill icon={<Search size={11} />} label="Search"
            onClick={() => setSearchOpen(v => !v)}
            active={searchOpen} />
          <HeaderPill icon={<Filter size={11} />} label="Filter" onClick={() => {}} />
          <HeaderPill icon={<Plus size={11} strokeWidth={2.2} />} label="New routine" onClick={onNew} primary />
        </div>
      </header>

      {searchOpen && (
        <div style={{
          marginBottom: 10,
          display: "flex", alignItems: "center", gap: 7,
          padding: "5px 10px",
          borderRadius: 8,
          background: "var(--c-srf)",
          border: "1px solid var(--c-brd)",
        }}>
          <Search size={12} style={{ color: "var(--c-ghost)", flexShrink: 0 }} />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search routines…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none", outline: "none",
              color: "var(--foreground)",
              fontSize: 12.5, fontFamily: "inherit",
            }}
          />
          {query && (
            <button onClick={() => setQuery("")} style={{
              background: "none", border: "none", padding: 0,
              color: "var(--c-ghost)", cursor: "pointer", display: "flex",
            }}>
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{ marginBottom: 14 }}>
        <TabBar value={tab} onChange={setTab} templateCount={TEMPLATES.length} />
      </div>

      {/* ── Tab content ── */}
      {tab === "templates" ? (
        <TemplatesPanel onPick={onTemplate} onAgentPreset={onAgentPreset} />
      ) : tab === "logs" ? (
        <LogsPanel routines={routines} onOpenRun={onOpenRun} />
      ) : tab === "all" ? (
        <AllRunsPanel routines={routines} onOpenRun={onOpenRun} />
      ) : filteredRoutines.length === 0 ? (
        <RoutinesEmpty onNew={onNew} onTemplates={() => setTab("templates")} hasQuery={!!query} />
      ) : (
        <RoutinesTable
          routines={filteredRoutines}
          onOpen={onOpen}
          onEdit={onEdit}
          onRequestDelete={onRequestDelete}
        />
      )}

      {/* ── Footer hint — always visible, encourages template discovery. */}
      <div style={{
        marginTop: 26,
        paddingTop: 14,
        borderTop: "1px solid var(--sidebar-border)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12,
        fontSize: 11.5, color: "var(--c-dim)",
      }}>
        <span>
          Need a starting point? Browse{" "}
          <button
            onClick={() => setTab("templates")}
            style={inlineLinkStyle}
          >{TEMPLATES.length} templates</button>
          {" "}— or create from scratch.
        </span>
        <button
          onClick={() => setTab("templates")}
          style={inlineLinkStyle}
        >
          Start from a template <ArrowRight size={10} />
        </button>
      </div>
    </>
  );
}

/* ── Header pill (Search / Filter / New routine) ─────────────────── */

function HeaderPill({ icon, label, onClick, active, primary }: {
  icon: React.ReactNode; label: string;
  onClick: () => void;
  active?: boolean; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "5px 10px",
        background: primary
          ? "var(--c-srf2)"
          : active ? "var(--c-srf2)" : "transparent",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 7,
        color: active || primary ? "var(--c-high)" : "var(--c-med)",
        fontSize: 11.5, fontWeight: 500,
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "background 0.08s, color 0.08s, border-color 0.08s",
      }}
      onMouseEnter={e => {
        if (active || primary) return;
        (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
        (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
      }}
      onMouseLeave={e => {
        if (active || primary) return;
        (e.currentTarget as HTMLElement).style.background = "transparent";
        (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
      }}
    >
      {icon} {label}
    </button>
  );
}

/* ── Tab bar ─────────────────────────────────────────────────────── */

function TabBar({ value, onChange, templateCount }: {
  value: ListTab; onChange: (t: ListTab) => void; templateCount: number;
}) {
  const tabs: { id: ListTab; label: string; count?: number }[] = [
    { id: "active",    label: "Active" },
    { id: "all",       label: "All runs" },
    { id: "templates", label: "Templates", count: templateCount },
    { id: "logs",      label: "Logs" },
  ];
  return (
    <div style={{
      display: "inline-flex",
      padding: 2, gap: 1,
      background: "var(--sidebar)",
      border: "1px solid var(--sidebar-border)",
      borderRadius: 7,
    }}>
      {tabs.map(t => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "5px 11px",
              background: active ? "var(--c-srf2)" : "transparent",
              color: active ? "var(--c-high)" : "var(--c-low)",
              border: "none", borderRadius: 5,
              cursor: "pointer",
              fontSize: 11.5, fontFamily: "inherit",
              fontWeight: active ? 500 : 400,
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.color = "var(--c-low)"; }}
          >
            {t.label}
            {t.count != null && (
              <span style={{
                fontSize: 10, color: active ? "var(--c-dim)" : "var(--c-ghost)",
                fontFamily: "var(--font-mono)", lineHeight: 1,
              }}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Routines list ───────────────────────────────────────────────────
   Each routine renders as its own card using the app's standard card
   recipe (--sidebar bg + --sidebar-border + r8, hover lifts to --c-srf
   + --c-brd). Cards carry rich detail — name, project/model/target,
   description preview, chips for the runtime config (target, perms,
   worktree, agent template), and a stats strip across the bottom
   with two-line cells so each metric anchors visually even when run
   data is empty. */

function RoutinesTable({ routines, onOpen, onEdit, onRequestDelete }: {
  routines: Routine[];
  onOpen: (id: string) => void;
  onEdit: (r: Routine) => void;
  onRequestDelete: (r: Routine) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {routines.map(r => (
        <RoutineTableRow
          key={r.id}
          routine={r}
          onOpen={() => onOpen(r.id)}
          onEdit={() => onEdit(r)}
          onRequestDelete={() => onRequestDelete(r)}
        />
      ))}
    </div>
  );
}

function RoutineTableRow({ routine, onOpen, onEdit, onRequestDelete }: {
  routine: Routine;
  onOpen: () => void;
  onEdit: () => void;
  onRequestDelete: () => void;
}) {
  const sessions = useAppStore(s => s.sessions);
  const runs = useRuns();
  const [hover, setHover] = useState(false);
  const { tiles: providerTiles } = useProvidersConfig();
  const PROVIDERS = useProviderCatalog();

  const resumeSession = routine.target === "resume"
    ? sessions.find(x => x.id === routine.resumeSessionId)
    : null;
  const displayTool = resumeSession?.tool ?? routine.provider;
  const routinePerms = permissionModesFor(permissionCapabilityFor(providerTiles, routine.provider));

  const project = routine.target === "resume"
    ? folderName(resumeSession?.project_path ?? "")
    : folderName(routine.projectPath);
  const prov = PROVIDERS.find(p => p.id === routine.provider);
  const model = prov?.models.find(m => m.id === routine.modelId);
  const agentTpl = routine.agentTemplate ? AGENT_TEMPLATES.find(t => t.id === routine.agentTemplate) : null;

  // Live stats — pull the 14 most recent runs for this routine and
  // compute the sparkline + success column from real data.
  const last14 = useMemo(() => lastNRuns(routine.id, 14, runs), [routine.id, runs]);
  const success = useMemo(() => computeSuccess(routine.id, 14, runs), [routine.id, runs]);
  const completedCount = last14.filter(r => r.status !== "running").length;
  const inflightRun = useMemo(() => last14.find(r => r.status === "running") ?? null, [last14]);

  // Meta is now the secondary line — model is the headline detail, then
  // project and resume target for context. No more redundant dot list.
  const trailingMeta: string[] = [];
  if (project) trailingMeta.push(project);
  if (routine.target === "resume" && resumeSession) trailingMeta.push(`resumes ${resumeSession.title}`);

  const previewSrc = routine.description || routine.instructions;
  const preview = previewSrc ? previewSrc.replace(/\s+/g, " ").trim() : "";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? "var(--c-srf)" : "var(--sidebar)",
        border: "1px solid",
        borderColor: hover ? "var(--c-brd)" : "var(--sidebar-border)",
        borderRadius: 10,
        cursor: "pointer",
        transition: "background 0.10s, border-color 0.10s, opacity 0.10s",
        overflow: "hidden",
        // Paused routines fade back so the user can scan the list and
        // immediately see which schedules are off.
        opacity: isEnabled(routine) ? 1 : 0.55,
      }}
    >
      {/* ── Top section — identity + actions. No status dot — the row
          itself is the surface; a colored circle next to a model name
          read as terminal/hacker chrome. Provider logo is smaller now
          and pairs with the model label as a single unit, so the row
          announces both "what runs this" and "with which model" in
          one glance. */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 12,
        padding: "12px 14px 10px",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: "var(--c-high)",
            letterSpacing: "-0.005em",
            lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{routine.name}</div>

          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            marginTop: 4,
            minWidth: 0,
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "1px 7px 1px 4px",
              background: "var(--c-srf2)",
              borderRadius: 4,
              flexShrink: 0,
            }}>
              <ProviderLogo tool={displayTool} size={11} />
              <span style={{
                fontSize: 11, fontWeight: 500, color: "var(--c-high)",
                letterSpacing: 0,
              }}>{model?.label ?? routine.modelId}</span>
            </span>
            {trailingMeta.length > 0 && (
              <span style={{
                fontSize: 10.5, color: "var(--c-ghost)",
                fontFamily: "var(--font-mono)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                minWidth: 0,
              }}>{trailingMeta.join(" · ")}</span>
            )}
          </div>

          {preview && (
            <div style={{
              fontSize: 11.5, color: "var(--c-dim)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              lineHeight: 1.4, marginTop: 7,
            }}>{preview}</div>
          )}
          <div style={{
            display: "flex", flexWrap: "wrap", gap: 4,
            marginTop: 8,
          }}>
            {inflightRun && <RunningChip />}
            {!isEnabled(routine) && <Chip tone="orange">Paused</Chip>}
            <Chip tone={routine.target === "resume" ? "purple" : "blue"}>
              {routine.target === "resume" ? "Resume session" : "New session"}
            </Chip>
            <Chip tone={permTone(routine.permissionMode)}>{permLabel(routine.permissionMode, routinePerms)}</Chip>
            {routine.target === "new" && routine.useWorktree && <Chip>Worktree</Chip>}
            {agentTpl && <Chip>{agentTpl.icon} {agentTpl.name}</Chip>}
          </div>
        </div>

        <div
          onClick={e => e.stopPropagation()}
          style={{
            display: "flex", gap: 3, flexShrink: 0,
            opacity: hover ? 1 : 0.7,
            transition: "opacity 0.10s",
          }}
        >
          {/* The scheduled state, not the run state — routines are
              "playing" by default (the schedule is active), so the
              button shows Stop. Click pauses the schedule; click again
              resumes. A separate Stop appears on individual run rows
              for interrupting an in-flight execution. */}
          {isEnabled(routine) ? (
            <RowIconBtn
              title="Pause schedule"
              onClick={e => { e.stopPropagation(); runtimeSetEnabled(routine.id, false); }}
            >
              <Square size={10} strokeWidth={0} style={{ fill: "currentColor" }} />
            </RowIconBtn>
          ) : (
            <RowIconBtn
              title="Resume schedule"
              onClick={e => { e.stopPropagation(); runtimeSetEnabled(routine.id, true); }}
            >
              <Play size={12} />
            </RowIconBtn>
          )}
          {inflightRun && (
            <RowIconBtn
              title="Stop current run"
              onClick={e => { e.stopPropagation(); runtimeStopRun(inflightRun.id); }}
            >
              <Square size={10} strokeWidth={0} style={{ fill: "currentColor", color: "#f87171" }} />
            </RowIconBtn>
          )}
          <RowMenu onEdit={onEdit} onDelete={onRequestDelete} />
        </div>
      </div>

      {/* ── Bottom section — stats strip. No divider above; the rhythm
          relies on padding only so the card reads as one continuous
          surface rather than two stacked panels. */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(170px, 1.5fr) minmax(150px, 1.4fr) minmax(80px, 1fr) minmax(110px, 1fr)",
        gap: 0,
        padding: "2px 14px 12px",
      }}>
        <StatCell label="Schedule">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ScheduleBadge schedule={routine.schedule} />
            <span style={{
              fontSize: 11.5, color: "var(--c-high)", fontWeight: 500,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{scheduleSummary(routine)}</span>
          </div>
        </StatCell>
        <StatCell label="Last 14 runs">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkline runs={runStatusBars(last14)} />
            <span style={{
              fontSize: 10.5, color: "var(--c-ghost)",
              fontFamily: "var(--font-mono)",
            }}>{last14.length}/14</span>
          </div>
        </StatCell>
        <StatCell label="Success">
          <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
            <span style={{
              fontSize: 12.5,
              color: success == null ? "var(--c-dim)" : success >= 80 ? "#86efac" : success >= 50 ? "#fdba74" : "#f87171",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}>{success == null ? "—" : `${success}%`}</span>
            <span style={{ fontSize: 10, color: "var(--c-ghost)" }}>
              {completedCount === 0 ? "no runs" : `${completedCount} run${completedCount === 1 ? "" : "s"}`}
            </span>
          </div>
        </StatCell>
        <StatCell label="Next run">
          <span style={{
            fontSize: 11.5, color: "var(--c-high)", fontWeight: 500,
            fontFamily: "var(--font-mono)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{nextRunLabel(routine, runs)}</span>
        </StatCell>
      </div>
    </div>
  );
}

function StatCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <span style={{
        fontSize: 9.5, color: "var(--c-ghost)",
        textTransform: "uppercase", letterSpacing: "0.08em",
        fontWeight: 600,
      }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/* ── Chip — small inline tag. Tones: neutral / blue / purple / orange. */
type ChipTone = "neutral" | "blue" | "purple" | "orange" | "yellow";
function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: ChipTone }) {
  const tones: Record<ChipTone, { bg: string; fg: string }> = {
    neutral: { bg: "var(--c-srf2)",                fg: "var(--c-low)"  },
    blue:    { bg: "rgba(59,130,246,0.12)",        fg: "#93c5fd"       },
    purple:  { bg: "rgba(168,85,247,0.12)",        fg: "#c4b5fd"       },
    orange:  { bg: "rgba(251,146,60,0.12)",        fg: "#fdba74"       },
    yellow:  { bg: "rgba(234,179,8,0.14)",         fg: "#eab308"       },
  };
  const t = tones[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "1px 6px",
      background: t.bg, color: t.fg,
      borderRadius: 4,
      fontSize: 10, fontWeight: 500,
      letterSpacing: 0,
      lineHeight: 1.5,
    }}>{children}</span>
  );
}

function permTone(p: PermissionMode): ChipTone {
  if (p === "bypassPermissions" || p === "auto") return "yellow";
  if (p === "plan") return "blue";
  return "neutral";
}

/* Live "Running…" indicator for rows + the detail hero. Mirrors the
   Paused chip's slot — same family of state chips — but pulses so the
   reader can tell a run is in flight at a glance. */
function RunningChip() {
  return (
    <Chip tone="blue">
      <Loader2 size={9} style={{ animation: "spin 1s linear infinite" }} />
      <span>Running</span>
    </Chip>
  );
}

function ScheduleBadge({ schedule }: { schedule: Schedule }) {
  const isEvent = schedule === "manual";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 6px",
      background: isEvent ? "rgba(168,85,247,0.12)" : "rgba(59,130,246,0.12)",
      color: isEvent ? "#c4b5fd" : "#93c5fd",
      borderRadius: 3,
      fontSize: 9, fontWeight: 600,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      fontFamily: "var(--font-mono)",
      flexShrink: 0,
    }}>{isEvent ? "Event" : "Schedule"}</span>
  );
}

/* ── Sparkline ───────────────────────────────────────────────────────
   14 fixed-width bars. When we have run history we render green/red
   bars per the run outcome; with no data we render dim placeholder
   bars so the column still anchors visually. */
function Sparkline({ runs }: { runs: ("ok" | "fail")[] }) {
  const slots = Array.from({ length: 14 }).map((_, i) => runs[i]);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 14 }}>
      {slots.map((r, i) => (
        <span key={i} style={{
          width: 4, height: r ? 14 : 6,
          borderRadius: 1,
          background: r === "ok" ? "#22c55e"
                    : r === "fail" ? "#f87171"
                    : "var(--c-brd)",
          opacity: r ? 1 : 0.6,
        }} />
      ))}
    </div>
  );
}

function RowIconBtn({ children, onClick, title }: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 22, height: 22, borderRadius: 5,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "transparent", border: "none",
        color: "var(--c-dim)", cursor: "pointer",
        transition: "background 0.08s, color 0.08s",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf2)"; e.currentTarget.style.color = "var(--c-high)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-dim)"; }}
    >{children}</button>
  );
}

function Dot() { return <span style={{ color: "var(--c-ghost)", opacity: 0.5 }}>·</span>; }

/* Three-dot row menu — opens a small popover with Edit + Delete. Same
   visual idiom as the sidebar's CtxMenu but simpler (only two rows so
   we don't need separators). Positioned via fixed coords so it
   escapes any parent overflow:hidden. */
function RowMenu({ onEdit, onDelete }: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <RowIconBtn title="More" onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
        <MoreHorizontal size={12} />
      </RowIconBtn>
      {open && pos && (
        <div style={{
          position: "fixed",
          top: pos.top, right: pos.right,
          minWidth: 180,
          background: "var(--popover)",
          border: "1px solid var(--c-brd2)",
          borderRadius: 10,
          padding: 4,
          boxShadow: "0 8px 24px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.06)",
          zIndex: 9999,
          fontFamily: "var(--font-sans)",
        }}>
          <MenuItem icon={<Pencil size={11} />} label="Edit" onClick={() => { setOpen(false); onEdit(); }} />
          <MenuItem icon={<Trash2 size={11} />} label="Delete" onClick={() => { setOpen(false); onDelete(); }} danger />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        width: "100%", padding: "5px 8px",
        background: "none", border: "none",
        borderRadius: 6, cursor: "pointer", textAlign: "left",
        fontFamily: "inherit", fontSize: 12,
        color: danger ? "#f87171" : "var(--c-med)",
        transition: "background 0.08s, color 0.08s",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = danger ? "rgba(248,113,113,0.09)" : "var(--c-srf)";
        if (!danger) e.currentTarget.style.color = "var(--c-high)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "none";
        e.currentTarget.style.color = danger ? "#f87171" : "var(--c-med)";
      }}
    >
      <span style={{ display: "inline-flex", color: danger ? "#f87171" : "var(--c-ghost)", flexShrink: 0 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/* Adapt RoutineRun[] into the sparkline's ok/fail slot array. Oldest
   run goes on the left so the most recent outcome sits on the right
   — same convention as GitHub's actions bars. */
function runStatusBars(list: RoutineRun[]): ("ok" | "fail")[] {
  return list
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .filter(r => r.status !== "running")
    .map(r => (r.status === "ok" ? "ok" : "fail"));
}

/* Logs tab — flattens every run across every routine into a single
   chronological feed. Each row shows the routine name, status, when,
   and a click jumps into the session that ran it. */
function LogsPanel({ routines, onOpenRun }: { routines: Routine[]; onOpenRun: (routineId: string, runId: string) => void }) {
  const runs = useRuns();

  const sorted = useMemo(
    () => runs.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    [runs],
  );

  if (sorted.length === 0) {
    return (
      <EmptyPanel
        title="No logs yet."
        subtitle="Each routine execution shows up here with its status, assistant summary, and a link into the run that produced it."
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {sorted.map(run => {
        const routine = routines.find(r => r.id === run.routineId);
        return (
          <LogsRow
            key={run.id}
            run={run}
            routineName={routine?.name ?? "(deleted routine)"}
            routineTool={routine?.target === "resume" ? undefined : routine?.provider}
            onOpen={() => onOpenRun(run.routineId, run.id)}
            onDelete={() => runtimeDeleteRun(run.id)}
          />
        );
      })}
    </div>
  );
}

/* Logs row — like RunRow but with a routine-name header so you can
   tell which routine produced the run at a glance. Useful in the
   global Logs feed where runs from many routines interleave. */
function LogsRow({ run, routineName, routineTool, onOpen, onDelete }: {
  run: RoutineRun;
  routineName: string;
  routineTool?: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const summary = useRunSummary(run.sessionId);
  const isRunning = run.status === "running";
  // Only show duration for finished runs — live ticking for running
   // rows would either need a per-row interval (overkill) or a
   // page-level tick (drag on scroll). The status label conveys
   // "still going" on its own.
  const duration = run.finishedAt
    ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
    : null;
  const statusColor =
    isRunning             ? "#93c5fd" :
    run.status === "ok"   ? "#86efac" :
                            "#f87171";
  const statusLabel =
    isRunning             ? "Running"
    : run.status === "ok" ? "Completed"
                          : (run.error ?? "Failed");

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? "var(--c-srf)" : "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 8,
        padding: "10px 12px",
        cursor: "pointer",
        transition: "background 0.08s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        {routineTool && <ProviderLogo tool={routineTool} size={12} />}
        <span style={{
          fontSize: 12, fontWeight: 600, color: "var(--c-high)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          minWidth: 0, flex: 1,
        }}>{routineName}</span>
        <Chip tone={run.status === "ok" ? "neutral" : isRunning ? "blue" : "orange"}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{
              display: "inline-block", width: 5, height: 5, borderRadius: "50%",
              background: statusColor,
            }} />
            {statusLabel}
          </span>
        </Chip>
        <span style={{ fontSize: 10.5, color: "var(--c-ghost)", fontFamily: "var(--font-mono)" }}>
          {duration != null ? `${formatDuration(duration)} · ` : ""}{formatPast(run.startedAt)}
        </span>
        <div style={{
          display: "flex", gap: 2, marginLeft: 4,
          opacity: hover ? 1 : 0,
          transition: "opacity 0.10s",
        }}>
          {isRunning && (
            <RowIconBtn title="Stop run" onClick={e => { e.stopPropagation(); runtimeStopRun(run.id); }}>
              <Square size={10} strokeWidth={0} style={{ fill: "currentColor", color: "#f87171" }} />
            </RowIconBtn>
          )}
          <RowIconBtn title="Delete run" onClick={e => { e.stopPropagation(); onDelete(); }}>
            <Trash2 size={10} />
          </RowIconBtn>
        </div>
      </div>

      {summary && summary.text && (
        <div style={{
          marginTop: 7,
          paddingLeft: routineTool ? 21 : 0,
          fontSize: 11.5, color: "var(--c-low)",
          lineHeight: 1.5,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>{summary.text}</div>
      )}
      {summary && summary.tools > 0 && (
        <div style={{
          marginTop: 5,
          paddingLeft: routineTool ? 21 : 0,
          fontSize: 10.5, color: "var(--c-ghost)",
        }}>
          {summary.tools} tool call{summary.tools === 1 ? "" : "s"}
          {summary.thinking ? " · reasoned" : ""}
        </div>
      )}
    </div>
  );
}

/* All-runs tab — same rich rows as the Logs feed but grouped under a
   per-routine header so the user can read one routine's history
   continuously. Reuses LogsRow so a row clicked here opens the
   same inline run-detail view that Logs does. */
function AllRunsPanel({ routines, onOpenRun }: {
  routines: Routine[];
  onOpenRun: (routineId: string, runId: string) => void;
}) {
  const runs = useRuns();
  if (runs.length === 0) {
    return (
      <EmptyPanel
        title="No runs yet."
        subtitle="Create or trigger a routine — its runs will accumulate here."
      />
    );
  }

  // Show only routines that actually have runs (skip empties so the
  // page doesn't read as a list of zeros).
  const groups = routines
    .map(routine => ({
      routine,
      list: runs
        .filter(r => r.routineId === routine.id)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, 14),
    }))
    .filter(g => g.list.length > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {groups.map(({ routine, list }) => {
        const ok = list.filter(r => r.status === "ok").length;
        const failed = list.filter(r => r.status === "error").length;
        const running = list.filter(r => r.status === "running").length;
        return (
          <div key={routine.id}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              marginBottom: 8,
              paddingBottom: 6,
            }}>
              <ProviderLogo tool={routine.target === "resume" ? "claude-code" : routine.provider} size={13} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>{routine.name}</span>
              <span style={{ fontSize: 10.5, color: "var(--c-ghost)", fontFamily: "var(--font-mono)" }}>
                {list.length} recent
              </span>
              <div style={{ flex: 1 }} />
              {running > 0 && <Chip tone="blue">{running} running</Chip>}
              {ok > 0       && <Chip tone="neutral">{ok} ok</Chip>}
              {failed > 0   && <Chip tone="orange">{failed} failed</Chip>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {list.map(run => (
                <LogsRow
                  key={run.id}
                  run={run}
                  routineName={routine.name}
                  routineTool={routine.target === "resume" ? undefined : routine.provider}
                  onOpen={() => onOpenRun(routine.id, run.id)}
                  onDelete={() => runtimeDeleteRun(run.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Compact duration like "3s" / "1m 4s" / "2h 5m" — used by the runs
   table, the Recent runs list, and the Avg duration stat. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSec = secs % 60;
  if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
}

/* ── Empty states ────────────────────────────────────────────────── */

function RoutinesEmpty({ onNew, onTemplates, hasQuery }: {
  onNew: () => void; onTemplates: () => void; hasQuery: boolean;
}) {
  if (hasQuery) {
    return (
      <EmptyPanel title="No routines match." subtitle="Try a different search." />
    );
  }
  return (
    <div style={{
      padding: "44px 24px",
      border: "1px dashed var(--sidebar-border)",
      borderRadius: 9,
      background: "var(--sidebar)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      textAlign: "center",
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: "50%",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--card)",
        border: "1px solid var(--sidebar-border)",
        marginBottom: 10,
      }}>
        <Clock size={13} style={{ color: "var(--c-ghost)" }} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-high)", marginBottom: 2 }}>
        No routines yet
      </div>
      <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginBottom: 14, lineHeight: 1.45 }}>
        Routines run on a schedule, by API, or webhook.
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={onNew} style={pillBtnStyle}>
          <Plus size={11} strokeWidth={2.2} /> New routine
        </button>
        <button onClick={onTemplates} style={secondaryBtnStyle}>
          Browse templates
        </button>
      </div>
    </div>
  );
}

function EmptyPanel({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{
      padding: "40px 20px",
      border: "1px solid var(--sidebar-border)",
      borderRadius: 9,
      background: "var(--sidebar)",
      textAlign: "center",
    }}>
      <div style={{ fontSize: 12.5, color: "var(--c-low)", marginBottom: 4 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: "var(--c-ghost)" }}>{subtitle}</div>}
    </div>
  );
}

/* ── Templates panel ──────────────────────────────────────────────── */

function TemplatesPanel({ onPick, onAgentPreset }: { onPick: (t: Template) => void; onAgentPreset: (p: AgentPreset) => void }) {
  const setMainView = useAppStore(s => s.setMainView);
  // Agent presets (builtin + marketplace plugin + Library templates) come from
  // the unified runtime endpoint; picking one seeds a routine with that persona.
  const [agentPresets, setAgentPresets] = useState<AgentPreset[]>([]);
  useEffect(() => {
    apiFetch("/api/runtime/templates")
      .then(r => (r.ok ? r.json() : []))
      .then((data: AgentPreset[]) => setAgentPresets(data || []))
      .catch(() => setAgentPresets([]));
  }, []);
  return (
    <>
      {agentPresets.length > 0 && (
        <>
          <GroupLabel text="Agent presets" />
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 8,
            marginBottom: 16,
          }}>
            {agentPresets.map(p => (
              <AgentPresetCard key={p.name} preset={p} onClick={() => onAgentPreset(p)} />
            ))}
          </div>
        </>
      )}
      <GroupLabel text="Automation presets" />
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 8,
        marginBottom: 16,
      }}>
        {TEMPLATES.map(t => (
          <TemplateCard key={t.name} template={t} onClick={() => onPick(t)} />
        ))}
      </div>

      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12,
        padding: "10px 14px",
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 8,
        fontSize: 11.5, color: "var(--c-low)",
      }}>
        <span>
          Looking for more? Community-built routines and integrations
          live in the marketplace.
        </span>
        <button
          onClick={() => setMainView("marketplace")}
          style={{
            ...secondaryBtnStyle,
            color: "var(--c-high)",
            background: "var(--c-srf2)",
          }}
        >
          Browse marketplace <ArrowRight size={10} style={{ marginLeft: 4 }} />
        </button>
      </div>
    </>
  );
}

function GroupLabel({ text }: { text: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
      color: "var(--c-dim)", margin: "0 0 8px",
    }}>{text}</div>
  );
}

/** A card for an agent preset (builtin/plugin/library template) in the
 *  Routines → Templates "Agent presets" group. */
function AgentPresetCard({ preset, onClick }: { preset: AgentPreset; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "12px 14px", borderRadius: 9, cursor: "pointer",
        background: "var(--card)",
        border: "1px solid", borderColor: hover ? "var(--c-brd2)" : "var(--c-brd)",
        transition: "border-color 0.12s",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)", marginBottom: 3 }}>
        {preset.title}
      </div>
      <div style={{
        fontSize: 11.5, color: "var(--c-dim)", lineHeight: 1.4,
        overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      }}>
        {preset.description}
      </div>
    </div>
  );
}

function TemplateCard({ template, onClick }: { template: Template; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "10px 12px",
        background: hover ? "var(--c-srf)" : "var(--sidebar)",
        border: "1px solid",
        borderColor: hover ? "var(--c-brd)" : "var(--sidebar-border)",
        borderRadius: 8,
        cursor: "pointer",
        transition: "background 0.10s, border-color 0.10s",
        display: "flex", flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
        <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }}>{template.emoji}</span>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--c-high)", letterSpacing: "-0.005em" }}>{template.name}</span>
      </div>

      <p style={{ margin: 0, fontSize: 11.5, color: "var(--c-low)", lineHeight: 1.4, marginBottom: 8 }}>{template.description}</p>

      <div style={{
        marginTop: "auto",
        display: "flex", flexDirection: "column", gap: 2,
        fontSize: 10.5, color: "var(--c-dim)", lineHeight: 1.4,
      }}>
        {template.scheduleLabel && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Clock size={10} style={{ color: "var(--c-ghost)" }} />
            <span>{template.scheduleLabel}</span>
          </div>
        )}
        {template.trigger && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Zap size={9} style={{ color: "var(--c-ghost)" }} />
            <span>{template.trigger}</span>
          </div>
        )}
        {template.works && (
          <div style={{ color: "var(--c-ghost)" }}>Works with {template.works}</div>
        )}
      </div>
    </div>
  );
}

/* ── New routine form ────────────────────────────────────────────── */

function NewRoutineForm({ template, agentPreset, existing, onCancel, onSubmit, mode }: {
  template?: Template;
  agentPreset?: AgentPreset;
  existing?: Routine;
  onCancel: () => void;
  onSubmit: (r: Routine) => void;
  mode: "create" | "edit";
}) {
  const sessions = useAppStore(s => s.sessions);
  const staffSessionId = useAppStore(s => s.staffSessionId);
  const userSessions = useMemo(
    () => sessions.filter(s => s.id !== staffSessionId && !s.archived_at && (s.title || "").trim() !== "New chat"),
    [sessions, staffSessionId],
  );

  // ── Identity ────────────────────────────────────────────────────
  const PROVIDERS = useProviderCatalog();
  const [name, setName] = useState(existing?.name ?? (agentPreset ? toKebabName(agentPreset.title) : template ? toKebabName(template.name) : ""));
  const [description, setDescription] = useState(existing?.description ?? agentPreset?.description ?? template?.description ?? "");
  const [instructions, setInstructions] = useState(existing?.instructions ?? template?.defaults.instructions ?? "");

  // ── Permissions ────────────────────────────────────────────────
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(existing?.permissionMode ?? "default");

  // ── Target & session config ────────────────────────────────────
  const [target, setTarget] = useState<Target>(existing?.target ?? "new");
  const [projectPath, setProjectPath] = useState(existing?.projectPath ?? userSessions[0]?.project_path ?? "");
  const [provider, setProvider] = useState<Provider>(existing?.provider ?? "claude-code");
  const [modelId, setModelId] = useState(existing?.modelId ?? "claude-sonnet-4-6");
  const [effort, setEffort] = useState<Effort>((existing?.effort as Effort) ?? "high");
  const [useWorktree, setUseWorktree] = useState(existing?.useWorktree ?? true);
  const [agentTemplate, setAgentTemplate] = useState<string | null>(existing?.agentTemplate ?? agentPreset?.name ?? null);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(existing?.resumeSessionId ?? null);

  // ── Schedule ───────────────────────────────────────────────────
  const [schedule, setSchedule] = useState<Schedule>(existing?.schedule ?? template?.defaults.schedule ?? "daily");
  const [scheduleTime, setScheduleTime] = useState(existing?.scheduleTime ?? template?.defaults.scheduleTime ?? "09:00");

  // ── AI prompt enhance ─────────────────────────────────────────
  // Routes through whatever live session is available — preferring the
  // staff session (always present, purpose-built for app-level AI
  // tasks) so we don't accidentally inject instruction-rewrite traffic
  // into a chat the user is reading.
  const enhanceSessionId = useMemo(() => {
    if (staffSessionId) return staffSessionId;
    return userSessions[0]?.id ?? null;
  }, [staffSessionId, userSessions]);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceUndo, setEnhanceUndo] = useState<string | null>(null);
  const [enhanceToast, setEnhanceToast] = useState<string | null>(null);

  useEffect(() => {
    if (!enhanceToast && !enhanceUndo) return;
    const t = setTimeout(() => { setEnhanceToast(null); setEnhanceUndo(null); }, 6000);
    return () => clearTimeout(t);
  }, [enhanceToast, enhanceUndo]);

  const handleEnhance = async () => {
    const t = instructions.trim();
    if (!t || enhancing) return;
    if (!enhanceSessionId) {
      setEnhanceToast("No session available for AI rewrite");
      return;
    }
    setEnhancing(true);
    setEnhanceToast(null);
    try {
      // Make sure the WS for this session is actually live before we
      // queue an enhance — staff sessions in particular may have been
      // idle-reaped, in which case enhance() would timeout silently.
      await wsManager.ensureConnected(enhanceSessionId);
      const rewrite = await wsManager.enhance(enhanceSessionId, t);
      const cleaned = rewrite.trim().replace(/^["'`]|["'`]$/g, "").trim();
      if (!cleaned || cleaned === "__NOOP__" || cleaned.toUpperCase() === "NO-OP" || cleaned === t) {
        setEnhanceToast("Looks good as is");
      } else {
        setEnhanceUndo(t);
        setInstructions(cleaned);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Enhance failed";
      setEnhanceToast(msg.includes("timed out") ? "Enhance timed out" : "Enhance unavailable, try again");
    } finally {
      setEnhancing(false);
    }
  };

  const undoEnhance = () => {
    if (!enhanceUndo) return;
    setInstructions(enhanceUndo);
    setEnhanceUndo(null);
    setEnhanceToast(null);
  };

  // Try to populate folder from electron's default project root once on
  // mount — same UX as new-agent-dialog so the user doesn't have to
  // type a path they were just looking at.
  useEffect(() => {
    if (projectPath) return;
    const w = window as Window & { electronAPI?: { getProjectRoot?: () => Promise<string> } };
    w.electronAPI?.getProjectRoot?.().then(p => { if (p) setProjectPath(p); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When provider changes, snap to that provider's default model so the
  // user doesn't end up with a claude- model under codex (which would
  // confuse the backend at session-create time).
  const changeProvider = (p: Provider) => {
    setProvider(p);
    const prov = PROVIDERS.find(x => x.id === p);
    const def = prov?.models.find(m => m.default) ?? prov?.models[0];
    if (def) setModelId(def.id);
  };

  // New routine: once the provider catalogue loads, snap to the first available
  // provider if the default isn't actually connected — so the picker never
  // opens on a provider the user can't run.
  useEffect(() => {
    if (existing || PROVIDERS.length === 0) return;
    if (!PROVIDERS.some((p) => p.id === provider)) changeProvider(PROVIDERS[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [PROVIDERS]);

  const valid = useMemo(() => {
    if (name.trim().length === 0 || description.trim().length === 0) return false;
    if (target === "new" && projectPath.trim().length === 0) return false;
    if (target === "resume" && !resumeSessionId) return false;
    return true;
  }, [name, description, target, projectPath, resumeSessionId]);

  const showTime = schedule === "daily" || schedule === "weekdays" || schedule === "weekly";

  const submit = () => {
    if (!valid) return;
    onSubmit({
      // Keep id + createdAt stable on edit so run history stays linked.
      id: existing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      target,
      permissionMode,
      projectPath: projectPath.trim(),
      provider,
      modelId,
      effort,
      useWorktree,
      agentTemplate,
      resumeSessionId: target === "resume" ? resumeSessionId : null,
      schedule,
      scheduleTime,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  };

  return (
    <>
      <BackBar onClick={onCancel} />

      <header style={{ marginBottom: 16 }}>
        <h1 style={{
          margin: 0, padding: 0,
          fontSize: 18, fontWeight: 600,
          color: "var(--c-high)",
          letterSpacing: "-0.01em",
          lineHeight: 1.1,
        }}>
          {mode === "edit" ? `Edit ${existing?.name ?? "routine"}` : "New routine"}
        </h1>
        <p style={{
          margin: "4px 0 0",
          fontSize: 12, color: "var(--c-dim)",
          lineHeight: 1.45,
        }}>
          {mode === "edit"
            ? "Changes apply to the next scheduled run. The run history stays attached."
            : "Anything an agent can do — code review, email triage, briefings, daily digests — packaged into a task that runs on its own."}
        </p>
      </header>

      {/* ── Identity ── */}
      <SectionLabel>Identity</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 8, marginBottom: 18 }}>
        <Field label="Name" required>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="daily-briefing"
            style={inputStyle}
          />
        </Field>
        <Field label="Description" required>
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="One-line description of what this routine does"
            style={inputStyle}
          />
        </Field>
      </div>

      {/* ── Instructions ───────────────────────────────────────────────
          - position:relative + overflow:visible so the SVG border-trace
            overlay can pin to the card edges while the popover still
            escapes upward.
          - Wand2 icon button (matches chat-input's exact affordance:
            same icon, same metrics, same blue-glow active state).
          - SVG border-trace overlay activates while enhancing (uses
            the shared `border-trace` keyframe in globals.css). */}
      <SectionLabel>Instructions</SectionLabel>
      <div style={{
        position: "relative",
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 8,
        marginBottom: 18,
      }}>
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          onKeyDown={e => {
            // ⌘I / Ctrl+I — fire enhance, same shortcut as chat-input.
            if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
              e.preventDefault();
              void handleEnhance();
            }
          }}
          placeholder="What should this routine do? e.g. Summarize my unread emails and draft replies to the urgent ones. Or: post a daily standup to #team based on yesterday's commits."
          rows={4}
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "10px 12px",
            background: "transparent",
            border: "none", outline: "none",
            resize: "vertical",
            color: "var(--c-high)",
            fontSize: 12, lineHeight: 1.55,
            fontFamily: "inherit",
            minHeight: 84,
            position: "relative",
            zIndex: 1,
          }}
        />
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 10,
          padding: "6px 8px",
          borderTop: "1px solid var(--sidebar-border)",
          background: "var(--sidebar)",
          borderRadius: "0 0 8px 8px",
          position: "relative",
          zIndex: 1,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <EnhanceButton
              busy={enhancing}
              hasText={!!instructions.trim()}
              onClick={handleEnhance}
            />
            {enhanceUndo && (
              <button
                onClick={undoEnhance}
                onMouseDown={e => e.preventDefault()}
                title="Undo enhance"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  width: 22, height: 22, borderRadius: 5,
                  background: "transparent", border: "none", outline: "none",
                  color: "var(--c-med)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.08)"; e.currentTarget.style.color = "var(--c-high)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-med)"; }}
              >
                <Undo2 size={11} strokeWidth={1.8} />
              </button>
            )}
            {enhanceToast && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10.5, color: "var(--c-ghost)", marginLeft: 4,
              }}>
                <Sparkles size={9} strokeWidth={1.6} />
                {enhanceToast}
              </span>
            )}
          </div>
          <PermissionPicker value={permissionMode} onChange={setPermissionMode} providerId={provider} />
        </div>

        {/* Border-trace — same SVG overlay chat-input uses, same
            stroke-dasharray + `border-trace` keyframe. Renders only
            while `enhancing` so the card glows around its perimeter
            for the duration of the WS round-trip. */}
        {enhancing && (
          <svg
            aria-hidden
            style={{
              position: "absolute", inset: 0,
              width: "100%", height: "100%",
              pointerEvents: "none",
              zIndex: 3,
              overflow: "visible",
            }}
          >
            <rect
              x="0.5" y="0.5"
              width="calc(100% - 1px)" height="calc(100% - 1px)"
              rx="7.5" ry="7.5"
              fill="none"
              stroke="rgba(var(--fg-rgb), 0.55)"
              strokeWidth="1"
              strokeLinecap="round"
              strokeDasharray="120 700"
              style={{ animation: "border-trace 3.2s linear infinite" }}
            />
          </svg>
        )}
      </div>

      {/* ── Target ── */}
      <SectionLabel>Target</SectionLabel>
      <SegmentedTabs
        value={target}
        options={[
          { value: "new",    label: "New session each run" },
          { value: "resume", label: "Resume existing session" },
        ]}
        onChange={v => setTarget(v as Target)}
      />

      <div style={{ marginTop: 12, marginBottom: 22 }}>
        {target === "new" ? (
          <NewSessionConfig
            projectPath={projectPath}
            onProjectPathChange={setProjectPath}
            recentPaths={Array.from(new Set(userSessions.map(s => s.project_path).filter(Boolean))).slice(0, 8) as string[]}
            provider={provider}
            onProviderChange={changeProvider}
            modelId={modelId}
            onModelIdChange={setModelId}
            effort={effort}
            onEffortChange={setEffort}
            useWorktree={useWorktree}
            onUseWorktreeChange={setUseWorktree}
            agentTemplate={agentTemplate}
            onAgentTemplateChange={setAgentTemplate}
          />
        ) : (
          <SessionPicker
            sessions={userSessions}
            selectedId={resumeSessionId}
            onSelect={setResumeSessionId}
          />
        )}
      </div>

      {/* ── Schedule ── */}
      <SectionLabel>Schedule</SectionLabel>
      <div style={{ marginBottom: 22 }}>
        <SchedulePills value={schedule} onChange={setSchedule} />
        {showTime && (
          <div style={{
            marginTop: 10,
            display: "flex", alignItems: "center", gap: 8,
            fontSize: 12, color: "var(--c-low)",
          }}>
            <span>At</span>
            <input
              type="time"
              value={scheduleTime}
              onChange={e => setScheduleTime(e.target.value)}
              style={{
                padding: "4px 8px",
                background: "var(--sidebar)",
                border: "1px solid var(--sidebar-border)",
                borderRadius: 6,
                color: "var(--c-high)",
                fontSize: 12, fontFamily: "inherit",
                outline: "none",
                colorScheme: "dark",
              }}
            />
          </div>
        )}

        {/* "Computer must be awake" notice — only meaningful when the
            routine actually fires unattended (not Manual). Lives here
            instead of as a top banner so it sits next to the schedule
            control it conditions, and reads as a warning when the
            background-launch setting isn't on. */}
        {schedule !== "manual" && <AwakeNotice />}

        <p style={{
          margin: "10px 0 0",
          fontSize: 11, color: "var(--c-ghost)",
          lineHeight: 1.45,
        }}>
          Scheduled tasks use a randomized delay of several minutes for server performance.
        </p>
      </div>

      {/* Footer actions */}
      <div style={{
        display: "flex", justifyContent: "flex-end", gap: 8,
        marginTop: 8,
      }}>
        <button onClick={onCancel} style={secondaryBtnStyle}>Cancel</button>
        <button
          onClick={submit}
          disabled={!valid}
          style={{
            ...pillBtnStyle,
            opacity: valid ? 1 : 0.4,
            cursor: valid ? "pointer" : "not-allowed",
          }}
        >{mode === "edit" ? "Save changes" : "Create"}</button>
      </div>
    </>
  );
}

/* ── Routine detail ────────────────────────────────────────────────
   Clicking a routine in the list opens this. It shows everything
   stored in the record (target, schedule, provider/model or resume
   target, instructions) plus a Recent runs section. The runs list is
   empty for now — the cron/webhook runtime that records executions is
   still pending — but the surface is wired so we can drop a real
   history feed in without touching this component. */
function RoutineDetail({ routine, onBack, onRequestDelete, onEdit, onOpenRun }: {
  routine: Routine;
  onBack: () => void;
  onRequestDelete: () => void;
  onEdit: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const PROVIDERS = useProviderCatalog();
  const sessions = useAppStore(s => s.sessions);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const setMainView = useAppStore(s => s.setMainView);
  const allRuns = useRuns();
  const runs = useMemo(
    () => allRuns
      .filter(r => r.routineId === routine.id)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    [allRuns, routine.id],
  );
  const last14 = useMemo(() => runs.slice(0, 14), [runs]);
  const success = useMemo(() => computeSuccess(routine.id, 14, allRuns), [routine.id, allRuns]);
  const lastRun = runs[0] ?? null;
  const inflightRun = useMemo(() => runs.find(r => r.status === "running") ?? null, [runs]);
  const avgMs = useMemo(() => {
    const finished = runs.filter(r => r.finishedAt && r.status !== "running");
    if (finished.length === 0) return null;
    const total = finished.reduce((acc, r) => acc + (Date.parse(r.finishedAt!) - Date.parse(r.startedAt)), 0);
    return Math.round(total / finished.length);
  }, [runs]);

  const resumeSession = routine.target === "resume"
    ? sessions.find(s => s.id === routine.resumeSessionId) ?? null
    : null;
  const provider = PROVIDERS.find(p => p.id === routine.provider);
  const { tiles: providerTiles } = useProvidersConfig();
  const routinePerms = permissionModesFor(permissionCapabilityFor(providerTiles, routine.provider));
  const model = provider?.models.find(m => m.id === routine.modelId);
  const projectName = routine.projectPath ? folderName(routine.projectPath) : "";
  const agentTpl = routine.agentTemplate ? AGENT_TEMPLATES.find(t => t.id === routine.agentTemplate) : null;
  const displayTool = resumeSession?.tool ?? routine.provider;

  const sessionAgeLabel = resumeSession
    ? formatPast(resumeSession.last_accessed ?? resumeSession.created_at)
    : null;

  const fullProject = routine.target === "new" ? routine.projectPath : (resumeSession?.project_path ?? "");

  // Upcoming runs — three firings forward from the last actual run
  // (or "now" if there's no history yet) so the cadence preview
  // accounts for what actually happened, not the wall clock.
  const upcoming = useMemo(() => nextThreeRuns(routine, lastRun), [routine, lastRun]);

  return (
    <>
      <BackBar onClick={onBack} />

      {/* ── Hero header card. No status dot, smaller provider logo
          paired with the model label so identity reads as "what runs
          this, with which model" rather than terminal chrome. */}
      <div style={{
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 10,
        padding: "16px 18px",
        marginBottom: 14,
      }}>
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 14,
          marginBottom: 14,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{
              margin: 0, padding: 0,
              fontSize: 18, fontWeight: 600,
              color: "var(--c-high)",
              letterSpacing: "-0.01em", lineHeight: 1.2,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{routine.name}</h1>
            <p style={{
              margin: "4px 0 0",
              fontSize: 12, color: "var(--c-dim)",
              lineHeight: 1.45,
            }}>{routine.description}</p>

            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              marginTop: 10,
              minWidth: 0,
            }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "1px 7px 1px 4px",
                background: "var(--c-srf2)",
                borderRadius: 4,
                flexShrink: 0,
              }}>
                <ProviderLogo tool={displayTool} size={11} />
                <span style={{
                  fontSize: 11, fontWeight: 500, color: "var(--c-high)",
                }}>{model?.label ?? routine.modelId}</span>
              </span>
              {projectName && (
                <span style={{
                  fontSize: 10.5, color: "var(--c-ghost)",
                  fontFamily: "var(--font-mono)",
                }}>{projectName}</span>
              )}
            </div>

            <div style={{
              display: "flex", flexWrap: "wrap", gap: 4,
              marginTop: 10,
            }}>
              {inflightRun && <RunningChip />}
              {!isEnabled(routine) && <Chip tone="orange">Paused</Chip>}
              <Chip tone={routine.target === "resume" ? "purple" : "blue"}>
                {routine.target === "resume" ? "Resume session" : "New session"}
              </Chip>
              <Chip tone={permTone(routine.permissionMode)}>{permLabel(routine.permissionMode, routinePerms)}</Chip>
              {routine.target === "new" && routine.useWorktree && <Chip>Worktree</Chip>}
              {agentTpl && <Chip>{agentTpl.icon} {agentTpl.name}</Chip>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
            <button style={pillBtnStyle} onClick={() => runtimeRunNow(routine.id)}>
              <Play size={11} />
              <span>Run now</span>
            </button>
            <button
              style={secondaryBtnStyle}
              onClick={() => runtimeSetEnabled(routine.id, !isEnabled(routine))}
              title={isEnabled(routine) ? "Pause schedule" : "Resume schedule"}
            >
              {isEnabled(routine) ? (
                <>
                  <Square size={9} strokeWidth={0} style={{ fill: "currentColor" }} />
                  <span>Pause</span>
                </>
              ) : (
                <>
                  <Play size={11} />
                  <span>Resume</span>
                </>
              )}
            </button>
            <button style={secondaryBtnStyle} onClick={onEdit}>
              <Pencil size={11} />
              <span>Edit</span>
            </button>
            <button
              onClick={onRequestDelete}
              style={{
                ...secondaryBtnStyle,
                color: "#f87171",
                borderColor: "rgba(248,113,113,0.25)",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(248,113,113,0.08)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <Trash2 size={11} />
              <span>Delete</span>
            </button>
          </div>
        </div>

        {/* Stats strip — no divider above, only padding rhythm separates
            it from the identity stack. */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: 14,
        }}>
          <StatCell label="Schedule">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <ScheduleBadge schedule={routine.schedule} />
              <span style={{
                fontSize: 11.5, color: "var(--c-high)", fontWeight: 500,
              }}>{scheduleSummary(routine)}</span>
            </div>
          </StatCell>
          <StatCell label="Total runs">
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span style={{
                fontSize: 13, color: "var(--c-high)", fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
              }}>{runs.length}</span>
              <span style={{ fontSize: 10, color: "var(--c-ghost)" }}>since {formatPast(routine.createdAt) ?? "creation"}</span>
            </div>
          </StatCell>
          <StatCell label="Success">
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span style={{
                fontSize: 13, fontWeight: 600,
                color: success == null ? "var(--c-dim)" : success >= 80 ? "#86efac" : success >= 50 ? "#fdba74" : "#f87171",
              }}>{success == null ? "—" : `${success}%`}</span>
              <span style={{ fontSize: 10, color: "var(--c-ghost)" }}>
                {success == null ? "awaiting first run" : "last 14"}
              </span>
            </div>
          </StatCell>
          <StatCell label="Avg duration">
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span style={{
                fontSize: 13, fontWeight: 600,
                color: avgMs == null ? "var(--c-dim)" : "var(--c-high)",
              }}>{avgMs == null ? "—" : formatDuration(avgMs)}</span>
              <span style={{ fontSize: 10, color: "var(--c-ghost)" }}>{avgMs == null ? "no data" : ""}</span>
            </div>
          </StatCell>
          <StatCell label="Last run">
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span style={{
                fontSize: 13, fontWeight: 600,
                color: lastRun ? "var(--c-high)" : "var(--c-dim)",
              }}>{lastRun ? (formatPast(lastRun.startedAt) ?? "—") : "—"}</span>
              <span style={{ fontSize: 10, color: "var(--c-ghost)" }}>{lastRun ? lastRun.status : "never"}</span>
            </div>
          </StatCell>
          <StatCell label="Next run">
            <span style={{
              fontSize: 12.5, color: "var(--c-high)", fontWeight: 500,
              fontFamily: "var(--font-mono)",
            }}>{nextRunLabel(routine, allRuns)}</span>
          </StatCell>
        </div>
      </div>

      {/* ── Two-column body: instructions + target panel ── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 300px",
        gap: 14,
        marginBottom: 14,
      }}>
        {/* Instructions card — header inside, no divider. */}
        <div style={{
          background: "var(--sidebar)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 10,
          padding: "14px 16px",
        }}>
          <PanelHeader
            title="Instructions"
            right={
              <span style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 10.5, color: "var(--c-ghost)" }}>
                <span>{routine.instructions ? `${routine.instructions.length} chars` : "0 chars"}</span>
                <span>{routine.instructions ? `${wordCount(routine.instructions)} words` : "0 words"}</span>
              </span>
            }
          />
          <div style={{
            fontSize: 12.5, color: "var(--c-high)",
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            fontFamily: "inherit",
            minHeight: 120,
          }}>
            {routine.instructions || (
              <span style={{ color: "var(--c-ghost)", fontStyle: "italic" }}>
                No instructions provided. Edit this routine to add them.
              </span>
            )}
          </div>
        </div>

        {/* Target panel — header + content stacked without a divider. */}
        <div style={{
          background: "var(--sidebar)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 10,
          padding: "14px 16px",
        }}>
          <PanelHeader
            title={routine.target === "resume" ? "Resumes session" : "Spawns session"}
            right={
              routine.target === "resume" && resumeSession
                ? <Chip tone={statusTone(resumeSession.status)}>{resumeSession.status}</Chip>
                : null
            }
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {routine.target === "new" ? (
              <>
                <PanelRow label="Provider" value={provider?.name ?? routine.provider} icon={<ProviderLogo tool={routine.provider} size={11} />} />
                <PanelRow label="Model" value={model?.label ?? routine.modelId} />
                {projectName && <PanelRow label="Project" value={projectName} mono />}
                {fullProject && <PanelRow label="Path" value={fullProject} mono />}
                <PanelRow label="Worktree" value={routine.useWorktree ? "Yes" : "No"} />
                {agentTpl && <PanelRow label="Agent" value={`${agentTpl.icon} ${agentTpl.name}`} />}
              </>
            ) : resumeSession ? (
              <>
                <button
                  onClick={() => { setMainView("fleet"); setActiveSession(resumeSession.id); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 9px",
                    background: "var(--c-srf)",
                    border: "1px solid var(--sidebar-border)",
                    borderRadius: 7,
                    cursor: "pointer", textAlign: "left",
                    fontFamily: "inherit",
                    transition: "background 0.08s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf2)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "var(--c-srf)"; }}
                >
                  <ProviderLogo tool={resumeSession.tool} size={12} />
                  <span style={{
                    flex: 1, minWidth: 0,
                    fontSize: 12, color: "var(--c-high)", fontWeight: 500,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{resumeSession.title}</span>
                  <ArrowRight size={11} style={{ color: "var(--c-dim)" }} />
                </button>
                {resumeSession.project_path && (
                  <PanelRow
                    label="Project"
                    value={folderName(resumeSession.project_path)}
                    mono
                  />
                )}
                {resumeSession.tool && <PanelRow label="Provider" value={String(resumeSession.tool)} icon={<ProviderLogo tool={resumeSession.tool} size={11} />} />}
                {resumeSession.worktree_branch && (
                  <PanelRow label="Branch" value={resumeSession.worktree_branch} mono />
                )}
                {sessionAgeLabel && <PanelRow label="Last active" value={sessionAgeLabel} />}
              </>
            ) : (
              <div style={{ fontSize: 11.5, color: "#f87171" }}>
                Session no longer exists.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Upcoming runs preview — concrete schedule cadence the user
          can sanity-check before the runtime ships. */}
      {upcoming.length > 0 && (
        <div style={{
          background: "var(--sidebar)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 10,
          padding: "14px 16px",
          marginBottom: 14,
        }}>
          <PanelHeader title="Upcoming runs" right={
            <span style={{ fontSize: 10.5, color: "var(--c-ghost)" }}>next {upcoming.length}</span>
          } />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {upcoming.map((d, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                fontSize: 11.5, color: "var(--c-low)",
              }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Clock size={11} style={{ color: "var(--c-ghost)" }} />
                  <span style={{ color: "var(--c-high)", fontWeight: 500 }}>
                    {d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                </span>
                <span style={{ color: "var(--c-ghost)", fontFamily: "var(--font-mono)" }}>
                  {formatRelative(d)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Recent runs — pulls live entries from the runtime's log ── */}
      <div style={{
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 10,
        padding: "14px 16px",
      }}>
        <PanelHeader title="Recent runs" right={
          <span style={{ fontSize: 10.5, color: "var(--c-ghost)" }}>{runs.length} run{runs.length === 1 ? "" : "s"}</span>
        } />
        {runs.length === 0 ? (
          <div style={{
            padding: "26px 16px",
            textAlign: "center",
          }}>
            <div style={{
              width: 30, height: 30, borderRadius: "50%",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "var(--card)",
              border: "1px solid var(--sidebar-border)",
              marginBottom: 9,
            }}>
              <Clock size={12} style={{ color: "var(--c-ghost)" }} />
            </div>
            <div style={{ fontSize: 12, color: "var(--c-low)", marginBottom: 2 }}>
              No runs yet
            </div>
            <div style={{ fontSize: 10.5, color: "var(--c-ghost)", maxWidth: 360, margin: "0 auto" }}>
              Each execution will appear here with its status, duration, and a
              link into the session that ran it.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {last14.map(run => (
              <RunRow
                key={run.id}
                run={run}
                onOpen={() => onOpenRun(run.id)}
                onDelete={() => runtimeDeleteRun(run.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ── Inline run-detail view ─────────────────────────────────────────
   Opens when the user clicks a run in Recent runs / Logs / All runs.
   Renders the run's session messages inline (instructions + assistant
   responses + tool calls) so the user can see what happened WITHOUT
   leaving the Routines surface. An "Open in chat" pill is available
   for the few times the full chat is needed.

   Exported for its unit test only. */
export function RunDetailView({ routineId, runId, onBack }: {
  routineId: string; runId: string; onBack: () => void;
}) {
  const allRuns = useRuns();
  // Re-derive routines on every render (loadRoutines is a cheap
  // localStorage read). Avoids importing the routines list from the
  // parent — keeps this view self-contained.
  const PROVIDERS = useProviderCatalog();
  const routine = loadRoutines().find(r => r.id === routineId);
  const run = allRuns.find(r => r.id === runId);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const setMainView = useAppStore(s => s.setMainView);

  // Pull messages from chat-store first; if absent, fetch + hydrate.
  const chatMessages = useChatStore(s =>
    run?.sessionId ? (s.sessions[run.sessionId]?.messages as ChatMessage[] | undefined) : undefined,
  );
  // The fetch below runs once per session id, so keep the inactive-session
  // sweep off this transcript while it is on screen. Without the pin it was
  // emptied ~20 s in: a run's session is not the one a chat view shows, so
  // the sweep counted it as hidden.
  usePinnedSession(run?.sessionId);
  const setMessages = useChatStore(s => s.setMessages);
  const ensureSession = useChatStore(s => s.ensureSession);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!run?.sessionId) return;
    if (chatMessages && chatMessages.length > 0) return;
    const sid = run.sessionId;
    let cancelled = false;
    ensureSession(sid);
    const startedAt = performance.now();
    // Synchronous setLoading would trip the set-state-in-effect lint;
    // wrap the entire start-of-fetch in a microtask so React commits
    // the effect cleanup path before we mutate state.
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      // The endpoint returns `content` as JSON text; MessageCard walks blocks.
      fetchMessages(sid)
        .then(rows => { if (!cancelled) setMessages(sid, parseStoredMessages(rows)); })
        .catch(e => { if (!cancelled) setFetchError(e instanceof Error ? e.message : "Could not load messages"); })
        .finally(() => { if (!cancelled) setLoading(false); });
    });
    return () => { cancelled = true; void startedAt; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.sessionId]);

  if (!run || !routine) {
    return (
      <>
        <BackBar onClick={onBack} />
        <div style={{ padding: 32, color: "var(--c-dim)" }}>Run not found.</div>
      </>
    );
  }

  const messages = chatMessages ?? [];
  const duration = run.finishedAt
    ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
    : null;
  const statusChipTone: ChipTone =
    run.status === "running" ? "blue"
    : run.status === "ok"    ? "neutral"
                              : "orange";
  const statusLabel =
    run.status === "running" ? "Running…"
    : run.status === "ok"    ? "Completed"
                              : (run.error ?? "Failed");

  const provider = PROVIDERS.find(p => p.id === routine.provider);
  const model = provider?.models.find(m => m.id === routine.modelId);

  return (
    <>
      <button
        onClick={onBack}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "5px 8px 5px 6px",
          background: "transparent", border: "none", borderRadius: 5,
          color: "var(--c-med)", fontSize: 12.5, fontWeight: 500,
          fontFamily: "inherit", cursor: "pointer", marginBottom: 14,
          transition: "background 0.08s, color 0.08s",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--c-srf)"; (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
      >
        <ArrowLeft size={13} /> Back to {routine.name}
      </button>

      {/* Hero — status + when + meta + open-in-chat link. */}
      <div style={{
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 14,
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          marginBottom: 6,
        }}>
          <Chip tone={statusChipTone}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{
                display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                background: run.status === "running" ? "#93c5fd" : run.status === "ok" ? "#86efac" : "#f87171",
              }} />
              {statusLabel}
            </span>
          </Chip>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "1px 7px 1px 4px",
            background: "var(--c-srf2)",
            borderRadius: 4,
          }}>
            <ProviderLogo tool={routine.target === "resume" ? "claude-code" : routine.provider} size={11} />
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--c-high)" }}>
              {model?.label ?? routine.modelId}
            </span>
          </span>
          <span style={{ fontSize: 11, color: "var(--c-dim)", fontFamily: "var(--font-mono)" }}>
            {formatPast(run.startedAt)}{duration != null ? ` · ${formatDuration(duration)}` : ""}
          </span>
          <div style={{ flex: 1 }} />
          {run.sessionId && (
            <button
              onClick={() => { if (run.sessionId) { setMainView("fleet"); setActiveSession(run.sessionId); } }}
              style={secondaryBtnStyle}
            >
              Open in chat <ArrowRight size={10} style={{ marginLeft: 4 }} />
            </button>
          )}
          {run.status === "running" && (
            <button
              onClick={() => runtimeStopRun(run.id)}
              style={{
                ...secondaryBtnStyle,
                color: "#f87171",
                borderColor: "rgba(248,113,113,0.25)",
              }}
            >
              <Square size={9} strokeWidth={0} style={{ fill: "currentColor", marginRight: 5 }} />
              Stop
            </button>
          )}
        </div>
        {run.error && (
          <div style={{
            marginTop: 8,
            padding: "6px 9px",
            background: "rgba(248,113,113,0.08)",
            border: "1px solid rgba(248,113,113,0.25)",
            borderRadius: 7,
            fontSize: 11.5, color: "#fdba74", lineHeight: 1.4,
          }}>{run.error}</div>
        )}
      </div>

      {/* Instructions sent — always available even when messages
          haven't loaded yet, so the user has at least context. */}
      <div style={{
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 10,
        padding: "12px 16px",
        marginBottom: 14,
      }}>
        <PanelHeader title="Instructions sent" />
        <div style={{
          fontSize: 12.5, color: "var(--c-high)",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
        }}>{routine.instructions || <span style={{ color: "var(--c-ghost)", fontStyle: "italic" }}>No instructions provided.</span>}</div>
      </div>

      {/* Activity — assistant messages + tool calls in order. */}
      <div style={{
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 10,
        padding: "12px 16px",
      }}>
        <PanelHeader
          title="Activity"
          right={(() => {
            const count = messages.filter(m => m.role !== "user").length;
            return (
              <span style={{ fontSize: 10.5, color: "var(--c-ghost)" }}>
                {count} message{count === 1 ? "" : "s"}
              </span>
            );
          })()}
        />
        {(() => {
          // Activity is the *agent's* trace only — the instructions
          // already sit above the panel as their own block, so echoing
          // the user message here is duplicate noise.
          const agentMessages = messages.filter(m => m.role !== "user");
          if (loading && agentMessages.length === 0) {
            return (
              <div style={{ padding: "18px 8px", textAlign: "center", fontSize: 11.5, color: "var(--c-dim)" }}>
                Loading messages…
              </div>
            );
          }
          if (fetchError && agentMessages.length === 0) {
            return <div style={{ padding: "12px 8px", fontSize: 11.5, color: "#fdba74" }}>{fetchError}</div>;
          }
          if (agentMessages.length === 0) {
            return (
              <div style={{ padding: "18px 8px", textAlign: "center", fontSize: 11.5, color: "var(--c-dim)" }}>
                {run.status === "running" ? "Waiting for the first message…" : "No messages recorded for this run."}
              </div>
            );
          }
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {agentMessages.map(msg => <MessageCard key={msg.id} message={msg} />)}
            </div>
          );
        })()}
      </div>
    </>
  );
}

/* Inline message renderer for the run-detail Activity panel. Mirrors
   the chat-view's rendering shape: walks the message's content blocks,
   groups consecutive tool_use blocks into a single "Ran X commands" /
   "Edited Y files" summary line (collapsible to show the tool names
   below), and renders text blocks as paragraphs.

   Doesn't depend on chat-store stream state (unlike chat-view's
   MessageContent) so it works for any session, not just the active one. */
function MessageCard({ message }: { message: ChatMessage }) {
  // Group consecutive blocks of the same kind so tool sequences read
  // as one "Ran 4 commands" line instead of four separate rows.
  // Activity panel shows only what the agent *did* — thinking blocks
  // are skipped on purpose; the user only wants actions + replies.
  type Group =
    | { kind: "text"; text: string }
    | { kind: "tools"; blocks: ToolUseBlockLike[] };
  const groups: Group[] = [];
  for (const block of message.content) {
    const last = groups[groups.length - 1];
    if (block.type === "text") {
      if (last?.kind === "text") last.text += "\n\n" + block.text;
      else groups.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use") {
      const tu = block as unknown as ToolUseBlockLike;
      if (last?.kind === "tools") last.blocks.push(tu);
      else groups.push({ kind: "tools", blocks: [tu] });
    }
  }

  if (groups.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {groups.map((g, i) => {
        if (g.kind === "text") {
          return <MarkdownBody key={i} text={g.text} />;
        }
        return <ToolGroupChip key={i} tools={g.blocks} />;
      })}
    </div>
  );
}

type ToolUseBlockLike = {
  tool_id?: string;
  tool_name?: string;
  tool_kind?: string;
  input?: Record<string, unknown>;
};

/* Maps a tool name (or ACP tool_kind) to a verb + object pair used in
   the "Ran X commands" / "Edited X files" summary. Mirrors the verb
   buckets used by chat-view's tool grouping so a routine's Activity
   panel reads with the same vocabulary as the chat. */
function toolVerb(name: string, kind?: string): { verb: string; sg: string; pl: string } {
  const n = (name || "").toLowerCase();
  const k = (kind || "").toLowerCase();
  if (k === "execute" || n === "bash" || n.includes("run_command") || n.includes("shell")) return { verb: "Ran", sg: "a command", pl: "commands" };
  if (k === "read" || n === "read") return { verb: "Read", sg: "a file", pl: "files" };
  if (k === "edit" || n === "edit" || n.includes("multiedit")) return { verb: "Edited", sg: "a file", pl: "files" };
  if (n === "write") return { verb: "Wrote", sg: "a file", pl: "files" };
  if (n === "glob" || k === "search" && n === "glob") return { verb: "Globbed", sg: "a pattern", pl: "patterns" };
  if (k === "search" || n === "grep" || n.includes("search")) return { verb: "Searched", sg: "for a pattern", pl: "queries" };
  if (k === "fetch" || n.includes("webfetch") || n.includes("url_fetch")) return { verb: "Fetched", sg: "a URL", pl: "URLs" };
  if (n.includes("websearch") || n.includes("web_search")) return { verb: "Searched the web", sg: "", pl: "" };
  if (n.includes("todowrite") || n.includes("todo")) return { verb: "Updated", sg: "todos", pl: "todos" };
  if (n === "task" || k === "agent") return { verb: "Dispatched", sg: "an agent", pl: "agents" };
  if (k === "move") return { verb: "Moved", sg: "a file", pl: "files" };
  if (k === "delete") return { verb: "Deleted", sg: "a file", pl: "files" };
  if (k === "think" || n.includes("think")) return { verb: "Thought", sg: "", pl: "" };
  return { verb: "Used", sg: name || "a tool", pl: "tools" };
}

/* Compact verb-bucket summary for a contiguous run of tool_use blocks.
   "Ran 4 commands" / "Edited a file, ran 2 commands". Click to expand
   the underlying tool names for spot-checking what actually ran. */
function ToolGroupChip({ tools }: { tools: ToolUseBlockLike[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;

  const buckets = new Map<string, { verb: string; sg: string; pl: string; count: number }>();
  for (const t of tools) {
    const v = toolVerb(t.tool_name ?? "", t.tool_kind);
    const prev = buckets.get(v.verb);
    if (prev) prev.count += 1;
    else buckets.set(v.verb, { ...v, count: 1 });
  }
  const phrases: string[] = [];
  for (const { verb, sg, pl, count } of buckets.values()) {
    const word = verb.toLowerCase();
    const obj = !sg && !pl ? "" : count === 1 ? ` ${sg}` : ` ${count} ${pl}`;
    phrases.push(`${word}${obj}`);
  }
  const summary = phrases.length
    ? phrases[0]!.charAt(0).toUpperCase() + phrases[0]!.slice(1) +
      (phrases.length > 1 ? ", " + phrases.slice(1).join(", ") : "")
    : `Used ${tools.length} tools`;

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: 0,
          background: "transparent", border: "none",
          cursor: "pointer", textAlign: "left",
          fontFamily: "inherit",
        }}
      >
        <span style={{
          fontSize: 12.5, fontWeight: 400,
          color: "var(--c-low)",
          letterSpacing: "-0.005em",
        }}>{summary}</span>
        <ChevronRight size={11} style={{
          color: "var(--c-ghost)",
          transform: open ? "rotate(90deg)" : "none",
          transition: "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)",
        }} />
      </button>
      <div style={{
        display: "grid",
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transition: "grid-template-rows 220ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease",
      }}>
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div style={{
            display: "flex", flexDirection: "column", gap: 3,
            marginTop: 6, paddingLeft: 14,
          }}>
            {tools.map((t, i) => (
              <ToolLineItem key={t.tool_id ?? i} tool={t} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Single tool row inside an expanded ToolGroupChip. Uses chat-view's
   rowSummary so each row reads identically to the chat ("Edited
   foo.tsx +12 -3", "Ran git log", "Searched for 'pattern'") instead
   of a bare verb. */
function ToolLineItem({ tool }: { tool: ToolUseBlockLike }) {
  const summary = rowSummary(tool.tool_name ?? "", tool.input ?? {});
  return (
    <div style={{
      fontSize: 12.5, color: "var(--c-low)",
      lineHeight: 1.5,
      letterSpacing: "-0.005em",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>{summary}</div>
  );
}

/* Pulls a 1-line summary of what the assistant did during the run by
   peeking into the chat store for the session this run owns. Picks
   the LAST assistant message and condenses its content blocks: text
   if present, otherwise a "Wrote a file, ran 3 commands"-style
   description of the tool calls. */
function useRunSummary(sessionId: string | null): { text: string; tools: number; thinking: boolean } | null {
  const chatStore = useChatStore(s => s.sessions);
  return useMemo(() => {
    if (!sessionId) return null;
    const messages = chatStore[sessionId]?.messages as ChatMessage[] | undefined;
    if (!messages || messages.length === 0) return null;
    const last = messages.slice().reverse().find(m => m.role === "assistant");
    if (!last) return null;
    let text = "";
    let tools = 0;
    let thinking = false;
    for (const block of last.content) {
      if (block.type === "text") text += (text ? " " : "") + block.text;
      else if (block.type === "tool_use") tools += 1;
      else if (block.type === "thinking") thinking = true;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text && tools > 0) text = `Ran ${tools} tool${tools === 1 ? "" : "s"}`;
    if (text.length > 220) text = text.slice(0, 217) + "…";
    return { text, tools, thinking };
  }, [chatStore, sessionId]);
}

function RunRow({ run, onOpen, onDelete }: {
  run: RoutineRun;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const duration = run.finishedAt
    ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
    : null;
  const summary = useRunSummary(run.sessionId);
  const isRunning = run.status === "running";
  const statusLabel =
    isRunning             ? "Running"
    : run.status === "ok" ? "Completed"
                          : (run.error ?? "Failed");

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      style={{
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 8,
        padding: 10,
        cursor: "pointer",
        transition: "border-color 0.10s",
        borderColor: hover ? "var(--c-brd2, var(--sidebar-border))" : "var(--sidebar-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 14, height: 14, flexShrink: 0,
          color: "var(--c-ghost)",
        }}>
          {isRunning
            ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
            : run.status === "ok"
              ? <CheckCircle2 size={11} />
              : <AlertCircle size={11} />}
        </span>
        <span style={{
          fontSize: 12, fontWeight: 500,
          color: "var(--c-high)",
          letterSpacing: "-0.005em",
        }}>{statusLabel}</span>
        <div style={{ flex: 1, minWidth: 0 }} />
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 10.5, color: "var(--c-ghost)",
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}>
          {duration != null && <><span>{formatDuration(duration)}</span><Dot /></>}
          <span>{formatPast(run.startedAt)}</span>
        </span>
        <div style={{
          display: "flex", gap: 2, marginLeft: 2,
          opacity: hover ? 1 : 0,
          transition: "opacity 0.10s",
        }}>
          {isRunning && (
            <RowIconBtn title="Stop run" onClick={e => { e.stopPropagation(); runtimeStopRun(run.id); }}>
              <Square size={10} strokeWidth={0} style={{ fill: "currentColor", color: "#f87171" }} />
            </RowIconBtn>
          )}
          {onDelete && (
            <RowIconBtn title="Delete run" onClick={e => { e.stopPropagation(); onDelete(); }}>
              <Trash2 size={10} />
            </RowIconBtn>
          )}
        </div>
      </div>

      {summary && summary.text && (
        <div style={{
          marginTop: 8,
          fontSize: 11.5, color: "var(--c-low)",
          lineHeight: 1.5,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>{summary.text}</div>
      )}

      {summary && summary.tools > 0 && (
        <div style={{
          marginTop: 6,
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 10.5, color: "var(--c-ghost)",
        }}>
          <span>{summary.tools} tool call{summary.tools === 1 ? "" : "s"}</span>
          {summary.thinking && (<><Dot /><span>reasoned</span></>)}
        </div>
      )}
    </div>
  );
}

function PanelHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 8, marginBottom: 10,
    }}>
      <span style={{
        fontSize: 10.5, color: "var(--c-ghost)",
        fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}>{title}</span>
      {right}
    </div>
  );
}

function statusTone(status: string): ChipTone {
  if (status === "running") return "blue";
  if (status === "waiting") return "orange";
  if (status === "error") return "yellow";
  return "neutral";
}

function formatPast(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/* Project the next three firing times for the upcoming-runs preview.
   Starts from the last actual run (when there is one) so the preview
   reflects the real cadence — not just an idealized wall-clock projection. */
function nextThreeRuns(r: Routine, lastRun: RoutineRun | null): Date[] {
  if (r.schedule === "manual") return [];
  const out: Date[] = [];
  // Seed cursor at the last run's start so the next fire matches what
  // the runtime would actually do; if no run yet, use "now".
  let cursor = lastRun ? new Date(lastRun.startedAt) : new Date();
  for (let i = 0; i < 3; i++) {
    const next = advance(cursor, r);
    if (!next) break;
    // Don't show fire-times in the past — clamp to "now" for the first
    // upcoming when the cadence has already lapsed.
    out.push(next.getTime() < Date.now() ? new Date() : next);
    cursor = new Date(next.getTime() + 1000);
  }
  return out;
}

function advance(from: Date, r: Routine): Date | null {
  if (r.schedule === "manual") return null;
  if (r.schedule === "hourly") {
    // +1h from the cursor, NOT snap-to-top-of-hour — matches the
    // runtime's nextFireAt math so the preview agrees with what'll
    // actually happen.
    const next = new Date(from);
    next.setHours(from.getHours() + 1);
    return next;
  }
  const parts = r.scheduleTime.split(":").map(Number);
  const h = parts[0] ?? NaN;
  const m = parts[1] ?? NaN;
  if (isNaN(h) || isNaN(m)) return null;
  const candidate = new Date(from);
  candidate.setDate(candidate.getDate() + 1);
  candidate.setHours(h, m, 0, 0);
  if (r.schedule === "weekdays") {
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
  } else if (r.schedule === "weekly") {
    const target = new Date(r.createdAt).getDay();
    while (candidate.getDay() !== target) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return candidate;
}

function PanelRow({ label, value, mono, icon }: {
  label: string; value: string; mono?: boolean; icon?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 8, minWidth: 0,
    }}>
      <span style={{
        fontSize: 11, color: "var(--c-dim)",
        flexShrink: 0,
      }}>{label}</span>
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 11.5, color: "var(--c-high)",
        fontFamily: mono ? "var(--font-mono)" : "inherit",
        fontWeight: 500,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        minWidth: 0,
      }}>
        {icon}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
      </span>
    </div>
  );
}

/* ── New-session config block ─────────────────────────────────────── */

function NewSessionConfig({
  projectPath, onProjectPathChange, recentPaths,
  provider, onProviderChange, modelId, onModelIdChange,
  effort, onEffortChange,
  useWorktree, onUseWorktreeChange,
  agentTemplate, onAgentTemplateChange,
}: {
  projectPath: string;
  onProjectPathChange: (p: string) => void;
  recentPaths: string[];
  provider: Provider;
  onProviderChange: (p: Provider) => void;
  modelId: string;
  onModelIdChange: (id: string) => void;
  effort: Effort;
  onEffortChange: (e: Effort) => void;
  useWorktree: boolean;
  onUseWorktreeChange: (v: boolean) => void;
  agentTemplate: string | null;
  onAgentTemplateChange: (id: string | null) => void;
}) {
  // Single model menu — same source + popover the Fleet composer uses, so the
  // routine inherits provider · model · effort from one click-through picker
  // instead of two disconnected dropdowns.
  const groups = useProviderGroups();
  const [pickerOpen, setPickerOpen] = useState(false);
  const { dispatchTool, label: modelLabel } = resolveModelChip(groups, provider, modelId);
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 12,
      padding: 12,
      background: "var(--sidebar)",
      border: "1px solid var(--sidebar-border)",
      borderRadius: 8,
    }}>
      <FolderPicker value={projectPath} onChange={onProjectPathChange} suggestions={recentPaths} />

      <Field label="Model">
        <div style={{ position: "relative" }}>
          <button
            type="button"
            // Read the closure value (NOT a functional updater): the picker's
            // own capture-phase outside-click already fired onClose by the time
            // this runs, so `!pickerOpen` lands on "closed" instead of toggling
            // back open. Mirrors the chat toolbar's model chip.
            onClick={() => setPickerOpen(!pickerOpen)}
            style={{
              width: "100%",
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "8px 10px",
              background: "var(--c-srf)",
              border: `1px solid ${pickerOpen ? "var(--c-brd2)" : "var(--sidebar-border)"}`,
              borderRadius: 7,
              color: "var(--c-high)",
              fontSize: 12.5, fontFamily: "inherit",
              cursor: "pointer", textAlign: "left",
            }}
          >
            <ProviderLogo tool={dispatchTool} size={14} />
            <span>{modelLabel}</span>
            <span style={{ color: "var(--c-dim)", fontSize: 11 }}>·</span>
            <span style={{ color: "var(--c-low)", fontSize: 11.5 }}>{effortLabel(effort)}</span>
            <ChevronDown size={13} style={{ color: "var(--c-dim)", marginLeft: "auto", flexShrink: 0 }} />
          </button>
          {pickerOpen && (
            <UnifiedModelPicker
              tool={provider}
              model={modelId}
              effort={effort}
              groups={groups}
              onPickModel={(groupId, mId) => {
                if (groupId === "auto") {
                  onProviderChange("auto");
                  onModelIdChange("auto");
                } else {
                  onProviderChange(resolveDispatchTool(groupId));
                  onModelIdChange(mId);
                }
              }}
              onPickEffort={(e) => onEffortChange(e)}
              onClose={() => setPickerOpen(false)}
              anchor="bottom"
            />
          )}
        </div>
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Checkbox
          checked={useWorktree}
          onChange={onUseWorktreeChange}
          label="Run in a git worktree"
          hint="Isolates the routine's changes from your working tree."
        />
      </div>

      <details style={{ marginTop: 2 }}>
        <summary style={{
          cursor: "pointer", listStyle: "none",
          fontSize: 11, color: "var(--c-low)",
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "3px 0",
          userSelect: "none",
        }}>
          <ChevronDown size={10} style={{ transition: "transform 0.15s" }} />
          Quick agent template {agentTemplate && <span style={{ color: "var(--c-high)" }}>· {agentLabel(agentTemplate)}</span>}
        </summary>
        <div style={{ marginTop: 8 }}>
          <AgentTemplateGrid value={agentTemplate} onChange={onAgentTemplateChange} />
        </div>
      </details>
    </div>
  );
}

function agentLabel(id: string): string {
  return AGENT_TEMPLATES.find(t => t.id === id)?.name ?? id;
}

/* ── Folder picker ───────────────────────────────────────────────── */

function FolderPicker({ value, onChange, suggestions }: {
  value: string; onChange: (v: string) => void;
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const browse = async () => {
    try {
      const api = (window as unknown as { electronAPI?: { openFolderDialog?: () => Promise<string | null> } }).electronAPI;
      const picked = await api?.openFolderDialog?.();
      if (picked) onChange(picked);
    } catch { /* ignore */ }
  };

  const filtered = useMemo(() => {
    if (!value) return suggestions;
    return suggestions.filter(s => s.toLowerCase().includes(value.toLowerCase()) && s !== value);
  }, [suggestions, value]);

  return (
    <Field label="Project folder" required>
      <div ref={wrapRef} style={{ position: "relative", display: "flex", gap: 6 }}>
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <input
            value={value}
            onChange={e => { onChange(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder="/Users/you/projects/myapp"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 11.5 }}
          />
          {open && filtered.length > 0 && (
            <div style={{
              position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)",
              maxHeight: 200, overflowY: "auto",
              background: "var(--popover)",
              border: "1px solid var(--c-brd2)",
              borderRadius: 7,
              padding: 3,
              zIndex: 20,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.18)",
            }}>
              {filtered.map(p => (
                <button
                  key={p}
                  onMouseDown={e => { e.preventDefault(); onChange(p); setOpen(false); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "6px 8px",
                    background: "transparent", border: "none", borderRadius: 5,
                    color: "var(--c-low)",
                    fontSize: 11, fontFamily: "var(--font-mono)",
                    cursor: "pointer",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-low)"; }}
                >{p}</button>
              ))}
            </div>
          )}
        </div>
        <button onClick={browse} style={{
          ...secondaryBtnStyle,
          padding: "5px 9px",
          gap: 5,
        }}>
          <FolderOpen size={11} />
          Browse
        </button>
      </div>
    </Field>
  );
}


/* ── Permission picker ───────────────────────────────────────────────
   Visual + interaction parity with chat-input's PermissionModePicker.
   Same trigger weight, same popover layout, same per-row hover. The
   only differences: it lives in a form footer (no toolbar context),
   and it persists into a routine record instead of patching a live
   session. Drift between this picker and the chat one will read as a
   bug, so keep them in sync. */
function PermissionPicker({ value, onChange, providerId }: {
  value: PermissionMode; onChange: (v: PermissionMode) => void; providerId: string | null | undefined;
}) {
  const { tiles: providerTiles } = useProvidersConfig();
  const modes = permissionModesFor(permissionCapabilityFor(providerTiles, providerId));
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Popover position is computed from the trigger's bounding rect and
  // pinned with position:fixed so it escapes ancestor clipping
  // (overflow:hidden / overflow:auto / radius-clipped containers). We
  // also flip the popover above/below depending on available space.
  const [popPos, setPopPos] = useState<{ top: number; left: number; placement: "up" | "down" } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Recompute position whenever the popover opens (and on scroll/resize
  // while open) so it stays pinned to the trigger. The stale popPos
  // value persists when closed — that's fine, we only render it when
  // `open` is true so the user never sees the stale frame.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const POPOVER_HEIGHT = 220;
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      const placement: "up" | "down" = spaceAbove >= POPOVER_HEIGHT || spaceAbove >= spaceBelow ? "up" : "down";
      const top = placement === "up" ? rect.top - 6 : rect.bottom + 6;
      const left = rect.right;
      setPopPos({ top, left, placement });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  if (modes.length === 0) return null;
  const trigger = permLabel(value, modes);
  const loud = isLoudMode(value);

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        title={`Permission mode: ${trigger}`}
        style={{
          padding: "3px 7px",
          border: "none", background: open ? "rgba(var(--fg-rgb), 0.05)" : "none",
          color: loud ? "#eab308" : "var(--c-low)",
          fontSize: 12, fontWeight: 600, cursor: "pointer",
          letterSpacing: "0.005em",
          borderRadius: 5,
          transition: "color 0.12s, background 0.12s",
          flexShrink: 0,
          fontFamily: "var(--font-sans)",
          outline: "none",
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = "rgba(var(--fg-rgb),0.05)"; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = "none"; }}
      >
        {trigger}
      </button>
      {open && popPos && (
        <div style={{
          position: "fixed",
          top: popPos.placement === "up" ? undefined : popPos.top,
          bottom: popPos.placement === "up" ? window.innerHeight - popPos.top : undefined,
          left: popPos.left,
          transform: "translateX(-100%)",
          minWidth: 240,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 8,
          padding: 4,
          boxShadow: popPos.placement === "up"
            ? "0 -8px 28px rgba(0,0,0,0.42)"
            : "0 8px 28px rgba(0,0,0,0.42)",
          zIndex: 9999,
          fontFamily: "var(--font-sans)",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "5px 9px 4px",
          }}>
            <span style={{ fontSize: 10.5, color: "var(--c-dim)", fontWeight: 500 }}>Mode</span>
          </div>
          {modes.map((m, i) => {
            const active = value === m.id;
            const loudRow = isLoudMode(m.id);
            return (
              <button
                key={m.id}
                onClick={() => { onChange(m.id as PermissionMode); setOpen(false); }}
                onMouseDown={e => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "5px 10px",
                  background: active ? "var(--c-srf)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  borderRadius: 5,
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--c-srf)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  color: loudRow && active ? "#eab308" : "var(--c-fg, var(--c-high))",
                }}>{m.label}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  {active && <Check size={10} style={{ color: "var(--c-dim)" }} />}
                  <span style={{
                    fontSize: 10.5, color: "var(--c-dim)",
                    fontFamily: "var(--font-mono)",
                  }}>{i + 1}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Agent template grid ─────────────────────────────────────────── */

function AgentTemplateGrid({ value, onChange }: {
  value: string | null; onChange: (id: string | null) => void;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
      gap: 6,
    }}>
      {AGENT_TEMPLATES.map(t => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(active ? null : t.id)}
            title={t.description}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "7px 9px",
              background: active ? "var(--c-srf2)" : "var(--c-srf)",
              border: "1px solid",
              borderColor: active ? "var(--c-brd2)" : "var(--sidebar-border)",
              borderRadius: 7,
              cursor: "pointer", textAlign: "left",
              fontFamily: "inherit",
              transition: "background 0.08s, border-color 0.08s",
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--c-srf2)"; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = "var(--c-srf)"; }}
          >
            <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }}>{t.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 11.5, fontWeight: 500, color: "var(--c-high)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{t.name}</div>
              <div style={{
                fontSize: 10, color: "var(--c-dim)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{t.description}</div>
            </div>
            {active && <Check size={10} style={{ color: "var(--c-high)", flexShrink: 0 }} />}
          </button>
        );
      })}
    </div>
  );
}

/* ── Session picker (resume mode) ────────────────────────────────── */

/* Session picker — renders rows in the exact same metrics as the
   sidebar AgentRow (provider logo · title · mono meta) so picking a
   session to resume reads like picking one to focus. The search field
   sits inline above the list with no surrounding card so the rows
   look like list items, not a contained widget. */
function SessionPicker({ sessions, selectedId, onSelect }: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sessions.filter(s =>
          s.title.toLowerCase().includes(q)
          || (s.project_path ?? "").toLowerCase().includes(q),
        )
      : sessions;
    return [...list].sort((a, b) => {
      const ta = Date.parse(a.last_accessed ?? a.created_at);
      const tb = Date.parse(b.last_accessed ?? b.created_at);
      return tb - ta;
    });
  }, [sessions, query]);

  if (sessions.length === 0) {
    return (
      <div style={{
        padding: "18px 14px",
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 8,
        textAlign: "center",
      }}>
        <div style={{ fontSize: 11.5, color: "var(--c-low)", marginBottom: 3 }}>
          No sessions to resume.
        </div>
        <div style={{ fontSize: 10.5, color: "var(--c-ghost)" }}>
          Create one from the sidebar first, then come back.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Inline search — same chrome the sidebar search overlay uses. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        padding: "5px 10px",
        marginBottom: 4,
        borderRadius: 8,
        background: "var(--c-srf)",
        border: "1px solid var(--c-brd)",
      }}>
        <Search size={12} style={{ color: "var(--c-ghost)", flexShrink: 0 }} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search sessions…"
          style={{
            flex: 1,
            background: "transparent",
            border: "none", outline: "none",
            color: "var(--foreground)",
            fontSize: 12.5, fontFamily: "inherit",
          }}
        />
        {query && (
          <button onClick={() => setQuery("")} style={{
            background: "none", border: "none", padding: 0,
            color: "var(--c-ghost)", cursor: "pointer",
            display: "flex",
          }}>
            <X size={12} />
          </button>
        )}
      </div>

      {/* List — borrows the sidebar AgentRow visual: status dot stand-in
          (provider logo here), title, meta. Padding matches the sidebar
          row so a chosen session reads at the same weight. */}
      <div style={{
        maxHeight: 240, overflowY: "auto",
        padding: "2px 0",
      }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: "14px 10px",
            fontSize: 11, color: "var(--c-ghost)", textAlign: "center",
          }}>
            No matches.
          </div>
        ) : filtered.map(s => {
          const active = s.id === selectedId;
          const project = folderName(s.project_path);
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "4px 9px",
                background: active ? "var(--c-srf2)" : "transparent",
                border: "none", borderRadius: 5,
                cursor: "pointer", textAlign: "left",
                fontFamily: "inherit",
                transition: "background 0.08s",
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--c-srf)"; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
            >
              <ProviderLogo tool={s.tool} size={11} />
              <span style={{
                flex: 1, minWidth: 0,
                fontSize: 12.5, fontWeight: active ? 500 : 400, lineHeight: "17px",
                color: active ? "var(--c-high)" : "var(--c-med)",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>{s.title}</span>
              <span style={{
                fontSize: 10.5, color: "var(--c-ghost)", flexShrink: 0,
                fontFamily: "var(--font-mono)", lineHeight: 1,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                maxWidth: 180,
              }}>{project || s.project_path}</span>
              {active && <Check size={10} style={{ color: "var(--c-low)", flexShrink: 0, marginLeft: 4 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Schedule pills ──────────────────────────────────────────────── */

function SchedulePills({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  return (
    <div style={{
      display: "inline-flex",
      padding: 2,
      background: "var(--sidebar)",
      border: "1px solid var(--sidebar-border)",
      borderRadius: 7,
      gap: 1,
    }}>
      {(["manual", "hourly", "daily", "weekdays", "weekly"] as Schedule[]).map(s => (
        <button
          key={s}
          onClick={() => onChange(s)}
          style={{
            padding: "4px 10px",
            background: value === s ? "var(--c-srf2)" : "transparent",
            color: value === s ? "var(--c-high)" : "var(--c-low)",
            border: "none", borderRadius: 5,
            cursor: "pointer",
            fontSize: 11.5, fontFamily: "inherit",
            fontWeight: value === s ? 500 : 400,
            transition: "background 0.08s, color 0.08s",
          }}
          onMouseEnter={e => { if (value !== s) e.currentTarget.style.color = "var(--c-high)"; }}
          onMouseLeave={e => { if (value !== s) e.currentTarget.style.color = "var(--c-low)"; }}
        >
          {scheduleLabel(s)}
        </button>
      ))}
    </div>
  );
}

/* ── Segmented tabs (generic) ────────────────────────────────────── */

function SegmentedTabs<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{
      display: "inline-flex",
      padding: 2,
      background: "var(--sidebar)",
      border: "1px solid var(--sidebar-border)",
      borderRadius: 7,
      gap: 1,
    }}>
      {options.map(o => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              padding: "5px 12px",
              background: active ? "var(--c-srf2)" : "transparent",
              color: active ? "var(--c-high)" : "var(--c-low)",
              border: "none", borderRadius: 5,
              cursor: "pointer",
              fontSize: 11.5, fontFamily: "inherit",
              fontWeight: active ? 500 : 400,
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.color = "var(--c-low)"; }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Checkbox ────────────────────────────────────────────────────── */

function Checkbox({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void;
  label: string; hint?: string;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        background: "none", border: "none",
        padding: 0, cursor: "pointer",
        textAlign: "left", fontFamily: "inherit",
      }}
    >
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 14, height: 14, borderRadius: 3,
        border: `1px solid ${checked ? "var(--c-med)" : "var(--c-ghost)"}`,
        background: checked ? "var(--c-med)" : "transparent",
        flexShrink: 0, marginTop: 1,
        transition: "background 0.08s, border-color 0.08s",
      }}>
        {checked && <Check size={9} style={{ color: "var(--card)" }} strokeWidth={3} />}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontSize: 12, color: "var(--c-high)", lineHeight: 1.35 }}>{label}</span>
        {hint && <span style={{ fontSize: 10.5, color: "var(--c-dim)", lineHeight: 1.35 }}>{hint}</span>}
      </span>
    </button>
  );
}

/* ── Layout primitives ───────────────────────────────────────────── */

function BackBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 8px 5px 6px",
        background: "transparent",
        border: "none", borderRadius: 5,
        color: "var(--c-med)",
        fontSize: 12.5, fontWeight: 500,
        fontFamily: "inherit",
        cursor: "pointer",
        marginBottom: 14,
        transition: "background 0.08s, color 0.08s",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
        (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
        (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
      }}
    >
      <ArrowLeft size={13} /> Back to Routines
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5, color: "var(--c-ghost)",
      marginBottom: 8,
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
    }}>
      {children}
    </div>
  );
}

/* Mirror of chat-input's Wand2 enhance button — same icon, same 22×22
   metrics, same blue-glow active state, same hover idiom. Lives here
   instead of being imported because chat-input's button is wired into
   that component's prop surface; abstracting it would be premature. */
function EnhanceButton({ busy, hasText, onClick }: {
  busy: boolean; hasText: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseDown={e => e.preventDefault()}
      disabled={busy || !hasText}
      title={busy ? "Enhancing…" : !hasText ? "Type a prompt to enhance" : `Enhance prompt (${formatShortcut(["Mod", "I"])})`}
      style={{
        width: 22, height: 22, borderRadius: 5, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: busy ? "rgba(96,165,250,0.10)" : "none",
        border: "none", outline: "none",
        cursor: (busy || !hasText) ? "default" : "pointer",
        color: busy
          ? "rgba(96, 165, 250, 0.95)"
          : hasText
            ? "var(--c-fg, var(--c-high))"
            : "var(--c-dim)",
        transition: "color 0.12s, background 0.12s",
      }}
      onMouseEnter={e => {
        if (!busy && hasText) {
          e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.08)";
        }
      }}
      onMouseLeave={e => {
        if (!busy) e.currentTarget.style.background = "none";
      }}
    >
      <Wand2 size={12} strokeWidth={1.75} />
    </button>
  );
}

function Field({ label, required, children }: {
  label: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div>
      <label style={labelStyle}>
        {label}
        {required && <span style={{ color: "#f87171", marginLeft: 4 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

/* "Local routines only run while your computer is awake" — used to be
   a permanent top banner. Lives inside the Schedule section now so it
   sits next to the control it conditions, and reads as either an info
   row (when the launch-at-startup setting is enabled) or a warning
   prompting the user to enable it.

   The launch-at-startup integration is best-effort: in Electron we
   probe the bridge for it; on the web/fallback path we show the
   neutral info copy and skip the warning state. */
function AwakeNotice() {
  const [launchOnStart, setLaunchOnStart] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = (window as unknown as {
      electronAPI?: { getLaunchOnStart?: () => Promise<boolean> };
    }).electronAPI;
    const probe = api?.getLaunchOnStart
      ? api.getLaunchOnStart().catch((): boolean | null => null)
      : Promise.resolve<boolean | null>(null);
    void probe.then(v => { if (!cancelled) setLaunchOnStart(v); });
    return () => { cancelled = true; };
  }, []);

  const openSettings = () => window.dispatchEvent(new CustomEvent("fleet:open-settings", { detail: { tab: "General" } }));
  const warn = launchOnStart === false;

  return (
    <div style={{
      marginTop: 12,
      display: "flex", alignItems: "flex-start", gap: 9,
      padding: "8px 11px",
      background: warn ? "rgba(251,146,60,0.08)" : "var(--sidebar)",
      border: `1px solid ${warn ? "rgba(251,146,60,0.30)" : "var(--sidebar-border)"}`,
      borderRadius: 7,
      fontSize: 11.5, color: warn ? "#fdba74" : "var(--c-low)",
      lineHeight: 1.45,
    }}>
      {warn
        ? <ShieldCheck size={12} style={{ color: "#fb923c", flexShrink: 0, marginTop: 1 }} />
        : <Info size={12} style={{ color: "var(--c-dim)", flexShrink: 0, marginTop: 1 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        {warn ? (
          <>
            <span>Fleet isn't set to launch on login — scheduled routines won't fire if the app isn't running.</span>
            <button
              onClick={openSettings}
              style={{
                background: "none", border: "none", padding: 0,
                marginLeft: 6,
                color: "#fdba74", cursor: "pointer", textDecoration: "underline",
                fontSize: "inherit", fontFamily: "inherit", fontWeight: 500,
              }}
            >Enable in Settings</button>
          </>
        ) : (
          <span>Local routines only run while Fleet is open. For always-on schedules, enable launch on login.</span>
        )}
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function scheduleLabel(s: Schedule): string {
  switch (s) {
    case "manual":   return "Manual";
    case "hourly":   return "Hourly";
    case "daily":    return "Daily";
    case "weekdays": return "Weekdays";
    case "weekly":   return "Weekly";
  }
}

function scheduleSummary(r: Routine): string {
  if (r.schedule === "manual") return "Manual";
  if (r.schedule === "hourly") return "Hourly";
  const t = formatTime(r.scheduleTime);
  if (r.schedule === "daily")    return `Daily at ${t}`;
  if (r.schedule === "weekdays") return `Weekdays at ${t}`;
  if (r.schedule === "weekly")   return `Weekly at ${t}`;
  return "—";
}

/* Compute the next firing time for a routine in human-readable form.
   Best-effort: manual returns em-dash, hourly snaps to top of next
   hour, daily/weekdays/weekly project today's local time onto
   tomorrow if it's already past. */
function nextRunLabel(r: Routine, runs: RoutineRun[]): string {
  if (r.schedule === "manual") return "—";
  if (!isEnabled(r)) return "paused";
  const last = lastRunFor(r.id, runs);
  const next = nextFireAt(r, last);
  if (!next) return "—";
  if (next.getTime() <= Date.now()) return "now";
  return formatRelative(next);
}

/* Compact "in 1h 12m" / "tomorrow 9:00" / "in 3d" formatting. */
function formatRelative(when: Date): string {
  const diff = when.getTime() - Date.now();
  if (diff < 0) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hrs < 24) return `in ${hrs}h ${remMin}m`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return `tomorrow ${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")}`;
  return `in ${days}d`;
}

function formatTime(hhmm: string): string {
  const parts = hhmm.split(":").map(Number);
  const h = parts[0] ?? NaN;
  const m = parts[1] ?? NaN;
  if (isNaN(h) || isNaN(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function toKebabName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* ── Style recipes ───────────────────────────────────────────────── */

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11, color: "var(--c-low)",
  marginBottom: 5, fontWeight: 500,
  letterSpacing: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  padding: "7px 10px",
  background: "var(--c-srf)",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-high)",
  fontSize: 12, fontFamily: "inherit",
  outline: "none",
};

const pillBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "5px 10px",
  background: "var(--c-srf2)",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-high)",
  fontSize: 11.5, fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "background 0.08s, border-color 0.08s",
  lineHeight: 1,
  height: 26,
};

const secondaryBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "5px 10px",
  background: "transparent",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-med)",
  fontSize: 11.5, fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "background 0.08s, color 0.08s",
  lineHeight: 1,
  height: 26,
};

const inlineLinkStyle: React.CSSProperties = {
  background: "none", border: "none", padding: 0,
  color: "var(--c-high)", cursor: "pointer",
  fontFamily: "inherit", fontSize: "inherit",
  fontWeight: 500,
  display: "inline-flex", alignItems: "center", gap: 4,
};
