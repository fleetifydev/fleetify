import { ProviderLogo } from "@/components/ui/provider-logo";
import { CheckCircle2, Loader2, AlertTriangle, FileEdit, Terminal, GitBranch, Lightbulb, Webhook, Command, BarChart3, Plug, FileText } from "lucide-react";

/* ── Task Routed Card ── */
export function TaskRoutedCard({ agentName, task, model, project, onView }: {
  agentName: string; task: string; model: string; project: string; onView?: () => void;
}) {
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <Loader2 size={14} style={{ color: "#3b82f6", animation: "spin 1s linear infinite" }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>Task routed</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 6, background: "var(--accent)", marginBottom: 8 }}>
        <ProviderLogo tool="claude-code" size={16} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--foreground)" }}>{agentName}</div>
          <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{project} · {model}</div>
        </div>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6", animation: "agent-pulse 2s ease-in-out infinite" }} />
      </div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 10 }}>
        Starting: "{task}"
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <CardBtn label="View Agent" onClick={onView} />
        <CardBtn label="Cancel" />
      </div>
    </div>
  );
}

/* ── Task Completed Card ── */
export function TaskCompletedCard({ duration, files, testsPass, testsFail, cost, tokens, summary, onViewChanges, onOpenChat, onCommit }: {
  agentName?: string; duration: string; files: string[]; testsPass: number; testsFail: number;
  cost: string; tokens: string; summary: string;
  onViewChanges?: () => void; onOpenChat?: () => void; onCommit?: () => void;
}) {
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <CheckCircle2 size={14} style={{ color: "#22c55e" }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>Task completed</span>
        <span style={{ fontSize: 11, color: "var(--muted-foreground)", marginLeft: "auto" }}>{duration}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
          <FileEdit size={11} /> Files: {files.join(", ")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
          <Terminal size={11} /> Tests: {testsPass} passed{testsFail > 0 ? `, ${testsFail} failed` : ""}
        </div>
        <div style={{ marginBottom: 4 }}>Cost: {cost} ({tokens} tokens)</div>
      </div>
      <div style={{ fontSize: 13, color: "var(--foreground)", lineHeight: 1.5, padding: "8px 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", marginBottom: 10 }}>
        {summary}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <CardBtn label="View Changes" onClick={onViewChanges} primary />
        <CardBtn label="Open Agent Chat" onClick={onOpenChat} />
        <CardBtn label="Commit" icon={<GitBranch size={11} />} onClick={onCommit} />
      </div>
    </div>
  );
}

/* ── Fleet Status Card ── */
export function FleetStatusCard({ agents }: { agents: { name: string; project: string; status: string; cost: string; tool: string }[] }) {
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 12, background: "var(--card)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", marginBottom: 10 }}>Fleet Status</div>
      {agents.map((a, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: i < agents.length - 1 ? "1px solid var(--border)" : "none" }}>
          <ProviderLogo tool={a.tool} size={14} />
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--foreground)", flex: 1 }}>{a.name}</span>
          <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>{a.project}</span>
          <span style={{ fontSize: 10, color: a.status === "Running" ? "#22c55e" : a.status === "Error" ? "#ef4444" : "var(--muted-foreground)", fontWeight: 500 }}>{a.status}</span>
          <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>{a.cost}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--muted-foreground)" }}>
        <span>Total: {agents.length} agents</span>
        <span>${agents.reduce((s, a) => s + parseFloat(a.cost.replace("$", "")), 0).toFixed(2)} today</span>
      </div>
    </div>
  );
}

