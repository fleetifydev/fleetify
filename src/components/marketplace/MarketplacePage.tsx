/**
 * Marketplace — App-Store-style Discover surface.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Discover                              [✓ Installed] [⚙]   │
 *   │ tagline                                                   │
 *   │ ┌─ Search ────────────────────────────────────────── ⌘K ┐ │
 *   │                                                           │
 *   │ ┌── HERO ─────────────────────────────────────────────┐  │
 *   │ │ THIS WEEK'S PICK                                    │  │
 *   │ │ Big headline                          [logo]        │  │
 *   │ │ subhead                                             │  │
 *   │ │ [Install]  [Read story →]                           │  │
 *   │ └─────────────────────────────────────────────────────┘  │
 *   │                                                           │
 *   │ POPULAR THIS WEEK                                See all →│
 *   │ [card] [card] [card] [card] [card] →  (horiz scroll)      │
 *   │                                                           │
 *   │ BUILD WITH CODE                                  See all →│
 *   │ [wide]   [wide]   [wide]              (3-col grid)        │
 *   │                                                           │
 *   │ NEW & NOTEWORTHY                                 See all →│
 *   │ [list]      [list]                    (2-col grid)        │
 *   └───────────────────────────────────────────────────────────┘
 *
 * No left category rail — filtering happens via search.
 * Installed/Sources live behind header pills, not as sibling tabs.
 */
import { useEffect, useState } from "react";
import { PanelLeft, Settings as SettingsIcon, Check, Plus } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { isWindowsPlatform } from "@/lib/utils";
import { usePluginStore } from "@/stores/plugin-store";
import type { CatalogPlugin } from "@/types/plugin";
import { BrowseTab } from "./browse/BrowseTab";
import { InstalledTab } from "./installed/InstalledTab";
import { SourcesTab } from "./sources/SourcesTab";
import { PublishView } from "./publish/PublishView";
import { PluginDetailPage } from "./detail/PluginDetailPage";
import { InstallDialog } from "./install/InstallDialog";

type View =
  | { kind: "discover" }
  | { kind: "installed" }
  | { kind: "sources" }
  | { kind: "publish" };

interface QueryState {
  view: View;
  pluginRoute: { source_id: string; plugin_path: string } | null;
}

function readQuery(): QueryState {
  const u = new URLSearchParams(window.location.search);
  const tab = u.get("tab");
  const view: View =
    tab === "installed" ? { kind: "installed" }
    : tab === "sources" ? { kind: "sources" }
    : tab === "publish" ? { kind: "publish" }
    : { kind: "discover" };

  const plugin = u.get("plugin");
  let pluginRoute: QueryState["pluginRoute"] = null;
  if (plugin && plugin.includes(":")) {
    const idx = plugin.indexOf(":");
    pluginRoute = { source_id: plugin.slice(0, idx), plugin_path: plugin.slice(idx + 1) };
  }
  return { view, pluginRoute };
}

function writeQuery(q: QueryState) {
  const u = new URLSearchParams(window.location.search);
  u.delete("tab"); u.delete("cat");
  if (q.view.kind === "installed") u.set("tab", "installed");
  else if (q.view.kind === "sources") u.set("tab", "sources");
  else if (q.view.kind === "publish") u.set("tab", "publish");

  if (q.pluginRoute) u.set("plugin", `${q.pluginRoute.source_id}:${q.pluginRoute.plugin_path}`);
  else u.delete("plugin");
  const qs = u.toString();
  const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState({}, "", newUrl);
}

