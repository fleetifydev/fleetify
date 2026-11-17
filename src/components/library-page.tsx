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
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, Library as LibraryIcon, FileText, Sparkles, Webhook,
  Workflow, LayoutTemplate, Cable, Package, HelpCircle, MessageCircle,
  Plus, Trash2, Pencil, Bot, ScrollText,
  MoreHorizontal, FolderOpen, Copy, Search, X,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { usePluginStore } from "@/stores/plugin-store";
import { useLibraryStore } from "@/stores/library-store";
import { CreateItemDialog } from "./library/create-item-dialog";
import { RuleForm } from "./library/rule-form";
import { HookForm } from "./library/hook-form";
import { ProviderLogo, providerName } from "@/components/ui/provider-logo";
import type { LibraryKind, LibraryItem } from "@/lib/library-api";
import type { PluginInstall } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { usesInAppTitleBar } from "@/lib/utils";
import { WindowsTitleBar } from "./layout/windows-title-bar";
import { openDocs } from "./layout/sidebar";
import { FeedbackModal } from "./feedback-modal";
import { SidebarShell, SideRow } from "./layout/sidebar-shell";
import { AccountFooter } from "./layout/account-footer";

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

/* ── LibrarySidebar ──
   The library sidebar extracted into its own exported component so it
   can be unit-tested in isolation and so the chrome is rendered by the
   shared SidebarShell primitive (same card/rail as Settings). */
export function LibrarySidebar({
  active, setActive, onClose, setFeedbackOpen, totals,
}: {
  active: SectionId;
  setActive: (id: SectionId) => void;
  onClose: () => void;
  setFeedbackOpen: (v: boolean) => void;
  totals: Record<SectionId, number>;
}) {
  // Library is a full-viewport route (app-shell isn't mounted), so it
  // reads the shared sidebar width from the store and passes it to the
  // shell — keeping it in lockstep with the Fleet sidebar the user drags.
  const leftWidth = useAppStore(s => s.leftWidth);
  const backArrow = usesInAppTitleBar() ? null : (
    <button
      onClick={onClose}
      title="Back (Esc)"
      style={{
        width: 24, height: 24, borderRadius: 5, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "none", border: "none", cursor: "pointer",
        color: "var(--c-dim)", outline: "none",
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
  );
  return (
    <SidebarShell
      width={leftWidth}
      caption={{ icon: <LibraryIcon size={13} />, label: "Library" }}
      topBar={backArrow}
      footer={
        <>
          <SideRow icon={<HelpCircle size={16} />} label="Get Help" onClick={openDocs} />
          <SideRow icon={<MessageCircle size={16} />} label="Give Feedback" onClick={() => setFeedbackOpen(true)} />
          <AccountFooter />
        </>
      }
    >
      {NAV.map(item => (
        <SideRow
          key={item.id}
          icon={<item.icon size={16} />}
          label={item.id}
          count={totals[item.id]}
          active={active === item.id}
          onClick={() => setActive(item.id)}
        />
      ))}
    </SidebarShell>
  );
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
      {/* ── Sidebar — rendered by shared SidebarShell (same chrome as Settings). */}
      <LibrarySidebar
        active={active}
        setActive={setActive}
        onClose={onClose}
        setFeedbackOpen={setFeedbackOpen}
        totals={totals}
      />

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
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.slug.toLowerCase().includes(q) ||
        (it.description ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);
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
      {items.length > 0 && (
        <SearchBox value={query} onChange={setQuery} placeholder={`Search ${kind}s by name…`} />
      )}
      {items.length === 0 ? (
        <div style={{
          border: "1px dashed var(--c-brd)", borderRadius: 10, padding: 24,
          textAlign: "center", color: "var(--c-low)", fontSize: 12.5,
        }}>
          No {kind}s yet — create one or install a plugin.
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          border: "1px dashed var(--c-brd)", borderRadius: 10, padding: 24,
          textAlign: "center", color: "var(--c-low)", fontSize: 12.5,
        }}>
          No {kind}s match “{query}”.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((it) => (
            <UserItemRow key={it.id} item={it} onEdit={() => onEdit(it)} onDelete={() => onDelete(it.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact search input used at the top of each Library section. */
function SearchBox({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div style={{ position: "relative", marginBottom: 12 }}>
      <Search
        size={13}
        style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--c-dim)", pointerEvents: "none" }}
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", boxSizing: "border-box", padding: "7px 28px 7px 30px", fontSize: 12.5,
          background: "var(--c-srf)", color: "var(--c-high)", border: "1px solid var(--c-brd)",
          borderRadius: 8, outline: "none",
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex" }}
        >
          <X size={13} />
        </button>
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

/** Per-item actions menu (⋯): open file location / open raw file / copy path,
 *  plus Edit / Delete for authored items. Reuses the app's portal-popover idiom. */
export function RowMenu({
  item, onEdit, onDelete,
}: {
  item: LibraryItem;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const editable = item.editable !== false;
  const path = item.primary_path;
  // Read-only plugin row with no on-disk file → no actions, no menu.
  if (!editable && !path) return null;

  const reveal = () => {
    if (path) window.electronAPI?.showItemInFolder?.(path)?.catch(() => {});
  };
  const openRaw = () => {
    if (path) window.electronAPI?.openPath?.(path)?.catch(() => {});
  };
  const copyPath = () => {
    if (path) navigator.clipboard?.writeText(path)?.catch(() => {});
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Actions"
        title="Actions"
        style={{
          width: 28, height: 28, borderRadius: 6, flexShrink: 0,
          background: open ? "var(--c-srf)" : "none", border: "none", cursor: "pointer",
          color: "var(--c-dim)", display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: "fixed", top: pos.top, right: pos.right, minWidth: 190, zIndex: 2000,
            background: "var(--card)", border: "1px solid var(--c-brd)", borderRadius: 8, padding: 4,
            boxShadow: "0 10px 28px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.3)",
            animation: "fleet-popover-in 0.12s ease-out",
          }}
        >
          {path && (
            <>
              <MenuItem icon={<FolderOpen size={13} />} label="Open file location" onClick={() => { setOpen(false); reveal(); }} />
              <MenuItem icon={<FileText size={13} />} label="Open raw file" onClick={() => { setOpen(false); openRaw(); }} />
              <MenuItem icon={<Copy size={13} />} label="Copy path" onClick={() => { setOpen(false); copyPath(); }} />
              {editable && <div style={{ height: 1, background: "var(--c-brd)", margin: "4px 2px" }} />}
            </>
          )}
          {editable && (
            <>
              <MenuItem icon={<Pencil size={13} />} label="Edit" onClick={() => { setOpen(false); onEdit(); }} />
              <MenuItem icon={<Trash2 size={13} />} label="Delete" danger onClick={() => { setOpen(false); onDelete(); }} />
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({
  icon, label, onClick, danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const color = danger ? "var(--c-danger, #d44)" : "var(--c-high)";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 9px",
        borderRadius: 6, border: "none", background: hover ? "var(--c-srf)" : "transparent",
        color, fontSize: 12.5, cursor: "pointer", textAlign: "left",
      }}
    >
      <span style={{ display: "flex", flexShrink: 0, color: danger ? color : "var(--c-dim)" }}>{icon}</span>
      {label}
    </button>
  );
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
      <RowMenu item={item} onEdit={onEdit} onDelete={onDelete} />
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
