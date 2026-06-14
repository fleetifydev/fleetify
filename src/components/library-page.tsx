/**
 * Library page — full-viewport route showing what's installed
 *   across all the user's plugins, sliced by content type.
 *
 * Sits next to Settings: Settings is "how Fleet behaves", Library is
 * "what's available to your agents right now". The tabs mirror
 * the `provides` taxonomy plus templates, so the user can answer
 * questions like "do I have any prompts installed?" or "which plugin
 * gave me this skill?" without digging through individual install
 * rows in the marketplace.
 *
 * Triggered by the sidebar Library row (which dispatches
 * `fleet:open-library`). App.tsx listens and toggles `libraryOpen`,
 * which hides the main shell with `display:none` so per-session
 * state (WebSockets, polls) stays alive while the user is here.
 *
 * Data: walks the plugin store's `installs` array — each install
 * carries its manifest, including the per-component counts in
 * `declares`. We aggregate counts per section and group contributing
 * plugins. Listing actual item names is out of scope for v1 — that
 * would need new backend endpoints to enumerate ~/.fleetify/prompts/,
 * the per-provider materialised dirs, etc. The counts-and-attribution
 * view answers the most common question ("what's in my Library?")
 * without that round-trip.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Library as LibraryIcon, FileText, Sparkles, Webhook,
  Workflow, LayoutTemplate, Cable, Package, HelpCircle, MessageCircle,
  User, Sun, Plus, Trash2, Pencil, Bot, ScrollText,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { usePluginStore } from "@/stores/plugin-store";
import { useLibraryStore } from "@/stores/library-store";
import { CreateItemDialog } from "./library/create-item-dialog";
import { RuleForm } from "./library/rule-form";
import { HookForm } from "./library/hook-form";
import { ProviderLogo, providerName } from "@/components/ui/provider-logo";
import type { LibraryKind, LibraryItem } from "@/lib/library-api";
import { useThemeStore } from "@/stores/theme-store";
import type { PluginInstall } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { usesInAppTitleBar } from "@/lib/utils";
import { WindowsTitleBar } from "./layout/windows-title-bar";
import { openDocs } from "./layout/sidebar";
import { FeedbackModal } from "./feedback-modal";

interface Props {
  /** Called when the user closes the Library (X button or Esc). */
  onClose: () => void;
}

type SectionId =
  | "Prompts"
  | "Skills"
  | "Subagents"
  | "Hooks"
  | "Rules"
  | "Workflows"
  | "Templates"
  | "MCP";

interface SectionDef {
  id: SectionId;
  icon: React.FC<{ size?: number }>;
  /** Plain-English description shown beneath the page title — gives
   *  the user a one-line orientation per section. */
  blurb: string;
}

const NAV: SectionDef[] = [
  {
    id: "Prompts", icon: FileText,
    blurb: "Reusable prompt schemas materialised to ~/.fleetify/prompts/.",
  },
  {
    id: "Skills", icon: Sparkles,
    blurb: "Skill packs auto-attached to your agents' system prompt.",
  },
  {
    id: "Subagents", icon: Bot,
    blurb: "Delegate agents materialised to each provider's agents/ dir.",
  },
  {
    id: "Hooks", icon: Webhook,
    blurb: "Lifecycle hook handlers wired into the agent's tool calls.",
  },
  {
    id: "Rules", icon: ScrollText,
    blurb: "Always-on instructions merged into each provider's rule file.",
  },
  {
    id: "Workflows", icon: Workflow,
    blurb: "Reusable multi-step automations runnable from a session.",
  },
  {
    id: "Templates", icon: LayoutTemplate,
    blurb: "Pre-configured agent presets surfaced in NewAgentDialog.",
  },
  {
    id: "MCP", icon: Cable,
    blurb: "MCP servers a session can call out to during tool runs.",
  },
];

/** Which authorable LibraryKind each section maps to. Workflows (plugin-only)
 *  and MCP (redirects to Settings) have none. */
const SECTION_KIND: Partial<Record<SectionId, LibraryKind>> = {
  Prompts: "prompt", Skills: "skill", Subagents: "subagent",
  Hooks: "hook", Rules: "rule", Templates: "template",
};
const KIND_SECTION: Record<LibraryKind, SectionId> = {
  prompt: "Prompts", skill: "Skills", subagent: "Subagents",
  hook: "Hooks", rule: "Rules", template: "Templates",
};

