/**
 * InstalledTab — Settings-card layout. Single "Installed" card
 * holding one row per install. Row body matches Settings rows
 * (icon + name/meta + ⋯ controls); Auto-update toggle reuses the
 * Settings Toggle recipe (pill, 36×21).
 *
 * Each row surfaces the plugin's active scopes inline as small chips
 * — "All projects" for the user scope, the full project folder path
 * for each project scope — with a hover-X to remove one scope
 * without uninstalling the rest. The trailing Uninstall button opens
 * the scope picker dialog (Everywhere / Global / per-project).
 */
import { useMemo, useState } from "react";
import { Loader2, Package, Plus, Settings as SettingsIcon, Trash2, X } from "lucide-react";
import { usePluginStore } from "@/stores/plugin-store";
import type { PluginInstall } from "@/types/plugin";
import { pluginLabel, totalDeclaredComponents } from "@/types/plugin";
import { InstallDialog } from "../install/InstallDialog";
import { UninstallDialog } from "../install/UninstallDialog";

interface Props {
  onOpenDetail: (source_id: string, plugin_path: string) => void;
}

export function InstalledTab({ onOpenDetail }: Props) {
  const installs = usePluginStore(s => s.installs);
  const loading = usePluginStore(s => s.loadingInstalls);

  if (loading && installs.length === 0) {
    return (
      <CenteredHint icon={<Loader2 size={12} className="spin" />} text="Loading installed plugins…" />
    );
  }

  if (installs.length === 0) {
    return (
      <CenteredHint
        icon={<Package size={14} style={{ color: "var(--c-ghost)" }} />}
        text="Nothing installed yet"
        detail="Switch to the Browse tab and pick something useful — an MCP, a skill, a workflow."
      />
    );
  }

  return (
    <div style={{
      borderRadius: 10,
      border: "1px solid var(--sidebar-border)",
      background: "var(--sidebar)",
      overflow: "hidden",
    }}>
      {installs.map((p, i, arr) => (
        <InstalledRow
          key={p.id}
          install={p}
          last={i === arr.length - 1}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </div>
  );
}

function InstalledRow({
  install, last, onOpenDetail,
}: {
  install: PluginInstall;
  last: boolean;
  onOpenDetail: (source_id: string, plugin_path: string) => void;
}) {
  const setMasterEnabled = usePluginStore(s => s.setMasterEnabled);
  const sources = usePluginStore(s => s.sources);
  const [hover, setHover] = useState(false);
  const [addScopeOpen, setAddScopeOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [masterBusy, setMasterBusy] = useState(false);

  const label = pluginLabel(install.manifest);

  const activeScopes = useMemo(
    () => install.enablements.filter(e => e.enabled),
    [install.enablements],
  );

  const d = install.manifest.declares;
  // Provider-aware sum — Codex carries ``prompts`` instead of
  // ``commands``, so the old uniform reduce over the three providers
  // would land NaN on the codex row and break the total. The shared
  // helper in @/types/plugin owns the per-provider field knowledge.
  const totalComponents = totalDeclaredComponents(d);

  // The InstallDialog opens in add-scope mode when handed an
  // existingInstall — same component, different code path inside.
  // We resolve source for the dialog header from the cached sources
  // list so users see consistent metadata across surfaces.
  const source = sources.find(s => s.id === install.source_id);

  return (
    <>
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpenDetail(install.source_id, install.plugin_name)}
      style={{
        display: "flex", alignItems: "center", gap: 14,
        width: "100%",
        padding: "14px 16px",
        background: hover ? "var(--c-srf)" : "transparent",
        borderBottom: last ? "none" : "1px solid var(--sidebar-border)",
        cursor: "pointer",
        transition: "background 0.08s",
      }}
    >
      <div style={{
        width: 30, height: 30, flexShrink: 0,
        borderRadius: 7,
        background: "#ffffff",
        border: "1px solid var(--sidebar-border)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {install.manifest.icon ? (
          <img
            src={install.manifest.icon}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: 18, height: 18, objectFit: "contain" }}
            onError={(e) => {
              // 404'd icon → hide the img and reveal the Package
              // fallback sibling so the row never shows alt text
              // or an empty white square.
              const img = e.currentTarget as HTMLImageElement;
              img.style.display = "none";
              const fallback = img.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = "flex";
            }}
          />
        ) : null}
        <Package
          size={14}
          style={{
            color: "#333",
            display: install.manifest.icon ? "none" : "flex",
          }}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 500, color: "var(--c-high)",
          lineHeight: 1.35,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          marginBottom: 4,
        }}>{label}</div>
        <div style={{
          opacity: install.master_enabled ? 1 : 0.45,
          transition: "opacity 0.15s",
        }}>
          <ScopeChipsRow
            install={install}
            activeScopes={activeScopes}
            onAddScope={() => setAddScopeOpen(true)}
          />
        </div>
        <div style={{
          fontSize: 11, color: "var(--c-ghost)", marginTop: 4,
        }}>
          {totalComponents} component{totalComponents === 1 ? "" : "s"}
          {" · v"}{install.version}
        </div>
      </div>

      <MasterEnableToggle
        on={install.master_enabled}
        busy={masterBusy}
        onChange={async (v) => {
          setMasterBusy(true);
          try {
            await setMasterEnabled(install.id, v);
          } finally {
            setMasterBusy(false);
          }
        }}
      />

      <button
        onClick={(e) => { e.stopPropagation(); onOpenDetail(install.source_id, install.plugin_name); }}
        title="Open detail"
        style={iconBtn}
      ><SettingsIcon size={12} /></button>
      <button
        onClick={(e) => { e.stopPropagation(); setUninstallOpen(true); }}
        title="Uninstall…"
        style={{ ...iconBtn, color: "#f87171" }}
      ><Trash2 size={12} /></button>
    </div>

    {addScopeOpen && source && (
      <InstallDialog
        source_id={install.source_id}
        source_name={source.name}
        source_is_official={source.is_official}
        plugin_path={readSubpath(install)}
        manifest={install.manifest}
        existingInstall={install}
        onClose={() => setAddScopeOpen(false)}
        onSuccess={() => setAddScopeOpen(false)}
      />
    )}
    {uninstallOpen && (
      <UninstallDialog
        install={install}
        onClose={() => setUninstallOpen(false)}
        onSuccess={() => setUninstallOpen(false)}
      />
    )}
    </>
  );
}

