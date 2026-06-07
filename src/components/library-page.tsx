/**
 * Library page — full-viewport route showing what's installed
 *   across all the user's plugins, sliced by content type.
 *
 * Sits next to Settings: Settings is "how Fleet behaves", Library is
 * "what's available to your agents right now". The seven tabs mirror
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
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Library as LibraryIcon, FileText, Sparkles, Terminal, Webhook,
  Workflow, LayoutTemplate, Cable, Package, HelpCircle, MessageCircle,
  User, Sun,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { usePluginStore } from "@/stores/plugin-store";
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
  | "Commands"
  | "Hooks"
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
    id: "Commands", icon: Terminal,
    blurb: "Slash commands the Claude / Gemini CLIs surface to you.",
  },
  {
    id: "Hooks", icon: Webhook,
    blurb: "Lifecycle hook handlers wired into the agent's tool calls.",
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

/** Sum the components that a single plugin install contributes to a
 *  given section. Mirrors the rules in `deriveProvides` so the counts
 *  match the marketplace's filter chips one-to-one. */
function countForSection(inst: PluginInstall, section: SectionId): number {
  const d = inst.manifest.declares;
  const pv = Object.values(d.providers ?? {});
  switch (section) {
    case "Prompts":   return d.prompts ?? 0;
    case "Skills":    return pv.reduce((s, p) => s + p.skills, 0);
    case "Commands":  return pv.reduce((s, p) => s + p.commands, 0);
    case "Hooks":     return pv.reduce((s, p) => s + p.hooks, 0);
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

  // Refresh once on open so the page doesn't show stale install state
  // from a cold-mount that happened before the user installed anything.
  useEffect(() => { void refreshInstalls(); }, [refreshInstalls]);

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
      Prompts: 0, Skills: 0, Commands: 0, Hooks: 0,
      Workflows: 0, Templates: 0, MCP: 0,
    };
    for (const inst of installs) {
      for (const sec of NAV) out[sec.id] += countForSection(inst, sec.id);
    }
    return out;
  }, [installs]);

  // Plugins that contribute at least one item to the active section.
  // Sorted by descending count so the heaviest contributor lands first
  // — same pattern the marketplace catalog uses for editor's-picks.
  const contributors = useMemo(() => {
    return installs
      .map(inst => ({ inst, count: countForSection(inst, active) }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [installs, active]);

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

            {loadingInstalls && installs.length === 0 ? (
              <CenteredHint text="Loading installed plugins…" />
            ) : contributors.length === 0 ? (
              <EmptyState section={active} onBrowse={openMarketplace} />
            ) : (
              <ContributorList contributors={contributors} />
            )}
          </div>
        </div>
      </div>
      </div>
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
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