/** Sum the components that a single plugin install contributes to a
 *  given section. Mirrors the rules in `deriveProvides` so the counts
 *  match the marketplace's filter chips one-to-one. */
function countForSection(inst: PluginInstall, section: SectionId): number {
  const d = inst.manifest.declares;
  const pv = Object.values(d.providers ?? {});
  switch (section) {
    case "Prompts":   return d.prompts ?? 0;
    case "Skills":    return pv.reduce((s, p) => s + p.skills, 0);
    // Subagents + Rules are enumerated as items (libraryItems), so their
    // counts come from there, not the per-install declares.
    case "Subagents": return 0;
    case "Hooks":     return pv.reduce((s, p) => s + p.hooks, 0);
    case "Rules":     return 0;
    case "Workflows": return d.workflows;
    case "Templates": return d.templates;
    case "MCP":       return d.mcp_servers;
  }
}

export function LibraryPage({ onClose }: Props) {
  const [active, setActive] = useState<SectionId>("Prompts");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const installs = usePluginStore(s => s.installs);
  const loadingInstalls = usePluginStore(s => s.loadingInstalls);
  const refreshInstalls = usePluginStore(s => s.refreshInstalls);
  const setMainView = useAppStore(s => s.setMainView);
  const libraryItems = useLibraryStore(s => s.items);
  const refreshLibrary = useLibraryStore(s => s.refresh);
  const removeLibraryItem = useLibraryStore(s => s.remove);
  const [dialogKind, setDialogKind] = useState<LibraryKind | null>(null);
  const [dialogEditing, setDialogEditing] = useState<LibraryItem | null>(null);

  // Refresh once on open so the page doesn't show stale install state
  // from a cold-mount that happened before the user installed anything.
  useEffect(() => { void refreshInstalls(); void refreshLibrary(); }, [refreshInstalls, refreshLibrary]);

  // Esc closes — same shortcut Settings uses, so the two surfaces
  // share muscle memory.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Per-section totals shown in the sidebar nav and as the page header
  // count. Computed once per installs change so picking a tab is free.
  const totals = useMemo(() => {
    const out: Record<SectionId, number> = {
      Prompts: 0, Skills: 0, Subagents: 0, Hooks: 0, Rules: 0,
      Workflows: 0, Templates: 0, MCP: 0,
    };
    // Plugin skills/subagents/templates are enumerated as items (in
    // libraryItems), so their declares would double-count — skip those sections.
    const ENUMERATED: SectionId[] = ["Skills", "Subagents", "Templates"];
    for (const inst of installs) {
      for (const sec of NAV) {
        if (ENUMERATED.includes(sec.id)) continue;
        out[sec.id] += countForSection(inst, sec.id);
      }
    }
    for (const it of libraryItems) out[KIND_SECTION[it.kind]] += 1;
    return out;
  }, [installs, libraryItems]);

  // Plugins that contribute at least one item to the active section.
  // Sorted by descending count so the heaviest contributor lands first
  // — same pattern the marketplace catalog uses for editor's-picks.
  const contributors = useMemo(() => {
    return installs
      .map(inst => ({ inst, count: countForSection(inst, active) }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [installs, active]);

  const activeKind = SECTION_KIND[active];
  const userItems = useMemo(
    () => (activeKind ? libraryItems.filter(i => i.kind === activeKind) : []),
    [libraryItems, activeKind],
  );

  const openMarketplace = () => {
    setMainView("marketplace");
    onClose();
  };

  return (
    <div style={{
      width: "100vw",
      height: "100vh",
      background: "var(--card)",
      display: "flex", flexDirection: "column", overflow: "hidden",
      position: "relative",
    }}>
      {/* Windows-only caption row. macOS returns null so this is a
          zero-cost mount everywhere else. ``backTo`` swaps the
          sidebar-controls trio for a single back arrow that closes
          the page — the user-facing fix for "the top bar disappears
          when I open Library / Settings". */}
      <WindowsTitleBar backTo={{ onBack: onClose, title: "Back to workspace" }} />

      <div style={{
        flex: 1, minHeight: 0,
        display: "flex", overflow: "hidden",
        // 8px L/R gutters live on the inner shell so the title bar
        // above can span the full window width (matching the main
        // AppShell, where the title bar abuts the OS window edge).
        padding: "0 8px",
      }}>
      {/* ── Sidebar — same metrics as SettingsPage so swapping between
          the two surfaces feels like flipping pages of the same book. */}
      <div style={{
        width: 224, flexShrink: 0,
        marginTop: 8, marginBottom: 8,
        borderRadius: 8,
        border: "1px solid var(--c-brd)",
        background: "var(--sidebar)",
        overflow: "hidden",
      }}>
        <nav style={{
          height: "100%",
          display: "flex", flexDirection: "column",
          background: "var(--sidebar)",
          overflow: "hidden", userSelect: "none",
        }}>
          {/* Windows-only top spacer. The 44px drag-bar below this
              renders only on macOS (it carries the back-arrow and
              reserves space for the traffic lights); without it the
              first nav row sat flush against the sidebar's top
              border and read as cramped. 12px gives the rail a bit
              of breathing room without re-introducing the dead
              header band the user explicitly asked us to remove. */}
          {usesInAppTitleBar() && (
            <div style={{ height: 12, flexShrink: 0 }} />
          )}

          {/* macOS drag-bar with back button. The 78px left pad
              reserves room for the OS-drawn traffic lights so the
              drag region doesn't hide them; the back-arrow on the
              right closes the page (replacing the old X close
              icon — semantically the same action, just a navigation
              affordance instead of a window control). Windows
              suppresses this whole block because the WindowsTitleBar
              above already carries the back arrow + caption buttons,
              and the empty 78px traffic-light pad would otherwise
              waste vertical space at the top of the rail. */}
          {!usesInAppTitleBar() && (
            <div className="drag-region" style={{
              height: 44, flexShrink: 0,
              display: "flex", alignItems: "center",
              padding: "0 10px 0 78px",
            }}>
              <div style={{ flex: 1 }} />
              <div className="no-drag" style={{ display: "flex", gap: 1, marginTop: -8 }}>
                <button
                  onClick={onClose}
                  title="Back (Esc)"
                  style={{
                    width: 24, height: 24, borderRadius: 5, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--c-dim)",
                    outline: "none",
                    transition: "background 0.1s, color 0.1s",
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = "var(--c-srf)";
                    e.currentTarget.style.color = "var(--c-med)";
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = "none";
                    e.currentTarget.style.color = "var(--c-dim)";
                  }}
                >
                  <ArrowLeft size={12} />
                </button>
              </div>
            </div>
          )}

          {/* Sub-title — anchors the rail with a Library glyph so the
              user knows which surface they're in at a glance. */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "0 12px 12px",
            color: "var(--c-dim)",
            fontSize: 11.5, fontWeight: 600, letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}>
            <LibraryIcon size={13} />
            <span>Library</span>
          </div>

          <div className="scroll-subtle" style={{
            flex: 1, overflowY: "auto", minHeight: 0, padding: "0 6px",
          }}>
            {NAV.map(item => (
              <LibraryNavRow
                key={item.id}
                icon={<item.icon size={13} />}
                label={item.id}
                count={totals[item.id]}
                active={active === item.id}
                onClick={() => setActive(item.id)}
              />
            ))}
          </div>

          {/* Footer parity with the main sidebar — Help / Give Feedback
              / Account stack so the rail reads the same across surfaces. */}
          <div style={{ flexShrink: 0, padding: "6px 6px 8px" }}>
            <LibraryNavRow icon={<HelpCircle size={13} />} label="Get Help" onClick={openDocs} />
            <LibraryNavRow icon={<MessageCircle size={13} />} label="Give Feedback"
              onClick={() => setFeedbackOpen(true)} />
            <LibraryAccountFooter />
          </div>
        </nav>
      </div>

      {/* ── Content ── */}
      <div style={{
        flex: 1, minWidth: 0,
        display: "flex", flexDirection: "column",
        background: "var(--card)",
      }}>
        {/* Drag strip — matches the sidebar's 44px header so the
            entire top row reads as one continuous title bar on
            macOS. Hidden on Windows: WindowsTitleBar above already
            covers drag, and a phantom 44px gap would push the page
            heading down — the opposite of the "pull content up"
            adjustment the user requested. */}
        {!usesInAppTitleBar() && (
          <div className="drag-region" style={{ height: 44, flexShrink: 0 }} />
        )}

        <div className="scroll-subtle" style={{
          flex: 1, minHeight: 0, overflowY: "auto",
        }}>
          <div style={{
            padding: "8px 40px 56px",
            maxWidth: 760, margin: "0 auto",
          }}>
            <h1 style={{
              fontSize: 24, fontWeight: 600,
              color: "var(--c-high)",
              margin: "0 0 6px",
              letterSpacing: "-0.022em",
              display: "flex", alignItems: "baseline", gap: 12,
            }}>
              <span>{active}</span>
              <span style={{
                fontSize: 14, fontWeight: 500,
                color: "var(--c-dim)",
                fontFamily: "var(--font-mono)",
              }}>{totals[active]}</span>
            </h1>
            <div style={{
              fontSize: 12.5, color: "var(--c-low)",
              marginBottom: 24, lineHeight: 1.5,
            }}>
              {NAV.find(n => n.id === active)?.blurb}
            </div>

            {active === "MCP" ? (
              <McpRedirectCard />
            ) : active === "Workflows" ? (
              loadingInstalls && installs.length === 0 ? (
                <CenteredHint text="Loading installed plugins…" />
              ) : contributors.length === 0 ? (
                <EmptyState section={active} onBrowse={openMarketplace} />
              ) : (
                <ContributorList contributors={contributors} />
              )
            ) : (
              <UserItemsList
                kind={activeKind!}
                items={userItems}
                onNew={() => { setDialogEditing(null); setDialogKind(activeKind!); }}
                onEdit={(it) => { setDialogEditing(it); setDialogKind(activeKind!); }}
                onDelete={removeLibraryItem}
              />
            )}
          </div>
        </div>
      </div>
      </div>
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      {dialogKind === "rule" ? (
        <RuleForm
          editing={dialogEditing ?? undefined}
          onClose={() => { setDialogKind(null); setDialogEditing(null); }}
        />
      ) : dialogKind === "hook" ? (
        <HookForm
          editing={dialogEditing ?? undefined}
          onClose={() => { setDialogKind(null); setDialogEditing(null); }}
        />
      ) : dialogKind ? (
        <CreateItemDialog
          kind={dialogKind}
          editing={dialogEditing ?? undefined}
          onClose={() => { setDialogKind(null); setDialogEditing(null); }}
        />
      ) : null}
    </div>
  );
}

/* ── LibraryAccountFooter ──
   Mirror of the main sidebar's AccountFooter: user pill on the left,
   theme-toggle on the right. Click jumps into Settings → Account so the
   row keeps the same semantics across surfaces. */
function LibraryAccountFooter() {
  const raw = (() => { try { return localStorage.getItem("fleet:user"); } catch { return null; } })();
  const user = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  const displayName: string = user?.name ?? user?.email?.split("@")[0] ?? "User";
  const { toggle: toggleTheme } = useThemeStore();

  const openAccount = () =>
    window.dispatchEvent(new CustomEvent("fleet:open-settings", { detail: { tab: "Account" } }));

  return (
    <button
      onClick={openAccount}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%",
        padding: "4px 9px", border: "none", cursor: "pointer",
        textAlign: "left", fontSize: 12.5, fontWeight: 400,
        borderRadius: 5, background: "none", color: "var(--c-med)",
        fontFamily: "inherit", outline: "none",
        transition: "background 0.08s, color 0.08s",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "none";       e.currentTarget.style.color = "var(--c-med)"; }}
    >
      <User size={12} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {displayName}
      </span>
      <span
        role="button"
        title="Toggle theme"
        onClick={(e) => { e.stopPropagation(); toggleTheme(); }}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 18, height: 18, borderRadius: 4, flexShrink: 0,
          color: "var(--c-dim)",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-dim)"; }}
      >
        <Sun size={11} />
      </span>
    </button>
  );
}