/* ── Scope chips ──────────────────────────────────────────────────────
 *  Renders the currently-enabled scopes inline as small pills. The
 *  "+" pill at the end opens the add-scope flow; the × on each pill
 *  removes that one scope (re-uses uninstallScope, no dialog
 *  needed for the single-pill case).
 */
function ScopeChipsRow({
  install, activeScopes, onAddScope,
}: {
  install: PluginInstall;
  activeScopes: PluginInstall["enablements"];
  onAddScope: () => void;
}) {
  const uninstallScope = usePluginStore(s => s.uninstallScope);
  const [removing, setRemoving] = useState<string | null>(null);

  if (activeScopes.length === 0) {
    return (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6,
      }}>
        <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>
          No active scopes
        </span>
        <AddScopeButton onClick={onAddScope} />
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap",
    }}>
      {activeScopes.map(en => {
        const isUser = en.scope_type === "user";
        const key = `${en.scope_type}:${en.scope_id ?? ""}`;
        const isRemoving = removing === key;
        // Project scopes surface the full folder path so the user can
        // tell two identically-named project folders apart at a glance
        // (e.g. ~/work/api and ~/clones/api both basename to "api").
        // The chip itself widens to fit but truncates via maxWidth as
        // a safety net for absurdly deep paths.
        const label = isUser
          ? "All projects"
          : (en.scope_id ?? "Project");
        const fullPath = isUser ? undefined : (en.scope_id ?? undefined);
        return (
          <ScopeChip
            key={key}
            label={label}
            tooltip={fullPath}
            disabled={isRemoving}
            onRemove={async (e) => {
              e.stopPropagation();
              setRemoving(key);
              try {
                await uninstallScope(
                  install.id,
                  en.scope_type as "user" | "project",
                  en.scope_id,
                );
              } finally {
                setRemoving(null);
              }
            }}
          />
        );
      })}
      <AddScopeButton onClick={onAddScope} />
    </div>
  );
}

