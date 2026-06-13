import { useState, useEffect, useRef } from "react";
import { X, FolderOpen, Clock, ChevronDown, Check, Sparkles, Wand2 } from "lucide-react";
import { ClaudeLogo, OpenAILogo, GeminiLogo, KimiLogo } from "@/components/ui/provider-logo";
import { createSession, fetchClaudeSessions, fetchGeminiSessions, fetchCodexSessions, apiFetch, type ClaudeSession } from "@/lib/api";
import { providers as providersApi, type AccountInfo } from "@/lib/providers-api";
import { useAppStore } from "@/stores/app-store";
import { useRouterConfig } from "@/hooks/use-router-config";
import { RoutersStatusBar } from "@/components/settings/routers/routers-status-bar";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { permissionCapabilityFor, permissionModesFor } from "@/lib/capabilities";

interface PluginTemplate {
  name: string; title: string; description: string;
  preferred_tier: "fastest" | "balanced" | "most_capable";
  permission_mode: string; system_prompt: string;
  providers: string[]; mcp_servers: string[]; plugin: string; tags: string[];
}

const TIER_TO_MODEL: Record<string, Record<string, string>> = {
  "claude-code": {
    fastest: "claude-haiku-4-5-20251001",
    balanced: "claude-sonnet-4-6",
    most_capable: "claude-opus-4-8",
  },
  codex: {
    fastest: "gpt-5.2",
    balanced: "gpt-5.4",
    most_capable: "gpt-5.5",
  },
  gemini: {
    fastest: "gemini-3.1-flash-lite-preview",
    balanced: "gemini-3.1-pro-preview",
    most_capable: "gemini-3.1-pro-preview",
  },
};

interface Props { onClose: () => void; }
export { NewAgentView as NewAgentDialog };

// Built-in agent templates. These render as a quick-pick grid above the
// Project section. When a plugin contributes templates via /api/runtime/templates,
// they appear in the "Start from template" combobox alongside (separate UI).
//
// `agentTemplate` (when set) is sent to the backend as `agent_template`
// on session create. The backend resolves it to a domain-specific system
// prompt + MCP toolset (see backend/app/services/builtin_templates.py).
// Templates without `agentTemplate` are pure UX presets — they only
// configure provider/model/name on the frontend, no backend wiring.
const AGENT_TEMPLATES = [
  {
    id: "reverse-engineer",
    icon: "🔬",
    name: "Reverse Engineer",
    description: "Login endpoint discovery, JS bundle analysis, proxy support",
    provider: "claude-code",
    model: "claude-opus-4-8",
    systemPromptHint: "You are a web reverse-engineering specialist with proxied fetch + JS analysis tools.",
    // Maps to backend BuiltinTemplate id — unlocks the fleet_reveng MCP
    // server (fetch_url / discover_assets / find_endpoints / save_asset).
    agentTemplate: "reverse_engineering",
    permissionMode: "acceptEdits",
  },
  {
    id: "scraper",
    icon: "🕷️",
    name: "Web Scraper",
    description: "Scrapes websites, extracts structured data",
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    systemPromptHint: "You are a web scraping specialist. Extract structured data from websites efficiently.",
  },
  {
    id: "code-review",
    icon: "🔍",
    name: "Code Reviewer",
    description: "Reviews code for bugs, style, security",
    provider: "claude-code",
    model: "claude-opus-4-8",
    systemPromptHint: "You are an expert code reviewer. Analyze code for bugs, security vulnerabilities, and improvement opportunities.",
  },
  {
    id: "research",
    icon: "📚",
    name: "Researcher",
    description: "Deep research, report generation",
    provider: "claude-code",
    model: "claude-opus-4-8",
    systemPromptHint: "You are a research specialist. Conduct thorough research and produce structured, cited reports.",
  },
  {
    id: "qa",
    icon: "✅",
    name: "QA Engineer",
    description: "Writes and runs tests, finds bugs",
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    systemPromptHint: "You are a QA engineer. Write comprehensive tests, identify edge cases, and ensure software quality.",
  },
  {
    id: "devops",
    icon: "⚙️",
    name: "DevOps Agent",
    description: "CI/CD, deployments, infrastructure",
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    systemPromptHint: "You are a DevOps specialist. Manage deployments, CI/CD pipelines, and infrastructure.",
  },
  {
    id: "data-analyst",
    icon: "📊",
    name: "Data Analyst",
    description: "Analyzes data, generates insights",
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    systemPromptHint: "You are a data analyst. Process datasets, identify patterns, and generate actionable insights.",
  },
  {
    id: "writer",
    icon: "✍️",
    name: "Technical Writer",
    description: "Docs, READMEs, API references",
    provider: "claude-code",
    model: "claude-haiku-4-5-20251001",
    systemPromptHint: "You are a technical writer. Create clear, accurate documentation and developer guides.",
  },
  {
    id: "custom",
    icon: "🎨",
    name: "Custom",
    description: "Start from scratch",
    provider: null,
    model: null,
    systemPromptHint: "",
  },
] as const;

type TemplateId = typeof AGENT_TEMPLATES[number]["id"];

const PROVIDERS = [
  { id: "claude-code", name: "Claude Code", icon: ClaudeLogo, models: [
    { id: "claude-opus-4-8",          label: "Opus 4.8",   desc: "Most capable" },
    { id: "claude-sonnet-4-6",         label: "Sonnet 4.6", desc: "Balanced", default: true },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5",  desc: "Fastest" },
  ]},
  { id: "codex-cli",  name: "Codex",  icon: OpenAILogo, models: [
    { id: "gpt-5.2", label: "GPT-5.2", desc: "Fastest" },
    { id: "gpt-5.4", label: "GPT-5.4", desc: "Balanced", default: true },
    { id: "gpt-5.5", label: "GPT-5.5", desc: "Capable"  },
  ]},
  { id: "gemini-cli", name: "Gemini", icon: GeminiLogo, models: [
    { id: "gemini-3.1-pro-preview",        label: "3.1 Pro",  desc: "Best",    default: true },
    { id: "gemini-3-flash-preview",        label: "3 Flash",  desc: "Fast"    },
    { id: "gemini-3.1-flash-lite-preview", label: "3.1 Lite", desc: "Fastest" },
  ]},
  // Kimi Code CLI (Moonshot). Tier mapping aligns with the capability-
  // matrix entry in config/agents.toml — fast → k1.5-preview, balanced
  // → k2-instruct (default), max → k2-thinking.
  { id: "kimi-code", name: "Kimi", icon: KimiLogo, models: [
    { id: "kimi-k1.5-preview",  label: "K1.5 Preview",  desc: "Fast"     },
    { id: "kimi-k2-instruct",   label: "K2 Instruct",   desc: "Balanced", default: true },
    { id: "kimi-k2-thinking",   label: "K2 Thinking",   desc: "Most capable" },
  ]},
];