/* ── Sidebar nav row — small icon + label + count badge ───────── */
function LibraryNavRow({
  icon, label, count, active, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: "5px 9px",
        borderRadius: 6,
        cursor: onClick ? "pointer" : "default",
        background: active
          ? "var(--c-srf)"
          : hover && onClick ? "var(--c-srf)" : "transparent",
        color: active ? "var(--c-high)" : "var(--c-med)",
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        transition: "background 0.10s, color 0.10s",
      }}
    >
      <span style={{
        display: "inline-flex", width: 16, justifyContent: "center",
        color: active ? "var(--c-high)" : "var(--c-dim)",
        flexShrink: 0,
      }}>{icon}</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {count !== undefined && count > 0 && (
        <span style={{
          fontSize: 10.5,
          fontFamily: "var(--font-mono)",
          color: active ? "var(--c-med)" : "var(--c-ghost)",
          fontWeight: 500,
        }}>{count}</span>
      )}
    </div>
  );
}

/* ── Empty state — same pattern marketplace's no-results screen uses,
   but scoped to the active library section. */
function EmptyState({
  section, onBrowse,
}: { section: SectionId; onBrowse: () => void }) {
  return (
    <div style={{
      border: "1px dashed var(--c-brd)",
      borderRadius: 10,
      padding: "32px 24px",
      textAlign: "center",
      color: "var(--c-low)",
    }}>
      <div style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 40, height: 40, borderRadius: "50%",
        background: "var(--c-srf)",
        marginBottom: 14, color: "var(--c-dim)",
      }}>
        <Package size={18} />
      </div>
      <div style={{
        fontSize: 14, fontWeight: 500, color: "var(--c-high)",
        marginBottom: 6,
      }}>No {section.toLowerCase()} installed yet.</div>
      <div style={{
        fontSize: 12.5, color: "var(--c-low)", lineHeight: 1.5,
        maxWidth: 380, margin: "0 auto 16px",
      }}>
        Install a plugin from the marketplace that ships {section.toLowerCase()} and
        they'll appear here automatically.
      </div>
      <button
        onClick={onBrowse}
        style={{
          padding: "6px 14px",
          fontSize: 12.5, fontWeight: 600,
          background: "var(--c-high)",
          color: "var(--card)",
          border: "none",
          borderRadius: 7,
          cursor: "pointer",
        }}
      >
        Browse Marketplace
      </button>
    </div>
  );
}