function ScopeChip({
  label, tooltip, onRemove, disabled,
}: {
  label: string;
  tooltip?: string;
  onRemove: (e: React.MouseEvent) => void;
  disabled?: boolean;
}) {
  const [chipHover, setChipHover] = useState(false);
  return (
    <span
      title={tooltip}
      onMouseEnter={() => setChipHover(true)}
      onMouseLeave={() => setChipHover(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        padding: "1px 6px 1px 8px",
        background: "var(--c-srf2)",
        border: "1px solid var(--c-brd)",
        borderRadius: 999,
        fontSize: 10.5, color: "var(--c-high)",
        lineHeight: 1.4,
        opacity: disabled ? 0.5 : 1,
        transition: "border-color 0.08s",
        maxWidth: "100%",
      }}
    >
      <span style={{
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontFamily: tooltip ? "var(--font-mono)" : undefined,
        fontSize: tooltip ? 10 : 10.5,
      }}>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title="Remove this scope"
        aria-label="Remove scope"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 12, height: 12,
          padding: 0, marginLeft: 1,
          background: "none", border: "none",
          color: chipHover ? "#f87171" : "var(--c-dim)",
          cursor: disabled ? "wait" : "pointer",
          transition: "color 0.08s",
        }}
      >
        <X size={9} strokeWidth={2.5} />
      </button>
    </span>
  );
}

function AddScopeButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Add scope"
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        padding: "1px 7px 1px 6px",
        background: hover ? "var(--c-srf2)" : "transparent",
        border: "1px dashed var(--c-brd)",
        borderRadius: 999,
        fontSize: 10.5, color: "var(--c-dim)",
        lineHeight: 1.4,
        cursor: "pointer",
        transition: "background 0.08s, color 0.08s",
      }}
    >
      <Plus size={9} strokeWidth={2.5} />
      <span>scope</span>
    </button>
  );
}

function readSubpath(install: PluginInstall): string {
  // PluginInstall doesn't carry the original plugin_path subpath
  // directly — it's persisted inside .installed.json on disk. For
  // add-scope from the Installed tab we don't actually need it
  // (backend bypasses the clone path), so an empty string is the
  // safe default. Plugin name matches an existing row → backend
  // detects existing install + routes to _add_scope_to_existing.
  void install;
  return "";
}

function MasterEnableToggle({
  on, busy, onChange,
}: {
  on: boolean;
  busy: boolean;
  onChange: (v: boolean) => void;
}) {
  // Settings Toggle recipe. Green ON / surface OFF. When ON, the
  // plugin's materialised state lives on disk; when OFF, the backend
  // unmaterialises every active scope so files vanish from project +
  // global tiers. Auto-update is a separate concept now handled on
  // the Plugin Detail page settings tab.
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!busy) onChange(!on); }}
      disabled={busy}
      title={on ? "Plugin enabled — click to unmaterialise everywhere" : "Plugin disabled — click to re-materialise"}
      aria-label={on ? "Disable plugin" : "Enable plugin"}
      style={{
        width: 30, height: 18, borderRadius: 999,
        padding: 0, position: "relative",
        border: "1px solid var(--c-brd)",
        background: on ? "rgb(74,222,128)" : "var(--c-srf2)",
        cursor: busy ? "wait" : "pointer",
        flexShrink: 0,
        opacity: busy ? 0.55 : 1,
        transition: "background 0.18s, border-color 0.18s, opacity 0.12s",
      }}
    >
      <span style={{
        position: "absolute",
        top: 1, left: on ? 13 : 1,
        width: 14, height: 14, borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        transition: "left 0.18s cubic-bezier(0.4, 0, 0.2, 1)",
      }} />
    </button>
  );
}

const iconBtn: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 5,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "none", border: "none", cursor: "pointer",
  color: "var(--c-dim)",
  flexShrink: 0,
};

function CenteredHint({
  icon, text, detail,
}: { icon?: React.ReactNode; text: string; detail?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "60px 20px", gap: 6,
      color: "var(--c-low)",
    }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
        {icon}
        <span>{text}</span>
      </div>
      {detail && (
        <div style={{
          fontSize: 11.5, color: "var(--c-ghost)",
          maxWidth: 380, textAlign: "center", lineHeight: 1.5,
        }}>{detail}</div>
      )}
    </div>
  );
}