export function MarketplacePage() {
  const [state, setStateRaw] = useState<QueryState>(readQuery());
  const [quickInstall, setQuickInstall] = useState<CatalogPlugin | null>(null);
  const refreshAll = usePluginStore(s => s.refreshAll);
  const refreshCatalog = usePluginStore(s => s.refreshCatalog);
  const installs = usePluginStore(s => s.installs);
  const sources = usePluginStore(s => s.sources);
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  // Windows owns the sidebar toggle in its dedicated title bar — suppress
  // the page-level toggle (and traffic-light inset) there. macOS keeps it.
  const isWindows = isWindowsPlatform();

  useEffect(() => {
    refreshAll();
    refreshCatalog();
  }, [refreshAll, refreshCatalog]);

  const setState = (next: QueryState) => {
    setStateRaw(next);
    writeQuery(next);
  };

  const openDetail = (source_id: string, plugin_path: string) =>
    setState({ ...state, pluginRoute: { source_id, plugin_path } });
  const closeDetail = () => setState({ ...state, pluginRoute: null });

  // Quick-install gateway — Get button on a card opens this dialog
  // directly without first routing to the detail page. The dialog
  // needs the source row (name, official flag) which we resolve from
  // the source list here so cards don't have to carry it.
  const onQuickInstall = (plugin: CatalogPlugin) => setQuickInstall(plugin);
  const quickInstallSource = quickInstall
    ? sources.find(s => s.id === quickInstall.source_id) ?? null
    : null;

  if (state.pluginRoute) {
    return (
      <PluginDetailPage
        source_id={state.pluginRoute.source_id}
        plugin_path={state.pluginRoute.plugin_path}
        onBack={closeDetail}
      />
    );
  }

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", height: "100%",
      background: "var(--card)",
      color: "var(--c-high)",
      overflow: "hidden",
      animation: "mp-fade-up 0.26s cubic-bezier(0.22, 1, 0.36, 1) both",
    }}>
      <style>{`
        @keyframes mp-fade-up {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes mp-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
      {/* Top bar — drag region + sidebar toggle when collapsed. */}
      <div className="drag-region" style={{
        height: 44, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 16px",
        background: "var(--card)",
        zIndex: 2,
      }}>
        {!isWindows && sidebarCollapsed && (
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

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "4px 32px 56px",
        }}>
          {/* Header — title + subtitle + Installed/Sources pills */}
          <header style={{
            display: "flex", alignItems: "flex-start", justifyContent: "space-between",
            gap: 16,
            marginBottom: 18,
          }}>
            <div>
              <h1 style={{
                margin: 0, padding: 0,
                fontSize: 22, fontWeight: 600,
                color: "var(--c-high)",
                letterSpacing: "-0.01em",
                lineHeight: 1.1,
              }}>
                {state.view.kind === "discover" ? "Discover" :
                 state.view.kind === "installed" ? "Installed" :
                 state.view.kind === "sources" ? "Sources" : "Publish"}
              </h1>
              <p style={{
                margin: "4px 0 0",
                fontSize: 12, color: "var(--c-dim)",
                lineHeight: 1.45,
              }}>
                {state.view.kind === "discover"
                  ? "Plugins, skills, MCPs and hooks for your agents."
                  : state.view.kind === "installed"
                  ? "What's currently active across your agents."
                  : state.view.kind === "sources"
                  ? "Marketplace catalogs Fleet pulls plugins from."
                  : "Build a plugin and put it in front of every Fleet user."}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <HeaderPill
                active={state.view.kind === "publish"}
                onClick={() => setState({ ...state, view: state.view.kind === "publish" ? { kind: "discover" } : { kind: "publish" } })}
                icon={<Plus size={11} strokeWidth={2.2} />}
                label="Publish"
              />
              <HeaderPill
                active={state.view.kind === "installed"}
                onClick={() => setState({ ...state, view: state.view.kind === "installed" ? { kind: "discover" } : { kind: "installed" } })}
                icon={<Check size={11} />}
                label={installs.length > 0 ? `Installed ${installs.length}` : "Installed"}
              />
              <HeaderPill
                active={state.view.kind === "sources"}
                onClick={() => setState({ ...state, view: state.view.kind === "sources" ? { kind: "discover" } : { kind: "sources" } })}
                icon={<SettingsIcon size={11} />}
                label="Sources"
              />
            </div>
          </header>

          {state.view.kind === "discover" && (
            <BrowseTab onOpenDetail={openDetail} onQuickInstall={onQuickInstall} />
          )}
          {state.view.kind === "installed" && <InstalledTab onOpenDetail={openDetail} />}
          {state.view.kind === "sources"   && <SourcesTab />}
          {state.view.kind === "publish"   && (
            <PublishView onClose={() => setState({ ...state, view: { kind: "discover" } })} />
          )}
        </div>
      </div>

      {/* Quick-install dialog — opened by the Get button on any card.
          Lives at page level so it can stretch across all surfaces and
          isn't clipped by section overflow. */}
      {quickInstall && quickInstallSource && (
        <InstallDialog
          source_id={quickInstall.source_id}
          source_name={quickInstallSource.name}
          source_is_official={quickInstallSource.is_official}
          plugin_path={quickInstall.path}
          manifest={quickInstall.manifest}
          existingInstall={installs.find(
            i => i.plugin_name === quickInstall.manifest.name,
          )}
          onClose={() => setQuickInstall(null)}
          onSuccess={() => setQuickInstall(null)}
        />
      )}
    </div>
  );
}

function HeaderPill({
  active, onClick, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "5px 10px",
        background: active ? "var(--c-srf2)" : "transparent",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 7,
        color: active ? "var(--c-high)" : "var(--c-med)",
        fontSize: 11.5, fontWeight: 500,
        cursor: "pointer",
        transition: "background 0.08s, color 0.08s, border-color 0.08s",
      }}
      onMouseEnter={e => {
        if (active) return;
        (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
        (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
      }}
      onMouseLeave={e => {
        if (active) return;
        (e.currentTarget as HTMLElement).style.background = "transparent";
        (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
      }}
    >
      {icon} {label}
    </button>
  );
}