/* ── Contributor list — one Card per plugin that contributes to the
   active section. Mirrors the install-dialog row style so the user's
   eye doesn't have to learn a new pattern. */
function ContributorList({
  contributors,
}: { contributors: Array<{ inst: PluginInstall; count: number }> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {contributors.map(({ inst, count }) => (
        <ContributorRow key={inst.id} install={inst} count={count} />
      ))}
    </div>
  );
}

function ContributorRow({
  install, count,
}: { install: PluginInstall; count: number }) {
  const [hover, setHover] = useState(false);
  const m = install.manifest;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 14px",
        background: "var(--card)",
        border: "1px solid",
        borderColor: hover ? "var(--c-brd2)" : "var(--c-brd)",
        borderRadius: 9,
        transition: "border-color 0.12s",
      }}
    >
      <div style={{
        width: 32, height: 32, flexShrink: 0,
        borderRadius: 7,
        background: "#ffffff",
        border: "1px solid var(--sidebar-border)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {m.icon ? (
          <img
            src={m.icon}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: 18, height: 18, objectFit: "contain" }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <Package size={14} style={{ color: "#333" }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 500, color: "var(--c-high)",
          lineHeight: 1.3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {pluginLabel(m)}
          <span style={{
            marginLeft: 8,
            fontSize: 11, fontWeight: 500,
            color: "var(--c-ghost)",
            fontFamily: "var(--font-mono)",
          }}>v{m.version}</span>
        </div>
        {m.description && (
          <div style={{
            fontSize: 11.5, color: "var(--c-dim)",
            lineHeight: 1.4, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{m.description}</div>
        )}
      </div>
      <div style={{
        flexShrink: 0,
        padding: "3px 10px",
        fontSize: 11.5, fontWeight: 600,
        color: "var(--c-med)",
        background: "var(--c-srf)",
        border: "1px solid var(--c-brd)",
        borderRadius: 99,
      }}>
        {count} {count === 1 ? "item" : "items"}
      </div>
    </div>
  );
}

function CenteredHint({ text }: { text: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "60px 20px", gap: 6,
      color: "var(--c-low)",
      fontSize: 12.5,
    }}>{text}</div>
  );
}