function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** True when starting an *off-worktree* session would collide with an
 *  existing session already occupying the same folder's working tree.
 *  Off-worktree sessions work in `project_path` directly, so only one can
 *  own a folder at a time (mirrors the local-folder rule, and applies to
 *  reused clones too). `worktree_path` is null/empty for off-worktree
 *  sessions; on-worktree sessions are isolated and never conflict. */
export function hasOffWorktreeConflict(
  path: string,
  useWorktree: boolean,
  sessions: { project_path: string; worktree_path: string | null }[],
): boolean {
  if (useWorktree) return false;
  const p = path.trim();
  if (!p) return false;
  return sessions.some(s => (s.project_path ?? "").trim() === p && !s.worktree_path);
}

export function NewAgentView({ onClose }: Props) {
  const { addSession, setActiveSession, sessions, staffSessionId } = useAppStore();
  const [provider,  setProvider]  = useState("claude-code");
  const [modelId,   setModelId]   = useState("claude-sonnet-4-6");
  const [name,      setName]      = useState("");
  // Per-session git isolation. Default mirrors the app-store default
  // (`use_worktree=true`) so parallel sessions don't stomp on each other.
  // Task 14 wires this into the createSession payload and adds a
  // `folderInGit` pre-check; for now the value is local state only.
  const [useWorktree, setUseWorktree] = useState(true);
  // Built-in template grid selection. "custom" = no template applied.
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>("custom");
  const agentSessions = sessions.filter(s => s.id !== staffSessionId);
  const [path,      setPath]      = useState(agentSessions[0]?.project_path ?? "");
  const [perm,      setPerm]      = useState("default");
  const [mode,      setMode]      = useState("new");
  const [resumeId,  setResumeId]  = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [showSug,   setShowSug]   = useState(false);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [sessLoading,    setSessLoading]    = useState(false);
  const [sessionCount,   setSessionCount]   = useState(0);
  const [showModel,      setShowModel]      = useState(false);
  // Multi-account: which login/key this session uses (null ⇒ System / default).
  const [accounts,  setAccounts]  = useState<AccountInfo[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const pathRef    = useRef<HTMLInputElement>(null);
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelRef   = useRef<HTMLDivElement>(null);
  const [templates, setTemplates] = useState<PluginTemplate[]>([]);
  const [showTpl, setShowTpl] = useState(false);
  const [selectedTpl, setSelectedTpl] = useState<PluginTemplate | null>(null);
  const tplRef = useRef<HTMLDivElement>(null);
  // Probe whether the selected folder is already a git repo. Null = unknown
  // (no folder yet, probe in flight, or probe failed); true/false drives the
  // "will initialize" hint inside <WorktreeToggle>.
  const [pathIsGit, setPathIsGit] = useState<boolean | null>(null);
  // Capability-driven permission modes. Tiles come from the shared
  // providers-config store (same source as the composer/toolbar pickers).
  const { tiles: providerTiles } = useProvidersConfig();

  // Provider-router master toggle + the currently active decision router
  // (the tile flagged `active_for_decision: true`). When the master is on
  // we collapse the agent/model picker behind a "🪄 Auto-routing enabled"
  // banner and let the backend's orchestrator pick on the first turn.
  // Power users can still pin manually by expanding the override.
  const { tiles: routerTiles, masterEnabled: routingMasterEnabled } = useRouterConfig();
  const activeDecisionRouter = routerTiles.find(t => t.active_for_decision);
  // When routing is on we default to "auto" — the picker is hidden and the
  // backend resolves the decision. Toggling the override surfaces the
  // original provider/model picker so the user can pin a specific agent.
  const [overrideAgent, setOverrideAgent] = useState(false);
  // Show picker if routing is OFF (original UX) OR the user has explicitly
  // expanded the override. New sessions started while routing is enabled
  // default to "no pick" — the create payload omits explicit tool/model
  // and the backend's first turn calls `resolve_routing_for_turn` (Task 16).
  const showAgentPicker = !routingMasterEnabled || overrideAgent;

  // Seed the Folder field on open. Priority:
  //   1. Default workspace folder from Settings → General — an explicit
  //      user choice, so it wins over the auto-derived defaults below.
  //   2. Most-recent agent session's folder (the useState seed above).
  //   3. The app's project root.
  // Runs once on open (before the input is focused), so it never clobbers
  // anything the user has typed.
  useEffect(() => {
    let cancelled = false;
    const w = window as Window & {
      electronAPI?: {
        getConfig?: () => Promise<{ defaultFolder?: string } | null>;
        getProjectRoot?: () => Promise<string>;
      };
    };
    (async () => {
      try {
        const def = (await w.electronAPI?.getConfig?.())?.defaultFolder?.trim();
        if (def) { if (!cancelled) setPath(def); return; }
      } catch { /* fall through to the auto-derived default */ }
      try {
        const root = await w.electronAPI?.getProjectRoot?.();
        // Only fill when still empty so the recent-session seed stands.
        if (root && !cancelled) setPath(prev => prev || root);
      } catch { /* best effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!path) { setPathIsGit(null); return; }
    let cancelled = false;
    const w = window as unknown as {
      electronAPI?: { getGitContext?: (f: string) => Promise<{ branch: string | null }> };
    };
    w.electronAPI?.getGitContext?.(path).then(c => {
      if (!cancelled) setPathIsGit(!!c?.branch);
    }).catch(() => { if (!cancelled) setPathIsGit(false); });
    return () => { cancelled = true; };
  }, [path]);
  // Load active plugin templates for the picker
  useEffect(() => {
    const u = path ? `?project_path=${encodeURIComponent(path)}` : "";
    apiFetch(`/api/runtime/templates${u}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: PluginTemplate[]) => setTemplates(data || []))
      .catch(() => setTemplates([]));
  }, [path]);
  // Close template popover on outside click
  useEffect(() => {
    if (!showTpl) return;
    const h = (e: MouseEvent) => {
      if (!tplRef.current?.contains(e.target as Node)) setShowTpl(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showTpl]);
  useEffect(() => { setTimeout(() => pathRef.current?.focus(), 80); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h); return () => document.removeEventListener("keydown", h);
  }, [onClose]);
  useEffect(() => {
    if (!showModel) return;
    const h = (e: MouseEvent) => { if (!modelRef.current?.contains(e.target as Node)) setShowModel(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [showModel]);
  // Load the selected provider's accounts; preselect its default (null = System).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await providersApi.listAccounts(provider);
      if (cancelled) return;
      setAccounts(list);
      // Default to "follow main" (null) — the session then dynamically uses the
      // provider's current main account, so changing the main updates it too.
      // The user can pin a specific account from the dropdown if they want.
      setAccountId(null);
    })();
    return () => { cancelled = true; };
  }, [provider]);
  useEffect(() => {
    if (!path.trim() || !["claude-code","gemini-cli","codex-cli"].includes(provider)) {
      setClaudeSessions([]); setSessionCount(0); return;
    }
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    fetchTimer.current = setTimeout(async () => {
      setSessLoading(true);
      try {
        const fn = provider === "gemini-cli" ? fetchGeminiSessions : provider === "codex-cli" ? fetchCodexSessions : fetchClaudeSessions;
        const r = await fn(path.trim());
        setClaudeSessions(r); setSessionCount(r.length); setResumeId(null);
      } catch { setClaudeSessions([]); setSessionCount(0); }
      finally { setSessLoading(false); }
    }, 400);
    return () => { if (fetchTimer.current) clearTimeout(fetchTimer.current); };
  }, [path, provider]);

  const recent = Array.from(new Set(agentSessions.map(s => s.project_path).filter(Boolean))).slice(0, 6) as string[];
  const sug = recent.filter(p => !path || p.toLowerCase().includes(path.toLowerCase()));

  // Filter out system stdout leaks and empty summaries
  const validSessions = claudeSessions.filter(s =>
    s.summary &&
    !s.summary.includes("<local-command-stdout>") &&
    !s.summary.toLowerCase().startsWith("no conversations found") &&
    s.summary.trim().length > 0
  );

  const changeProvider = (pid: string) => {
    setProvider(pid);
    const p = PROVIDERS.find(p => p.id === pid)!;
    const def = p.models.find(m => m.default) ?? p.models[0];
    if (def) setModelId(def.id);
    // Reset perm to the first available mode for the new provider if the
    // current selection won't be in the new list.
    const newModes = permissionModesFor(permissionCapabilityFor(providerTiles, pid));
    if (newModes.length > 0 && !newModes.some(m => m.id === perm)) {
      const preferred = newModes.find(m => m.id === "default") ?? newModes[0];
      if (preferred) setPerm(preferred.id);
    }
    // If a template is selected, re-resolve the tier→model for the new provider
    if (selectedTpl) {
      const m = TIER_TO_MODEL[pid]?.[selectedTpl.preferred_tier];
      if (m) setModelId(m);
    }
  };

  const applyTemplate = (tpl: PluginTemplate) => {
    setSelectedTpl(tpl);
    setShowTpl(false);
    // Pick the first compatible provider; default to claude if available.
    const preferred = tpl.providers.includes(provider) ? provider :
      tpl.providers.includes("claude-code") ? "claude-code" :
      tpl.providers[0] ?? "claude-code";
    setProvider(preferred);
    const tierModel = TIER_TO_MODEL[preferred]?.[tpl.preferred_tier];
    if (tierModel) setModelId(tierModel);
    if (tpl.permission_mode) setPerm(tpl.permission_mode);
    if (!name.trim()) setName(tpl.title || tpl.name);
  };

  const clearTemplate = () => {
    setSelectedTpl(null);
    const p = PROVIDERS.find(p => p.id === provider)!;
    const def = p.models.find(m => m.default) ?? p.models[0];
    if (def) setModelId(def.id);
  };

  // Apply a built-in template (separate from the plugin combobox).
  // Plugin templates use `applyTemplate(tpl: PluginTemplate)`; built-ins use this.
  const applyBuiltinTemplate = (templateId: TemplateId) => {
    setSelectedTemplate(templateId);
    if (templateId === "custom") return;
    const tpl = AGENT_TEMPLATES.find(t => t.id === templateId)!;
    setName(tpl.name);
    if (tpl.provider && tpl.model) {
      const prov = PROVIDERS.find(p => p.id === tpl.provider);
      if (prov) {
        setProvider(tpl.provider);
        const modelExists = prov.models.some(m => m.id === tpl.model);
        if (modelExists) {
          setModelId(tpl.model);
        } else {
          const def = prov.models.find(m => m.default) ?? prov.models[0];
          if (def) setModelId(def.id);
        }
      }
    }
    // Templates that ship a backend system prompt (Reverse Engineer etc)
    // also know which permission mode they need to actually function —
    // RE makes lots of HTTP calls and would be unusable with per-call
    // prompts, so it ships acceptEdits. The user can still override.
    if ("permissionMode" in tpl && tpl.permissionMode) {
      setPerm(tpl.permissionMode);
    }
  };

  const browse = async () => {
    const w = window as Window & { electronAPI?: { openFolderDialog?: () => Promise<string | null> } };
    if (w.electronAPI?.openFolderDialog) {
      try { const p = await w.electronAPI.openFolderDialog(); if (p) { setPath(p); setShowSug(false); } return; } catch {}
    }
    alert("Folder picker unavailable — type the full path manually.");
  };

  const launch = async () => {
    if (!path.trim()) return;
    setLoading(true);
    try {
      // Resolve agent_template from either the built-in grid (selectedTemplate)
      // or a plugin/library template (selectedTpl). The backend resolver
      // (services::templates::resolve) maps the id — a builtin id OR a plugin/
      // library template name — to its system prompt + MCP servers at spawn.
      const builtinTpl = AGENT_TEMPLATES.find(t => t.id === selectedTemplate);
      const builtinAgentTemplate =
        builtinTpl && "agentTemplate" in builtinTpl
          ? (builtinTpl.agentTemplate as string | undefined)
          : undefined;

      const s = await createSession({
        title: name.trim() || "New agent", project_path: path.trim(),
        tool: provider, model_name: modelId, permission_mode: perm,
        session_mode: mode, claude_session_id: mode === "resume" && resumeId ? resumeId : undefined,
        agent_template: builtinAgentTemplate ?? selectedTpl?.name,
        use_worktree: useWorktree,
        account_id: accountId ?? undefined,
      });
      addSession(s); setActiveSession(s.id); onClose();
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  // Block a 2nd off-worktree session on a folder already owned by a live
  // off-worktree session — one-click "Enable isolated workspace" clears it.
  const offWorktreeConflict = hasOffWorktreeConflict(path, useWorktree, agentSessions);
  const canLaunch = !!path.trim() && (mode !== "resume" || !!resumeId) && !offWorktreeConflict;
  const curProv   = PROVIDERS.find(p => p.id === provider)!;
  const curModel  = curProv.models.find(m => m.id === modelId) ?? curProv.models[0]!;

  // Derive the selectable permission modes from the provider's capability
  // descriptor. `permissionCapabilityFor` looks up the tile for `provider`
  // and falls back to HTTP-agentic modes when the tile isn't loaded yet.
  const permModes = permissionModesFor(permissionCapabilityFor(providerTiles, provider));

  return (
    <>
      <style>{`
        @keyframes naFade  { from{opacity:0} to{opacity:1} }
        @keyframes naSlide { from{opacity:0;transform:translateY(10px) scale(.97)} to{opacity:1;transform:none} }
        .na-bd { animation:naFade  .2s ease both; }
        .na-md { animation:naSlide .22s cubic-bezier(.22,1,.36,1) both; }

        .na-inp {
          width:100%; height:32px; padding:0 10px; border-radius:6px; box-sizing:border-box;
          border:1px solid var(--c-brd2); background:var(--c-srf);
          color:var(--foreground); font-size:12.5px; font-family:inherit; outline:none;
          transition:border-color .15s, box-shadow .15s;
        }
        .na-inp:focus { border-color:var(--foreground); box-shadow:0 0 0 2px rgba(255,255,255,0.05); }
        .na-inp::placeholder { color:var(--c-ghost); opacity:1; }
        .na-inp-mono { font-family:var(--font-mono); font-size:11.5px; }

        .na-prov {
          flex:1; display:flex; align-items:center; justify-content:center; gap:6px;
          height:28px; border-radius:5px; border:none; background:none;
          cursor:pointer; font-size:12px; font-family:inherit; color:var(--c-dim);
          transition:background .1s, color .1s;
        }
        .na-prov.on { background:var(--c-srf2); color:var(--foreground); font-weight:500; box-shadow:0 1px 3px rgba(0,0,0,0.3); }
        .na-prov:not(.on):hover { color:var(--c-med); }

        .na-seg-wrap {
          display:flex; gap:1px; padding:3px;
          background:var(--c-srf); border-radius:8px; border:1px solid var(--c-brd);
        }
        .na-seg {
          flex:1; height:26px; border-radius:5px; border:none; background:none;
          color:var(--c-dim); font-size:11.5px; cursor:pointer; font-family:inherit;
          transition:background .1s, color .1s;
        }
        .na-seg.on { background:var(--c-srf2); color:var(--foreground); font-weight:500; box-shadow:0 1px 3px rgba(0,0,0,0.3); }
        .na-seg:not(.on):hover { color:var(--c-med); }

        .na-sess-item {
          display:flex; align-items:center; gap:10px; width:100%; padding:9px 12px;
          background:none; border:none; border-top:1px solid var(--c-brd);
          cursor:pointer; text-align:left; transition:background .1s;
        }
        .na-sess-item:first-child { border-top:none; }
        .na-sess-item:hover { background:var(--c-srf); }
        .na-sess-item.sel { background:var(--c-srf); }

        .na-perm-row {
          display:flex; align-items:flex-start; gap:10px; padding:8px 10px;
          background:none; border:none; border-radius:7px;
          cursor:pointer; text-align:left; width:100%; transition:background .1s;
        }
        .na-perm-row:hover { background:var(--c-srf); }
        .na-perm-row.sel { background:var(--c-srf); }

        .na-sug-item {
          display:flex; align-items:center; gap:7px; width:100%; padding:7px 10px;
          background:none; border:none; border-top:1px solid var(--c-brd);
          cursor:pointer; font-size:11.5px; font-family:var(--font-mono);
          color:var(--c-low); text-align:left; transition:background .1s;
        }
        .na-sug-item:first-child { border-top:none; }
        .na-sug-item:hover { background:var(--c-srf); color:var(--c-med); }

        .na-model-opt {
          display:flex; align-items:center; justify-content:space-between; width:100%;
          padding:9px 12px; background:none; border:none; border-top:1px solid var(--c-brd);
          cursor:pointer; text-align:left; transition:background .1s;
        }
        .na-model-opt:first-child { border-top:none; }
        .na-model-opt:hover { background:var(--c-srf); }

        .na-browse {
          height:32px; padding:0 11px; border-radius:6px; flex-shrink:0;
          border:1px solid var(--c-brd2); background:var(--c-srf);
          color:var(--c-med); cursor:pointer; display:flex; align-items:center;
          gap:5px; font-size:12px; font-family:inherit; transition:all .1s; white-space:nowrap;
        }
        .na-browse:hover { background:var(--c-srf2); color:var(--foreground); }

        .na-launch {
          height:32px; padding:0 20px; border-radius:6px; border:none;
          background:var(--foreground);
          color:var(--background);
          font-size:12.5px; font-weight:600; font-family:inherit;
          cursor:pointer; letter-spacing:0.01em;
          transition:opacity .15s, transform .15s;
        }
        .na-launch:hover:not(:disabled) { opacity:.85; transform:translateY(-1px); }
        .na-launch:active:not(:disabled) { transform:translateY(0); opacity:.9; }
        .na-launch:disabled { background:var(--c-srf2); color:var(--c-ghost); cursor:not-allowed; transform:none; }

        .na-tpl-grid {
          display:grid; grid-template-columns:repeat(4, 1fr); gap:6px;
          margin-top:10px; margin-bottom:20px;
        }
        .na-tpl-card {
          display:flex; flex-direction:column; align-items:flex-start; gap:3px;
          padding:8px 9px; border-radius:8px;
          border:1px solid var(--c-brd); background:transparent;
          cursor:pointer; text-align:left; font-family:inherit;
          transition:background .12s, border-color .12s;
        }
        .na-tpl-card:hover:not(.na-tpl-card--sel) {
          background:var(--c-srf); border-color:var(--c-brd2);
        }
        .na-tpl-card--sel {
          background:var(--c-srf); border-color:var(--c-brd2);
          box-shadow:0 0 0 1px var(--c-brd2);
        }
        .na-tpl-icon { font-size:18px; line-height:1; margin-bottom:2px; }
        .na-tpl-name { font-size:11.5px; font-weight:600; color:var(--foreground); line-height:1.2; }
        .na-tpl-desc { font-size:10.5px; color:var(--c-ghost); line-height:1.35; }
      `}</style>

      {/* Backdrop */}
      <div className="na-bd" onClick={onClose} style={{
        position:"fixed", inset:0, zIndex:900,
        background:"rgba(0,0,0,0.65)",
        backdropFilter:"blur(8px)", WebkitBackdropFilter:"blur(8px)",
      }} />

      {/* Center wrapper */}
      <div style={{ position:"fixed", inset:0, zIndex:901, display:"flex", alignItems:"center", justifyContent:"center", pointerEvents:"none" }}>
        <div className="na-md" style={{
          pointerEvents:"auto", width:480, maxHeight:"88vh",
          display:"flex", flexDirection:"column",
          background:"var(--card)",
          border:"1px solid var(--c-brd2)",
          borderRadius:14, overflow:"hidden",
          boxShadow:"0 32px 80px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.03)",
        }}>

          {/* Header */}
          <div style={{ padding:"18px 20px 15px", borderBottom:"1px solid var(--c-brd)", flexShrink:0 }}>
            <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between" }}>
              <div>
                <div style={{
                  fontFamily:"'Playfair Display Variable', Georgia, serif",
                  fontSize:21, fontWeight:500,
                  color:"var(--foreground)", letterSpacing:"0.01em", lineHeight:1.2,
                }}>
                  New Agent
                </div>
                <div style={{ fontSize:11.5, color:"var(--c-dim)", marginTop:3, lineHeight:1.4 }}>
                  Configure provider, model, and session
                </div>
              </div>
              <button onClick={onClose}
                style={{ width:28, height:28, borderRadius:6, border:"1px solid var(--c-brd)", background:"var(--c-srf)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--c-dim)", padding:0, marginTop:2, flexShrink:0, transition:"all .1s" }}
                onMouseEnter={e => { e.currentTarget.style.background="var(--c-srf2)"; e.currentTarget.style.color="var(--foreground)"; e.currentTarget.style.borderColor="var(--c-brd2)"; }}
                onMouseLeave={e => { e.currentTarget.style.background="var(--c-srf)";  e.currentTarget.style.color="var(--c-dim)";        e.currentTarget.style.borderColor="var(--c-brd)"; }}>
                <X size={13}/>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="scroll-subtle" style={{ flex:1, overflowY:"auto", padding:"20px", display:"flex", flexDirection:"column" }}>

            {/* ── Templates (from plugins) ── */}
            {templates.length > 0 && (
              <>
                <SecHead>Start from template</SecHead>
                <div ref={tplRef} style={{ position: "relative", marginTop: 10, marginBottom: 20 }}>
                  <button
                    onClick={() => setShowTpl(s => !s)}
                    style={{
                      width: "100%", height: 36, padding: "0 12px",
                      display: "flex", alignItems: "center", gap: 8,
                      background: "var(--c-srf)", border: "1px solid var(--c-brd2)",
                      borderRadius: 6, color: "var(--foreground)",
                      fontSize: 12.5, fontFamily: "inherit", cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <Sparkles size={13} style={{ color: "var(--c-low)" }} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedTpl ? selectedTpl.title : `Choose a template (${templates.length} available)`}
                    </span>
                    {selectedTpl && (
                      <span
                        onClick={(e) => { e.stopPropagation(); clearTemplate(); }}
                        style={{
                          fontSize: 10, color: "var(--c-dim)", cursor: "pointer",
                          padding: "2px 6px", borderRadius: 4, background: "var(--c-bg)",
                        }}
                      >Clear</span>
                    )}
                    <ChevronDown size={12} style={{ color: "var(--c-dim)" }} />
                  </button>
                  {showTpl && (
                    <div style={{
                      position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)",
                      zIndex: 30, maxHeight: 320, overflowY: "auto",
                      background: "var(--card)", border: "1px solid var(--c-brd2)",
                      borderRadius: 8, padding: 4,
                      boxShadow: "0 12px 32px rgba(0,0,0,0.65)",
                    }}>
                      {templates.map(tpl => (
                        <button
                          key={tpl.plugin + ":" + tpl.name}
                          onClick={() => applyTemplate(tpl)}
                          style={{
                            width: "100%", padding: "8px 10px",
                            display: "flex", flexDirection: "column", gap: 2,
                            background: "none", border: "none", borderRadius: 6,
                            cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 12.5, color: "var(--c-high)", fontWeight: 500 }}>
                              {tpl.title}
                            </span>
                            <span style={{ fontSize: 10, color: "var(--c-dim)" }}>· from {tpl.plugin}</span>
                          </div>
                          {tpl.description && (
                            <div style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.4 }}>
                              {tpl.description}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            
            <Sep/>

            {/* ── Built-in templates (quick-pick grid) ── */}
            <SecHead style={{ marginTop:20 }}>Quick templates</SecHead>
            <div style={{
              display:"grid",
              gridTemplateColumns:"repeat(auto-fill, minmax(160px, 1fr))",
              gap:6, marginTop:10, marginBottom:20,
            }}>
              {AGENT_TEMPLATES.map(t => {
                const active = selectedTemplate === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => applyBuiltinTemplate(t.id)}
                    title={t.description}
                    style={{
                      display:"flex", alignItems:"center", gap:8,
                      padding:"9px 11px",
                      background: active ? "var(--c-srf2)" : "var(--c-srf)",
                      border: active ? "1px solid var(--foreground)" : "1px solid var(--c-brd)",
                      borderRadius:7, cursor:"pointer", textAlign:"left",
                      fontFamily:"inherit",
                      transition:"background 0.1s, border-color 0.1s",
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--c-srf2)"; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = "var(--c-srf)"; }}
                  >
                    <span style={{ fontSize:18, lineHeight:1, flexShrink:0 }}>{t.icon}</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, fontWeight:500, color:"var(--foreground)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {t.name}
                      </div>
                      <div style={{ fontSize:10.5, color:"var(--c-dim)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {t.description}
                      </div>
                    </div>
                    {active && <Check size={11} style={{ color:"var(--foreground)", flexShrink:0 }} />}
                  </button>
                );
              })}
            </div>

            <Sep/>

            {/* ── Project ── */}
            <SecHead style={{ marginTop:20 }}>Project</SecHead>
            <div style={{ display:"flex", flexDirection:"column", gap:10, marginTop:10, marginBottom:20 }}>

              <Fld label="Folder">
                <div style={{ display:"flex", gap:6, position:"relative" }}>
                  <div style={{ flex:1, position:"relative" }}>
                    <input ref={pathRef} value={path} title={path}
                      onChange={e => { setPath(e.target.value); setShowSug(true); setResumeId(null); }}
                      onFocus={() => setShowSug(true)}
                      onBlur={() => setTimeout(() => setShowSug(false), 150)}
                      placeholder="/Users/you/projects/myapp"
                      className="na-inp na-inp-mono"
                    />
                    {showSug && sug.length > 0 && (
                      <div style={{ position:"absolute", left:0, right:0, top:"calc(100% + 4px)", zIndex:20, borderRadius:8, border:"1px solid var(--c-brd2)", background:"var(--card)", boxShadow:"0 12px 32px rgba(0,0,0,0.65)", overflow:"hidden" }}>
                        {sug.map((p, i) => (
                          <button key={i} className="na-sug-item" onMouseDown={() => { setPath(p); setShowSug(false); }}>
                            <Clock size={10} style={{ opacity:.3, flexShrink:0 }}/>
                            <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button onClick={browse} className="na-browse">
                    <FolderOpen size={11}/> Browse
                  </button>
                </div>
              </Fld>

              <Fld label="Name" hint="optional">
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. auth refactor, bug fix…" className="na-inp"/>
              </Fld>

              <WorktreeToggle
                value={useWorktree}
                onChange={setUseWorktree}
                folderInGit={pathIsGit}
              />

              {offWorktreeConflict && (
                <div style={{
                  display: "flex", flexDirection: "column", gap: 7,
                  padding: "10px 12px", borderRadius: 7,
                  border: "1px solid rgba(220,140,60,.3)",
                  background: "rgba(220,140,60,.08)",
                }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "var(--foreground)", lineHeight: 1.4 }}>
                    A session is already active in this folder
                  </div>
                  <div style={{ fontSize: 11, color: "var(--c-low)", lineHeight: 1.5 }}>
                    Only one session can share a folder's working directory at a time.
                    Enable an isolated workspace to run this one in parallel.
                  </div>
                  <button
                    type="button"
                    onClick={() => setUseWorktree(true)}
                    style={{
                      alignSelf: "flex-start", marginTop: 1, height: 26, padding: "0 11px",
                      borderRadius: 6, border: "1px solid var(--c-brd2)",
                      background: "var(--c-srf)", color: "var(--foreground)",
                      fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
                    }}
                  >
                    Enable isolated workspace
                  </button>
                </div>
              )}

            </div>

            <Sep/>

            {/* ── Model ── */}
            <SecHead style={{ marginTop:20 }}>Model</SecHead>
            <div style={{ display:"flex", flexDirection:"column", gap:10, marginTop:10, marginBottom:20 }}>

              {/* Auto-routing banner — replaces the provider/model picker
                  when the master toggle is on AND the user hasn't expanded
                  the override. Names the active decision router so the
                  user knows which surface is making the call. The picker
                  re-appears below when "Override agent" is clicked. */}
              {routingMasterEnabled && !overrideAgent && (
                <div style={{
                  display:"flex", alignItems:"flex-start", gap:10,
                  padding:"11px 12px", borderRadius:8,
                  background:"var(--c-srf2)",
                  border:"1px solid var(--c-brd2)",
                }}>
                  <Wand2 size={14} style={{ color:"var(--c-low)", marginTop:1, flexShrink:0 }}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12.5, fontWeight:500, color:"var(--foreground)", lineHeight:1.3 }}>
                      Auto-routing enabled
                    </div>
                    <div style={{ fontSize:11, color:"var(--c-dim)", marginTop:3, lineHeight:1.45 }}>
                      {activeDecisionRouter
                        ? <>The <strong style={{ color:"var(--c-med)" }}>{activeDecisionRouter.display_name}</strong> router will pick the agent and model on the first turn.</>
                        : <>The active decision router will pick the agent and model on the first turn.</>
                      }
                    </div>
                    <button
                      type="button"
                      onClick={() => setOverrideAgent(true)}
                      style={{
                        marginTop:7, height:24, padding:"0 9px",
                        background:"var(--c-srf)", border:"1px solid var(--c-brd)",
                        borderRadius:5, color:"var(--c-med)",
                        fontSize:11, fontFamily:"inherit", cursor:"pointer",
                        display:"inline-flex", alignItems:"center", gap:5,
                      }}
                    >
                      <ChevronDown size={10}/>
                      Override agent
                    </button>
                  </div>
                </div>
              )}

              {showAgentPicker && (
                <>
                  {routingMasterEnabled && overrideAgent && (
                    <div style={{
                      display:"flex", alignItems:"center", justifyContent:"space-between",
                      padding:"6px 4px", marginBottom:2,
                    }}>
                      <span style={{ fontSize:11, color:"var(--c-dim)" }}>
                        Manual override — routing skipped for this session.
                      </span>
                      <button
                        type="button"
                        onClick={() => setOverrideAgent(false)}
                        style={{
                          background:"none", border:"none", padding:0,
                          color:"var(--c-low)", fontSize:11, fontFamily:"inherit",
                          cursor:"pointer", textDecoration:"underline",
                        }}
                      >
                        Use auto
                      </button>
                    </div>
                  )}
                  <Fld label="Provider">
                    <div className="na-seg-wrap">
                      {PROVIDERS.map(p => (
                        <button key={p.id} className={`na-prov${provider === p.id ? " on" : ""}`} onClick={() => changeProvider(p.id)}>
                          <p.icon size={13}/>{p.name}
                        </button>
                      ))}
                    </div>
                  </Fld>

                  <Fld label="Model">
                    <div ref={modelRef} style={{ position:"relative" }}>
                      <button onClick={() => setShowModel(v => !v)} className="na-inp" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", height:32, padding:"0 10px", textAlign:"left", boxSizing:"border-box" }}>
                        <span style={{ fontSize:12.5, fontWeight:500, color:"var(--foreground)" }}>{curModel.label}</span>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <span style={{ fontSize:11, color:"var(--c-ghost)" }}>{curModel.desc}</span>
                          <ChevronDown size={11} style={{ color:"var(--c-dim)", flexShrink:0, transform:showModel ? "rotate(180deg)" : "none", transition:"transform .15s" }}/>
                        </div>
                      </button>
                      {showModel && (
                        <div style={{ position:"absolute", left:0, right:0, top:"calc(100% + 4px)", zIndex:20, borderRadius:8, border:"1px solid var(--c-brd2)", background:"var(--card)", boxShadow:"0 12px 32px rgba(0,0,0,0.65)", overflow:"hidden" }}>
                          {curProv.models.map(m => (
                            <button key={m.id} className="na-model-opt" onClick={() => { setModelId(m.id); setShowModel(false); }}>
                              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                                {modelId === m.id
                                  ? <Check size={10} style={{ color:"var(--foreground)", flexShrink:0 }}/>
                                  : <div style={{ width:10, flexShrink:0 }}/>
                                }
                                <span style={{ fontSize:12.5, fontWeight:modelId === m.id ? 600 : 400, color:modelId === m.id ? "var(--foreground)" : "var(--c-low)" }}>{m.label}</span>
                              </div>
                              <span style={{ fontSize:11, color:"var(--c-ghost)" }}>{m.desc}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </Fld>
                </>
              )}

            </div>

            <Sep/>

            {/* ── Session ── */}
            {["claude-code","gemini-cli","codex-cli"].includes(provider) && (
              <>
                <SecHead style={{ marginTop:20 }}>Session</SecHead>
                <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:10, marginBottom:20 }}>
                  <div className="na-seg-wrap">
                    {[
                      { id:"new",      label:"New" },
                      { id:"continue", label:"Continue" },
                      { id:"resume",   label: sessionCount > 0 ? `Resume (${sessionCount})` : "Resume" },
                    ].map(m => (
                      <button key={m.id} className={`na-seg${mode === m.id ? " on" : ""}`} onClick={() => { setMode(m.id); setResumeId(null); }}>
                        {m.label}
                      </button>
                    ))}
                  </div>

                  {mode === "resume" && (
                    validSessions.length > 0 ? (
                      <div style={{ border:"1px solid var(--c-brd)", borderRadius:8, overflow:"hidden", maxHeight:148, overflowY:"auto" }}>
                        {sessLoading
                          ? <div style={{ padding:14, fontSize:12, color:"var(--c-dim)", textAlign:"center" }}>Loading sessions…</div>
                          : validSessions.map(s => {
                              const sel = resumeId === s.session_id;
                              return (
                                <button key={s.session_id} className={`na-sess-item${sel ? " sel" : ""}`} onClick={() => setResumeId(sel ? null : s.session_id)}>
                                  <Radio on={sel}/>
                                  <div style={{ flex:1, minWidth:0 }}>
                                    <div style={{ fontSize:12.5, fontWeight:sel ? 500 : 400, color:sel ? "var(--foreground)" : "var(--c-med)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                      {s.summary}
                                    </div>
                                    <div style={{ fontSize:10.5, color:"var(--c-dim)", marginTop:1 }}>{timeAgo(s.updated_at)}</div>
                                  </div>
                                </button>
                              );
                            })
                        }
                      </div>
                    ) : !sessLoading && path.trim() && (
                      <div style={{ padding:"10px 12px", borderRadius:7, border:"1px solid var(--c-brd)", background:"var(--c-srf)", fontSize:12, color:"var(--c-dim)", textAlign:"center" }}>
                        No previous sessions in this folder
                      </div>
                    )
                  )}
                </div>
                <Sep/>
              </>
            )}

            {/* ── Account (only when the agent has more than just System) ── */}
            {accounts.length > 1 && (
              <>
                <SecHead style={{ marginTop:20 }}>Account</SecHead>
                <select
                  value={accountId ?? "__main__"}
                  onChange={(e) => setAccountId(e.target.value === "__main__" ? null : e.target.value)}
                  className="na-inp"
                  style={{ marginTop:10, height:32, padding:"0 10px", fontSize:12.5, cursor:"pointer", width:"100%", boxSizing:"border-box" }}
                >
                  {/* Follow the provider's main account (dynamic). */}
                  <option value="__main__">
                    Main account{(() => { const d = accounts.find((a) => a.is_default); return d ? ` — ${d.label}` : ""; })()}
                  </option>
                  {/* Or pin a specific account for this session. */}
                  {accounts.map((a) => (
                    <option key={a.id} value={a.system ? "system" : a.id}>
                      Pin to {a.label}{a.authenticated ? "" : " — not signed in"}
                    </option>
                  ))}
                </select>
              </>
            )}

            {/* ── Permissions ── */}
            {permModes.length > 0 && (
              <>
                <SecHead style={{ marginTop:20 }}>Permissions</SecHead>
                <div style={{ display:"flex", flexDirection:"column", gap:2, marginTop:10, marginBottom:4 }}>
                  {permModes.map(p => {
                    const sel = perm === p.id;
                    return (
                      <button key={p.id} className={`na-perm-row${sel ? " sel" : ""}`} onClick={() => setPerm(p.id)}>
                        <Radio on={sel} style={{ marginTop:2, flexShrink:0 }}/>
                        <div style={{ flex:1, minWidth:0 }}>
                          <span style={{ fontSize:13, fontWeight:sel ? 600 : 400, color:sel ? "var(--foreground)" : "var(--c-med)" }}>{p.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

          </div>

          {/* Routers status — shows the active Decision + Proxy routers
              so the user knows which surface will handle the first turn
              of this session. Sits just above the Cancel / Launch footer. */}
          <div style={{ padding: "8px 20px 0", flexShrink: 0 }}>
            <RoutersStatusBar compact />
          </div>

          {/* Footer */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 20px", borderTop:"1px solid var(--c-brd)", flexShrink:0 }}>
            <button onClick={onClose}
              style={{ height:30, padding:"0 14px", borderRadius:6, border:"1px solid var(--c-brd)", background:"transparent", color:"var(--c-dim)", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", transition:"all .1s" }}
              onMouseEnter={e => { e.currentTarget.style.color="var(--foreground)"; e.currentTarget.style.borderColor="var(--c-brd2)"; }}
              onMouseLeave={e => { e.currentTarget.style.color="var(--c-dim)"; e.currentTarget.style.borderColor="var(--c-brd)"; }}>
              Cancel
            </button>
            <button className="na-launch" onClick={launch} disabled={loading || !canLaunch}>
              {loading ? "Launching…" : "Launch Agent →"}
            </button>
          </div>

        </div>
      </div>
    </>
  );
}

function SecHead({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ fontSize:10, fontWeight:700, color:"var(--c-ghost)", letterSpacing:"0.12em", textTransform:"uppercase", ...style }}>
      {children}
    </div>
  );
}

function Fld({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize:11.5, fontWeight:500, color:"var(--c-dim)", marginBottom:5, display:"flex", alignItems:"center", gap:5 }}>
        {label}
        {hint && <span style={{ fontWeight:400, color:"var(--c-ghost)", fontSize:11 }}>— {hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Sep() {
  return <div style={{ height:1, background:"var(--c-brd)", margin:"0 -20px" }}/>;
}

function Radio({ on, style }: { on: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{
      width:15, height:15, borderRadius:"50%", flexShrink:0,
      border:`1.5px solid ${on ? "var(--foreground)" : "var(--c-brd2)"}`,
      display:"flex", alignItems:"center", justifyContent:"center",
      transition:"border-color .1s", ...style,
    }}>
      {on && <div style={{ width:6, height:6, borderRadius:"50%", background:"var(--foreground)" }}/>}
    </div>
  );
}

function WorktreeToggle({ value, onChange, folderInGit }: {
  value: boolean;
  onChange: (v: boolean) => void;
  folderInGit?: boolean | null;
}) {
  // Probe `git` on PATH. Without it, worktrees can't be carved AND
  // Create PR can't run (both shell out to `git`); rather than offer
  // a toggle that does nothing, we collapse the row into a single
  // "Git required" notice and force `value` to false so the session
  // doesn't get created with use_worktree=true on a git-less host.
  // null = probing (initial render), true/false = settled.
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

  // Force value off when git is provably missing — keeps SessionCreate
  // from carrying a `use_worktree: true` payload to the backend on a
  // host that can't honour it. Only fires on the explicit `false`
  // transition (not the probing/null phase) so we don't flicker.
  useEffect(() => {
    if (gitPresent === false && value) onChange(false);
  }, [gitPresent, value, onChange]);

  if (gitPresent === false) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", gap: 6,
        padding: "10px 12px",
        borderRadius: 7,
        border: "1px dashed var(--c-brd)",
        background: "rgba(var(--fg-rgb), 0.02)",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 9,
          fontSize: 12.5, fontWeight: 500, color: "var(--c-dim)",
        }}>
          <span style={{
            width: 14, height: 14,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            borderRadius: 4,
            background: "rgba(var(--fg-rgb), 0.06)",
            color: "var(--c-dim)",
            fontSize: 10, fontWeight: 700,
          }}>—</span>
          Git not detected on this system
        </div>
        <div style={{
          fontSize: 11, color: "var(--c-low)",
          lineHeight: 1.5, paddingLeft: 23,
        }}>
          Isolated worktrees and Create PR both need Git. Sessions still run without it,
          but they'll share your working directory and skip the PR flow.{" "}
          <a
            href="https://git-scm.com/downloads"
            onClick={(e) => {
              e.preventDefault();
              try { window.electronAPI?.openExternal?.("https://git-scm.com/downloads"); }
              catch { /* best effort */ }
            }}
            style={{ color: "var(--c-med)", textDecoration: "underline", cursor: "pointer" }}
          >
            Install Git ↗
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 6,
      padding: "10px 12px",
      borderRadius: 7,
      border: "1px solid var(--c-brd)",
      background: "rgba(var(--fg-rgb), 0.02)",
    }}>
      <label style={{
        display: "flex", alignItems: "center", gap: 9,
        cursor: "pointer",
        fontSize: 12.5, fontWeight: 500, color: "var(--c-high)",
      }}>
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: 14, height: 14, cursor: "pointer", accentColor: "var(--c-fg)" }}
        />
        Isolated workspace (git worktree)
      </label>

      <div style={{
        fontSize: 11, color: "var(--c-low)",
        lineHeight: 1.5, paddingLeft: 23,
      }}>
        {value ? (
          <>
            Agent works in a fresh checkout under{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>.fleetify-worktrees/</code>{" "}
            on its own <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>fleet/…</code> branch.{" "}
            <span style={{ color: "var(--c-dim)" }}>Recommended for parallel sessions.</span>
          </>
        ) : (
          <>
            Agent shares your working directory but still commits to a separate{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>fleet/…</code> branch.{" "}
            <span style={{ color: "var(--c-dim)" }}>Only one off-worktree session per folder at a time.</span>
          </>
        )}
      </div>

      {folderInGit === false && (
        <div style={{
          fontSize: 10.5, color: "var(--c-dim)",
          paddingLeft: 23, fontStyle: "italic",
        }}>
          Folder isn't a git repo yet — Fleetify will initialize it on session start.
        </div>
      )}
    </div>
  );
}