/* ── Error Card ── */
export function AgentErrorCard({ agentName, error, file, line, onFix }: {
  agentName: string; error: string; file?: string; line?: number; onFix?: () => void;
}) {
  return (
    <div style={{ borderRadius: 10, border: "1px solid rgba(239,68,68,0.2)", padding: "14px 16px", marginBottom: 12, background: "rgba(239,68,68,0.04)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <AlertTriangle size={14} style={{ color: "#ef4444" }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "#ef4444" }}>{agentName} — Error</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--foreground)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>{error}</div>
      {file && <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{file}{line ? `:${line}` : ""}</div>}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <CardBtn label="Auto-fix" onClick={onFix} primary />
        <CardBtn label="View Details" />
        <CardBtn label="Dismiss" />
      </div>
    </div>
  );
}

/* ── Agent Notification ── */
export function AgentNotification({ agentName, tool, message, time }: {
  agentName: string; tool: string; message: string; time: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 0", marginBottom: 4, borderBottom: "1px solid var(--border)" }}>
      <ProviderLogo tool={tool} size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--foreground)" }}>{agentName}</div>
        <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{message}</div>
      </div>
      <span style={{ fontSize: 10, color: "var(--muted-foreground)", flexShrink: 0 }}>{time}</span>
    </div>
  );
}

/* ── Resource List Card ── */
/**
 * Generic staff-message card for grouped resource lists. Used by the new
 * /skills, /hooks, /commands, /usage and /mcp slash-command handlers
 * (Sprint 2): each renders zero-or-more sections, each section a tier
 * label (User / Project / Plugin / Bundled) plus its rows. Rows are
 * read-only by default; pass `onAction` on a row to surface an inline
 * button (Sprint 2 uses this for "Open file" / "Refresh probe" etc.).
 */
export type ResourceRow = {
  name: string;
  description?: string;
  enabled?: boolean;
  badge?: string;
  onAction?: () => void;
  actionLabel?: string;
};

export type ResourceSection = {
  title: string;
  rows: ResourceRow[];
  empty?: string;
};

export function ResourceListCard({ title, icon, sections, footer }: {
  title: string;
  icon?: React.ReactNode;
  sections: ResourceSection[];
  footer?: React.ReactNode;
}) {
  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        {icon}
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--muted-foreground)", marginLeft: "auto" }}>{totalRows}</span>
      </div>
      {sections.map((s, si) => (
        <div key={si} style={{ marginBottom: si < sections.length - 1 ? 10 : 0 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
            {s.title}
          </div>
          {s.rows.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted-foreground)", padding: "4px 0", fontStyle: "italic" }}>{s.empty ?? "—"}</div>
          ) : (
            s.rows.map((r, ri) => (
              <div key={ri} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 0",
                borderBottom: ri < s.rows.length - 1 ? "1px solid var(--border)" : "none",
                opacity: r.enabled === false ? 0.5 : 1,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "var(--foreground)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    {r.badge && (
                      <span style={{ fontSize: 10, color: "var(--muted-foreground)", fontWeight: 400, flexShrink: 0 }}>
                        {r.badge}
                      </span>
                    )}
                  </div>
                  {r.description && (
                    <div style={{ fontSize: 11, color: "var(--muted-foreground)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.description}
                    </div>
                  )}
                </div>
                {r.onAction && <CardBtn label={r.actionLabel ?? "Open"} onClick={r.onAction} />}
              </div>
            ))
          )}
        </div>
      ))}
      {footer && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--muted-foreground)" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

/* ── Resource cards (slash-command results) ──
 *
 * These wrap ResourceListCard with provider-specific shapes for the
 * /skills, /hooks, /commands (or /prompts), /usage and /mcp staff
 * messages produced by the chat-input dispatcher. Each renderer takes
 * the raw backend payload (`data.items` for inspector endpoints, the
 * stats overview shape for usage, the MCP store row for mcp) and
 * groups it into ResourceSection[].
 */

type ProviderItemDict = {
  kind: string;
  provider: string;
  name: string;
  source_tier: "system" | "user" | "project" | "plugin" | "bundled";
  path: string;
  namespace?: string | null;
  description?: string | null;
  enabled?: boolean;
};

const TIER_ORDER: Array<ProviderItemDict["source_tier"]> = ["bundled", "user", "project", "plugin", "system"];
const TIER_LABEL: Record<ProviderItemDict["source_tier"], string> = {
  bundled: "Bundled",
  user: "Global (~/)",
  project: "Project",
  plugin: "Plugin",
  system: "System",
};

function groupByTier(items: ProviderItemDict[], emptyHint: string): ResourceSection[] {
  if (items.length === 0) {
    return [{ title: "No items found", rows: [], empty: emptyHint }];
  }
  const byTier = new Map<ProviderItemDict["source_tier"], ProviderItemDict[]>();
  for (const it of items) {
    const arr = byTier.get(it.source_tier) ?? [];
    arr.push(it);
    byTier.set(it.source_tier, arr);
  }
  return TIER_ORDER.flatMap((tier) => {
    const list = byTier.get(tier);
    if (!list || list.length === 0) return [];
    return [{
      title: TIER_LABEL[tier],
      rows: list.map((it) => ({
        name: it.namespace ? `${it.namespace}:${it.name}` : it.name,
        description: it.description ?? it.path,
        enabled: it.enabled !== false,
      })),
    }];
  });
}

export function SkillsCard({ items, provider }: { items: ProviderItemDict[]; provider: string }) {
  return (
    <ResourceListCard
      title={`Skills — ${provider}`}
      icon={<Lightbulb size={14} style={{ color: "#a78bfa" }} />}
      sections={groupByTier(items, `No skills installed for ${provider}.`)}
      footer={items.length > 0 ? `${items.length} skill${items.length === 1 ? "" : "s"} discovered. Read-only — edit via the provider's settings file.` : undefined}
    />
  );
}

export function HooksCard({ items, provider }: { items: ProviderItemDict[]; provider: string }) {
  return (
    <ResourceListCard
      title={`Hooks — ${provider}`}
      icon={<Webhook size={14} style={{ color: "#f97316" }} />}
      sections={groupByTier(items, `No lifecycle hooks configured for ${provider}.`)}
      footer={items.length > 0 ? `${items.length} hook handler${items.length === 1 ? "" : "s"}. Read-only — edit via the provider's settings.json / config.toml.` : undefined}
    />
  );
}

export function CommandsCard({ items, provider, kind }: { items: ProviderItemDict[]; provider: string; kind: "commands" | "prompts" }) {
  const titleNoun = kind === "prompts" ? "Prompts" : "Commands";
  return (
    <ResourceListCard
      title={`${titleNoun} — ${provider}`}
      icon={kind === "prompts" ? <FileText size={14} style={{ color: "#22c55e" }} /> : <Command size={14} style={{ color: "#22c55e" }} />}
      sections={groupByTier(items, `No custom ${kind} found for ${provider}.`)}
    />
  );
}

/* ── Usage card ── */
type UsageData = {
  session_cost_usd?: number;
  session_input_tokens?: number;
  session_output_tokens?: number;
  account_cost_usd?: number;
  account_messages?: number;
  account_sessions?: number;
  model?: string;
};

export function UsageCard({ data }: { data: UsageData }) {
  const fmtUsd = (n: number | undefined) => n == null ? "—" : `$${n.toFixed(4)}`;
  const fmtNum = (n: number | undefined) => n == null ? "—" : n.toLocaleString();
  const sections: ResourceSection[] = [
    {
      title: "This session",
      rows: [
        { name: "Cost", description: fmtUsd(data.session_cost_usd) },
        { name: "Input tokens", description: fmtNum(data.session_input_tokens) },
        { name: "Output tokens", description: fmtNum(data.session_output_tokens) },
        ...(data.model ? [{ name: "Model", description: data.model }] : []),
      ],
    },
    {
      title: "Account total",
      rows: [
        { name: "Cost", description: fmtUsd(data.account_cost_usd) },
        { name: "Messages", description: fmtNum(data.account_messages) },
        { name: "Sessions", description: fmtNum(data.account_sessions) },
      ],
    },
  ];
  return (
    <ResourceListCard
      title="Usage"
      icon={<BarChart3 size={14} style={{ color: "#06b6d4" }} />}
      sections={sections}
    />
  );
}

/* ── MCP status card ── */
type McpServerRow = {
  name: string;
  status?: "connected" | "auth_needed" | "failed" | "checking";
  tool_count?: number;
  error?: string;
};

const STATUS_COLOR: Record<NonNullable<McpServerRow["status"]>, string> = {
  connected: "#22c55e",
  auth_needed: "#eab308",
  failed: "#ef4444",
  checking: "#3b82f6",
};

const STATUS_LABEL: Record<NonNullable<McpServerRow["status"]>, string> = {
  connected: "connected",
  auth_needed: "needs auth",
  failed: "failed",
  checking: "checking…",
};

export function MCPStatusCard({ servers }: { servers: McpServerRow[] }) {
  const sections: ResourceSection[] = servers.length === 0
    ? [{ title: "Servers", rows: [], empty: "No MCP servers configured." }]
    : [{
        title: "Servers",
        rows: servers.map((s) => {
          const status = s.status ?? "checking";
          return {
            name: s.name,
            description: s.error || (typeof s.tool_count === "number" ? `${s.tool_count} tool${s.tool_count === 1 ? "" : "s"}` : undefined),
            badge: STATUS_LABEL[status],
            enabled: status !== "failed",
          };
        }),
      }];
  return (
    <ResourceListCard
      title="MCP servers"
      icon={<Plug size={14} style={{ color: "#06b6d4" }} />}
      sections={sections}
      footer={servers.length > 0 ? (
        <span>
          {servers.filter(s => (s.status ?? "checking") === "connected").length}
          {" / "}
          {servers.length}
          {" connected. "}
          <span style={{ color: STATUS_COLOR.connected }}>●</span>{" connected "}
          <span style={{ color: STATUS_COLOR.auth_needed }}>●</span>{" needs auth "}
          <span style={{ color: STATUS_COLOR.failed }}>●</span>{" failed"}
        </span>
      ) : undefined}
    />
  );
}

/* ── Init confirmation / outcome cards ── */
export function InitPendingCard({ filename, projectPath, alreadyExists, onConfirm, onCancel }: {
  filename: string; projectPath: string; alreadyExists: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <FileEdit size={14} style={{ color: alreadyExists ? "#eab308" : "#22c55e" }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
          {alreadyExists ? `Overwrite ${filename}?` : `Create ${filename}?`}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
        {projectPath}
      </div>
      {alreadyExists && (
        <div style={{ fontSize: 11, color: "#eab308", marginBottom: 10 }}>
          A file with this name already exists. Confirming will replace it with the Fleetify starter template.
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <CardBtn label={alreadyExists ? "Overwrite" : "Create"} onClick={onConfirm} primary />
        <CardBtn label="Cancel" onClick={onCancel} />
      </div>
    </div>
  );
}

export function InitDoneCard({ path, existed }: { path: string; existed: boolean }) {
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "12px 14px", marginBottom: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <CheckCircle2 size={14} style={{ color: "#22c55e" }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--foreground)" }}>
          {existed ? "Replaced" : "Created"} {path}
        </span>
      </div>
    </div>
  );
}

/* ── Generic info card (for /effort, /permissions, errors) ── */
export function InfoCard({ title, message, tone = "info" }: { title: string; message: string; tone?: "info" | "warn" | "error" }) {
  const color = tone === "error" ? "#ef4444" : tone === "warn" ? "#eab308" : "#3b82f6";
  return (
    <div style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "10px 14px", marginBottom: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <AlertTriangle size={12} style={{ color }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--foreground)" }}>{title}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{message}</div>
    </div>
  );
}

/* ── Card Button ── */
function CardBtn({ label, icon, onClick, primary }: { label: string; icon?: React.ReactNode; onClick?: () => void; primary?: boolean }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6,
      border: primary ? "none" : "1px solid var(--border)",
      background: primary ? "var(--foreground)" : "none",
      color: primary ? "var(--background)" : "var(--muted-foreground)",
      fontSize: 11, fontWeight: 500, cursor: "pointer", transition: "all 0.1s",
    }}
      onMouseEnter={e => { if (!primary) { e.currentTarget.style.borderColor = "var(--ring)"; e.currentTarget.style.color = "var(--foreground)"; } }}
      onMouseLeave={e => { if (!primary) { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--muted-foreground)"; } }}
    >
      {icon}{label}
    </button>
  );
}