/* ── SubHeading — small uppercase section divider label. */
function SubHeading({ text }: { text: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
      color: "var(--c-dim)", marginBottom: 10,
    }}>{text}</div>
  );
}

/* ── UserItemsList — the user's own authored items for a section, with a
   New button and per-item delete. Plugin-contributed items render separately
   below (read-only). */
function UserItemsList({
  kind, items, onNew, onEdit, onDelete,
}: {
  kind: LibraryKind;
  items: LibraryItem[];
  onNew: () => void;
  onEdit: (item: LibraryItem) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <SubHeading text="Items" />
        <button
          onClick={onNew}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "5px 11px", fontSize: 12, fontWeight: 600,
            background: "var(--c-high)", color: "var(--card)",
            border: "none", borderRadius: 7, cursor: "pointer",
          }}
        >
          <Plus size={13} /> New
        </button>
      </div>
      {items.length === 0 ? (
        <div style={{
          border: "1px dashed var(--c-brd)", borderRadius: 10, padding: 24,
          textAlign: "center", color: "var(--c-low)", fontSize: 12.5,
        }}>
          No {kind}s yet — create one or install a plugin.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map(it => (
            <UserItemRow key={it.id} item={it} onEdit={() => onEdit(it)} onDelete={() => onDelete(it.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

const RULE_FORMAT_LABEL: Record<string, string> = {
  general: "General",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
};

/** The last path segment of a folder path (handles `/` and `\`). */
function folderBasename(path?: string): string {
  if (!path) return "…";
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function UserItemRow({ item, onEdit, onDelete }: { item: LibraryItem; onEdit: () => void; onDelete: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "11px 14px", background: "var(--card)",
        border: "1px solid", borderColor: hover ? "var(--c-brd2)" : "var(--c-brd)",
        borderRadius: 9, transition: "border-color 0.12s",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-high)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
          <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--c-ghost)", flexShrink: 0 }}>{item.slug}</span>
          <span style={{
            fontSize: 9.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
            color: "var(--c-med)", background: "var(--c-srf)", borderRadius: 4, padding: "1px 5px", flexShrink: 0,
          }}>{item.editable === false ? (item.source ?? "plugin") : "You"}</span>
        </div>
        {item.description && (
          <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.description}
          </div>
        )}
        {item.providers.length > 0 && (
          <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center",
            gap: 6, marginTop: 6, fontSize: 11, color: "var(--c-med)",
          }}>
            {item.providers.map((id, i) => (
              <Fragment key={id}>
                {i > 0 && <span style={{ color: "var(--c-ghost)", userSelect: "none" }}>·</span>}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <ProviderLogo tool={id} size={12} />
                  {providerName(id)}
                </span>
              </Fragment>
            ))}
          </div>
        )}
        {item.kind === "rule" && item.rule_spec && (
          <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6,
            marginTop: 5, fontSize: 10.5, color: "var(--c-low)",
          }}>
            <span>{RULE_FORMAT_LABEL[item.rule_spec.format]}</span>
            <span style={{ color: "var(--c-ghost)" }}>·</span>
            <span>
              {item.rule_spec.scope === "folder"
                ? `Folder: ${folderBasename(item.rule_spec.folder)}`
                : "Global"}
            </span>
            {item.rule_spec.cursor_rule_type && (
              <>
                <span style={{ color: "var(--c-ghost)" }}>·</span>
                <span style={{ textTransform: "capitalize" }}>{item.rule_spec.cursor_rule_type}</span>
              </>
            )}
            {item.rule_spec.globs && (
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--c-ghost)" }}>
                {item.rule_spec.globs}
              </span>
            )}
          </div>
        )}
      </div>
      {item.editable !== false && (
        <>
          <button
            onClick={onEdit}
            title="Edit"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex", padding: 4, flexShrink: 0 }}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={onDelete}
            title="Delete"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex", padding: 4, flexShrink: 0 }}
          >
            <Trash2 size={14} />
          </button>
        </>
      )}
    </div>
  );
}

/* ── McpRedirectCard — the Library doesn't author MCP servers; it points the
   user to Settings → Tools & MCPs (same proven event the Account row uses). */
function McpRedirectCard() {
  const openMcpSettings = () =>
    window.dispatchEvent(new CustomEvent("fleet:open-settings", { detail: { tab: "Tools & MCPs" } }));
  return (
    <div style={{
      border: "1px dashed var(--c-brd)", borderRadius: 10, padding: "32px 24px",
      textAlign: "center", color: "var(--c-low)",
    }}>
      <div style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 40, height: 40, borderRadius: "50%", background: "var(--c-srf)",
        marginBottom: 14, color: "var(--c-dim)",
      }}>
        <Cable size={18} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--c-high)", marginBottom: 6 }}>
        MCP servers live in Settings
      </div>
      <div style={{ fontSize: 12.5, color: "var(--c-low)", lineHeight: 1.5, maxWidth: 380, margin: "0 auto 16px" }}>
        MCP servers are shared across every agent. Add, edit, and authenticate them in Settings → Tools &amp; MCPs.
      </div>
      <button
        onClick={openMcpSettings}
        style={{
          padding: "6px 14px", fontSize: 12.5, fontWeight: 600,
          background: "var(--c-high)", color: "var(--card)", border: "none",
          borderRadius: 7, cursor: "pointer",
        }}
      >
        Manage in Settings
      </button>
    </div>
  );
}
