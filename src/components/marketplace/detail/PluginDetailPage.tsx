/**
 * Plugin detail page — Settings-card vocabulary throughout.
 *
 * Single clamped column (max 920px) with a header row, sub-tabs
 * underneath, then a two-column body. The right info column is its
 * own Settings-card (border + radius 10 + bg var(--card)) so it
 * reads as a sibling of the Sources / Installed cards elsewhere
 * in the marketplace.
 */
import { Fragment, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2, Package, PanelLeft, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getPluginDetail } from "@/lib/plugin-api";
import { useAppStore } from "@/stores/app-store";
import { usePluginStore } from "@/stores/plugin-store";
import { InstallDialog } from "../install/InstallDialog";
import { UninstallDialog } from "../install/UninstallDialog";
import { SecretsEditor } from "./SecretsEditor";
import { ProviderLogo, providerName } from "@/components/ui/provider-logo";
import { computeUpdateInfo } from "@/lib/plugin-update";
import type { CatalogPlugin, PluginDetail, PluginInstall } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { safeExternalUrl, usesInAppTitleBar } from "@/lib/utils";

/** Open a URL in the user's default browser. In Tauri a bare
 *  `<a target="_blank">` navigates the webview instead of opening externally,
 *  so route through the preload bridge (matching the sidebar's openDocs), with
 *  a window.open fallback for the plain-web/dev case. */
function openExternalUrl(url: string) {
  const safe = safeExternalUrl(url);
  if (!safe) return;
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(safe).catch(() => {});
  } else {
    window.open(safe, "_blank", "noopener,noreferrer");
  }
}

interface Props {
  source_id: string;
  plugin_path: string;
  onBack: () => void;
}

type SubTab = "overview" | "components" | "scopes" | "settings" | "changelog";

/** Synthesize a PluginDetail from a local install when no marketplace
 *  source is usable (Installed-tab open with no/legacy provenance, or a
 *  source that's been removed / is offline). The manifest + scopes drive
 *  the Components / Scopes / Settings / Uninstall tabs; marketplace-only
 *  fields (readme, changelog, repo) are absent and degrade gracefully. */
function localDetailFromInstall(install: PluginInstall, plugin_path: string): PluginDetail {
  return {
    source_id: install.source_id ?? "",
    source_name: "Installed",
    source_is_official: false,
    path: install.plugin_path || plugin_path,
    manifest: install.manifest,
    readme_md: null,
    changelog_md: null,
    repo_url: "",
  };
}

export function PluginDetailPage({ source_id, plugin_path, onBack }: Props) {
  const installs = usePluginStore(s => s.installs);
  const applyUpdate = usePluginStore(s => s.applyUpdate);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [installOpen, setInstallOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // An installed plugin opened from the Installed tab may carry no
    // usable marketplace source_id (installs predating provenance, or a
    // source that was removed). Render those from the local install record
    // instead of fetching — and fall back to it if a marketplace fetch
    // fails for any other reason (offline, deleted source).
    const local = installs.find(
      i => i.plugin_path === plugin_path
        || i.plugin_name === plugin_path
        || i.manifest?.name === plugin_path,
    );
    const noSource = !source_id || source_id === "undefined";
    if (noSource) {
      if (local) setDetail(localDetailFromInstall(local, plugin_path));
      else setError("Plugin not found");
      setLoading(false);
      return;
    }
    let cancelled = false;
    getPluginDetail(source_id, plugin_path)
      .then(d => { if (!cancelled) { setDetail(d); setLoading(false); } })
      .catch(e => {
        if (cancelled) return;
        if (local) setDetail(localDetailFromInstall(local, plugin_path));
        else setError(String(e?.message || e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [source_id, plugin_path, installs]);

  if (loading) {
    return (
      <Wrapper>
        <BackBar onBack={onBack} />
        <div style={{ padding: 60, display: "flex", justifyContent: "center", color: "var(--c-low)", gap: 8, fontSize: 12.5 }}>
          <Loader2 size={13} className="spin" /> Loading…
        </div>
      </Wrapper>
    );
  }

  // `detail.manifest` is typed as required, but the backend can return a
  // detail body without it (a plugin whose manifest failed to parse, or a
  // marketplace folder with no manifest of its own). The rest of this view
  // dereferences `m` unconditionally, so treat a missing manifest as
  // "can't display" here instead of crashing on `m.homepage` below.
  if (error || !detail || !detail.manifest) {
    return (
      <Wrapper>
        <BackBar onBack={onBack} />
        <div style={{ color: "#f87171", marginTop: 16, fontSize: 12.5, padding: "0 24px" }}>
          {error || (detail ? "This plugin's manifest could not be loaded." : "Plugin not found")}
        </div>
      </Wrapper>
    );
  }

  const m = detail.manifest;
  const installed = installs.find(i => i.plugin_name === m.name);
  const safeHomepage = m.homepage ? (safeExternalUrl(m.homepage) ?? null) : null;
  const safeRepo = safeExternalUrl(detail.repo_url) ?? null;

  // `detail.manifest` carries the LATEST (catalog) version, so comparing the
  // active install against it yields the update banner. computeUpdateInfo only
  // reads `catalog.manifest.{version,requires_secrets}`, but we hand it a real
  // CatalogPlugin built from `detail` — every field is present except
  // `featured`, which is marketplace-card-only and irrelevant here.
  const catalogFromDetail: CatalogPlugin = {
    source_id: detail.source_id,
    source_name: detail.source_name,
    source_is_official: detail.source_is_official,
    path: detail.path,
    featured: false,
    manifest: m,
  };
  const update = installed ? computeUpdateInfo(installed, catalogFromDetail) : null;

  // Uninstall now opens a scope picker — choose to remove everything,
  // just the user-scope, or one specific project. Replaces the old
  // confirm("Uninstall …?") that quietly removed everything.
  const onUninstall = () => {
    if (!installed) return;
    setUninstallOpen(true);
  };

  const subTabs: { id: SubTab; label: string }[] = [
    { id: "overview",   label: "Overview" },
    { id: "components", label: "Components" },
    { id: "scopes",     label: "Scopes" },
    { id: "settings",   label: "Settings" },
    { id: "changelog",  label: "Changelog" },
  ];

  return (
    <Wrapper>
      <BackBar onBack={onBack} />

      {/* ── Header card: icon + title + meta + Get/Installed button ── */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 16,
        padding: "16px 18px",
        marginBottom: 18,
        borderRadius: 10,
        border: "1px solid var(--sidebar-border)",
        background: "var(--sidebar)",
      }}>
        <IconTile icon={m.icon} size={48} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{
              margin: 0, fontSize: 18, fontWeight: 600,
              color: "var(--c-high)", letterSpacing: -0.1,
            }}>{pluginLabel(m)}</h1>
            <span style={{
              fontSize: 11.5, color: "var(--c-ghost)",
              fontFamily: "var(--font-mono)",
            }}>v{m.version}</span>
            {detail.source_is_official && (
              <span
                title="Fleetify Official — verified source"
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  color: "var(--c-official)",
                  marginLeft: -2,
                }}
              >
                <ShieldCheck size={13} strokeWidth={2.2} />
              </span>
            )}
          </div>
          <div style={{
            marginTop: 4, fontSize: 12, color: "var(--c-dim)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span>by {m.author?.name ?? "anonymous"}</span>
            <span style={{ color: "var(--c-ghost)" }}>·</span>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 3,
              color: detail.source_is_official ? "var(--c-official)" : "var(--c-dim)",
            }}>
              {detail.source_is_official ? "Fleetify Official" : `from ${detail.source_name}`}
            </span>
          </div>
          <p style={{
            margin: "8px 0 0",
            fontSize: 12.5, color: "var(--c-med)",
            lineHeight: 1.55,
          }}>
            {m.description}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          {installed ? (
            <>
              {update?.updateAvailable && (
                <button
                  onClick={async () => { await applyUpdate(installed.id); }}
                  style={primaryBtn}
                >
                  Update to v{update.newVersion}
                </button>
              )}
              {/* Open the same install dialog in add-scope mode so the
                  user can layer additional scopes (project / global)
                  without going back to the marketplace cards. */}
              <button
                onClick={() => setInstallOpen(true)}
                style={update?.updateAvailable ? ghostBtn : primaryBtn}
              >
                Add scope
              </button>
              <button
                onClick={onUninstall}
                style={ghostBtn}
              >
                <Trash2 size={11} />
                Uninstall
              </button>
            </>
          ) : (
            <button
              onClick={() => setInstallOpen(true)}
              style={primaryBtn}
            >
              Get
            </button>
          )}
        </div>
      </div>

      {/* ── Sub-tabs ── */}
      <div style={{
        display: "flex", gap: 2,
        marginBottom: 14,
        paddingLeft: 1,
      }}>
        {subTabs.map(t => {
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              style={{
                padding: "5px 10px",
                background: active ? "var(--c-srf2)" : "transparent",
                border: "none",
                borderRadius: 5,
                color: active ? "var(--c-high)" : "var(--c-med)",
                fontSize: 12, fontWeight: active ? 500 : 400,
                cursor: "pointer",
                transition: "background 0.08s, color 0.08s",
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
            >{t.label}</button>
          );
        })}
      </div>

      {/* ── Body: two-column (content + info) ── */}
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {subTab === "overview"   && <OverviewBody readme={detail.readme_md} description={m.description} />}
          {subTab === "components" && <ComponentsBody providers={m.providers} declares={m.declares} />}
          {subTab === "scopes"     && <ScopesBody installed={installed ?? null} onAddScope={() => setInstallOpen(true)} />}
          {subTab === "settings"   && <SettingsBody installed={!!installed} installId={installed?.id ?? null} requiresSecrets={m.requires_secrets} />}
          {subTab === "changelog"  && <ChangelogBody changelog={detail.changelog_md} />}
        </div>
        <InfoCard
          repoUrl={safeRepo}
          repoLabel={detail.repo_url.replace(/^https?:\/\/github\.com\//, "")}
          license={m.license}
          providers={m.providers}
          tags={m.tags}
          secrets={m.requires_secrets}
          homepage={safeHomepage}
          minFleetifyVersion={m.min_fleetify_version}
        />
      </div>

      {installOpen && (
        <InstallDialog
          source_id={detail.source_id}
          source_name={detail.source_name}
          source_is_official={detail.source_is_official}
          plugin_path={detail.path}
          manifest={detail.manifest}
          existingInstall={installed}
          onClose={() => setInstallOpen(false)}
          onSuccess={() => setInstallOpen(false)}
        />
      )}
      {uninstallOpen && installed && (
        <UninstallDialog
          install={installed}
          onClose={() => setUninstallOpen(false)}
          onSuccess={() => setUninstallOpen(false)}
        />
      )}
    </Wrapper>
  );
}

/* ── Sub-bodies ─────────────────────────────────────────────────────── */

function OverviewBody({ readme, description }: { readme: string | null; description: string }) {
  if (!readme || !readme.trim()) {
    return (
      <div style={{
        padding: "13px 14px",
        borderRadius: 10,
        border: "1px solid var(--sidebar-border)",
        background: "var(--sidebar)",
        fontSize: 12.5, color: "var(--c-med)",
        lineHeight: 1.6,
      }}>{description}</div>
    );
  }
  return (
    <div style={{
      padding: "16px 18px",
      borderRadius: 10,
      border: "1px solid var(--sidebar-border)",
      background: "var(--sidebar)",
      fontSize: 13, color: "var(--c-med)",
      lineHeight: 1.6,
    }} className="md-detail">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{readme}</ReactMarkdown>
    </div>
  );
}

/** A single "N noun" stat, pluralised. `null` when the count is zero so
 *  empty stats drop out of a provider's line. */
type CountSeg = { n: number; label: string };
function countSeg(n: number | undefined, noun: string): CountSeg | null {
  return n && n > 0 ? { n, label: n === 1 ? noun : `${noun}s` } : null;
}

/** Components tab — one row per agent the plugin targets, each showing that
 *  agent's own skills/hooks PLUS the plugin-wide components (MCP servers /
 *  workflows / templates / prompts) repeated on every row. Those globals
 *  aren't provider-scoped in the manifest, but surfacing them per-agent makes
 *  each agent's full footprint visible at a glance. */
function ComponentsBody({
  providers, declares,
}: {
  providers: string[];
  declares: PluginDetail["manifest"]["declares"];
}) {
  // Plugin-wide stats, shared by every provider row.
  const globalSegs = [
    countSeg(declares.mcp_servers, "MCP server"),
    countSeg(declares.workflows, "workflow"),
    countSeg(declares.templates, "template"),
    countSeg(declares.prompts, "prompt"),
  ].filter((s): s is CountSeg => s !== null);

  // Union of explicitly-targeted providers and any that declare components,
  // preserving the manifest's ordering. Keeps MCP-only agents visible even
  // when they declare no skills/hooks of their own.
  const providerIds = Array.from(
    new Set([...(providers ?? []), ...Object.keys(declares.providers ?? {})]),
  );

  const rows = providerIds
    .map((id) => {
      const pc = declares.providers?.[id];
      const segs = [
        countSeg(pc?.skills, "skill"),
        countSeg(pc?.hooks, "hook"),
        ...globalSegs,
      ].filter((s): s is CountSeg => s !== null);
      return { id, segs };
    })
    .filter((r) => r.segs.length > 0);

  // Plugin ships only plugin-wide components and targets no agents (rare):
  // surface them under a generic row so nothing is silently hidden.
  if (rows.length === 0 && globalSegs.length > 0) {
    rows.push({ id: "__all__", segs: globalSegs });
  }

  if (rows.length === 0) {
    return (
      <div style={emptyCard}>This plugin doesn't declare any components yet.</div>
    );
  }

  return (
    <div style={{
      borderRadius: 10,
      border: "1px solid var(--sidebar-border)",
      background: "var(--sidebar)",
      overflow: "hidden",
    }}>
      {rows.map((r, i) => {
        const generic = r.id === "__all__";
        return (
          <div key={r.id} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 14px",
            borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--c-brd)",
          }}>
            {/* Agent identity — icon + display name. Fixed min-width so the
                stat lines start at the same column across rows. */}
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              minWidth: 152, flexShrink: 0,
            }}>
              {generic
                ? <Package size={16} style={{ color: "var(--c-dim)" }} />
                : <ProviderLogo tool={r.id} size={18} />}
              <span style={{
                fontSize: 13, fontWeight: 500, color: "var(--c-high)",
                whiteSpace: "nowrap",
              }}>
                {generic ? "All agents" : providerName(r.id)}
              </span>
            </div>
            {/* Stat line — "6 skills · 3 hooks · 3 MCP servers". Wraps as a
                whole on narrow widths; trailing middots keep wraps clean. */}
            <div style={{
              flex: 1, minWidth: 0,
              display: "flex", flexWrap: "wrap", alignItems: "baseline",
              columnGap: 6, rowGap: 3,
              fontSize: 12, color: "var(--c-dim)",
            }}>
              {r.segs.map((s, j) => (
                <span key={s.label} style={{ whiteSpace: "nowrap" }}>
                  <span style={{
                    color: "var(--c-med)", fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                  }}>{s.n}</span>
                  {" "}{s.label}
                  {j < r.segs.length - 1 && (
                    <span style={{ color: "var(--c-ghost)", marginLeft: 6 }}>·</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── ScopesBody ─────────────────────────────────────────────────────
 *  Active-scope manager for the currently-shown plugin. Shows every
 *  enabled scope as a stacked row (icon + label + remove-X) and
 *  exposes an Add-scope button that re-opens the install dialog in
 *  add-scope mode. Project rows surface the FULL folder path so two
 *  identically-named folders don't collide visually.
 */
function ScopesBody({
  installed, onAddScope,
}: {
  installed: PluginInstall | null;
  onAddScope: () => void;
}) {
  const uninstallScope = usePluginStore(s => s.uninstallScope);
  const [removing, setRemoving] = useState<string | null>(null);

  if (!installed) {
    return (
      <div style={emptyCard}>
        Install this plugin first — scopes are layered on top of an
        active install.
      </div>
    );
  }

  const activeScopes = installed.enablements.filter(e => e.enabled);

  if (activeScopes.length === 0) {
    return (
      <div style={{
        borderRadius: 10,
        border: "1px solid var(--sidebar-border)",
        background: "var(--sidebar)",
        padding: "16px 18px",
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10,
      }}>
        <div style={{ fontSize: 12.5, color: "var(--c-med)", lineHeight: 1.55 }}>
          No active scopes. The plugin is installed but isn't bound to
          any project or user-wide. Add a scope to materialise it.
        </div>
        <button
          onClick={onAddScope}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "5px 10px",
            background: "var(--c-high)",
            color: "var(--card)",
            border: "none",
            borderRadius: 6,
            fontSize: 11.5, fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Plus size={11} strokeWidth={2.5} /> Add scope
        </button>
      </div>
    );
  }

  return (
    <div style={{
      borderRadius: 10,
      border: "1px solid var(--sidebar-border)",
      background: "var(--sidebar)",
      overflow: "hidden",
    }}>
      {activeScopes.map((en, i) => {
        const isUser = en.scope_type === "user";
        const key = `${en.scope_type}:${en.scope_id ?? ""}`;
        const isRemoving = removing === key;
        return (
          <div
            key={key}
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "11px 14px",
              borderBottom: i === activeScopes.length - 1 ? "none" : "1px solid var(--c-brd)",
            }}
          >
            <div style={{
              width: 20, height: 20, flexShrink: 0,
              borderRadius: 5,
              background: isUser ? "rgba(74,222,128,0.14)" : "var(--c-srf)",
              border: "1px solid",
              borderColor: isUser ? "rgba(74,222,128,0.40)" : "var(--c-brd)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: isUser ? "#4ade80" : "var(--c-dim)",
              fontSize: 10, fontWeight: 700,
            }}>
              {isUser ? "G" : "P"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 12.5, fontWeight: 500, color: "var(--c-high)",
                lineHeight: 1.3,
              }}>
                {isUser ? "Global — all my projects" : "Project"}
              </div>
              {!isUser && (
                <div
                  title={en.scope_id ?? undefined}
                  style={{
                    marginTop: 2,
                    fontSize: 11, color: "var(--c-dim)",
                    fontFamily: "var(--font-mono)",
                    wordBreak: "break-all",
                    lineHeight: 1.4,
                  }}
                >
                  {en.scope_id}
                </div>
              )}
              {isUser && (
                <div style={{
                  marginTop: 2,
                  fontSize: 11, color: "var(--c-dim)",
                  lineHeight: 1.4,
                }}>
                  Materialised once at the user tier; every Fleet
                  session inherits it.
                </div>
              )}
            </div>
            <button
              onClick={async () => {
                setRemoving(key);
                try {
                  await uninstallScope(
                    installed.id,
                    en.scope_type as "user" | "project",
                    en.scope_id,
                  );
                } finally {
                  setRemoving(null);
                }
              }}
              disabled={isRemoving}
              title="Remove this scope"
              aria-label="Remove scope"
              style={{
                flexShrink: 0,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 5,
                background: "none",
                border: "1px solid var(--sidebar-border)",
                color: isRemoving ? "var(--c-ghost)" : "var(--c-dim)",
                cursor: isRemoving ? "wait" : "pointer",
                transition: "color 0.08s, background 0.08s, border-color 0.08s",
              }}
              onMouseEnter={e => {
                if (isRemoving) return;
                (e.currentTarget as HTMLElement).style.color = "#f87171";
                (e.currentTarget as HTMLElement).style.borderColor = "rgba(248,113,113,0.40)";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.color = isRemoving ? "var(--c-ghost)" : "var(--c-dim)";
                (e.currentTarget as HTMLElement).style.borderColor = "var(--sidebar-border)";
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <div style={{
        padding: "10px 14px",
        borderTop: "1px solid var(--c-brd)",
        background: "var(--c-srf)",
      }}>
        <button
          onClick={onAddScope}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "5px 10px",
            background: "transparent",
            color: "var(--c-high)",
            border: "1px dashed var(--c-brd)",
            borderRadius: 6,
            fontSize: 11.5, fontWeight: 500,
            cursor: "pointer",
            transition: "background 0.08s, border-color 0.08s",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = "var(--c-srf2)";
            (e.currentTarget as HTMLElement).style.borderColor = "var(--c-high)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
            (e.currentTarget as HTMLElement).style.borderColor = "var(--c-brd)";
          }}
        >
          <Plus size={11} strokeWidth={2.5} /> Add scope
        </button>
      </div>
    </div>
  );
}

function SettingsBody({ installed, installId, requiresSecrets }: {
  installed: boolean;
  installId: string | null;
  requiresSecrets: PluginDetail["manifest"]["requires_secrets"];
}) {
  if (!installed || !installId) {
    return (
      <div style={emptyCard}>
        Install this plugin to manage its secrets + scope.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <AutoUpdateToggle installId={installId} />
      <SecretsEditor installId={installId} requiresSecrets={requiresSecrets} />
    </div>
  );
}

/** Per-plugin auto-update switch. Reads the install's `auto_update` flag from
 *  the store (defaulting ON when the install can't be found mid-refresh) and
 *  writes through `setAutoUpdate`. When ON, the launch sweep silently applies
 *  *safe* updates (non-major, no newly-required secret); major / secret-adding
 *  updates always wait for an explicit click regardless of this flag. */
function AutoUpdateToggle({ installId }: { installId: string }) {
  const installs = usePluginStore(s => s.installs);
  const setAutoUpdate = usePluginStore(s => s.setAutoUpdate);
  const inst = installs.find(i => i.id === installId);
  const on = inst?.auto_update ?? true;
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 8,
      fontSize: 12.5, color: "var(--c-med)", cursor: "pointer",
    }}>
      <input
        type="checkbox"
        checked={on}
        onChange={e => void setAutoUpdate(installId, e.target.checked)}
      />
      Auto-update this plugin (safe updates apply automatically)
    </label>
  );
}

function ChangelogBody({ changelog }: { changelog: string | null }) {
  if (!changelog || !changelog.trim()) {
    return <div style={emptyCard}>No changelog published.</div>;
  }
  return (
    <div style={{
      padding: "16px 18px",
      borderRadius: 10,
      border: "1px solid var(--sidebar-border)",
      background: "var(--sidebar)",
      fontSize: 13, color: "var(--c-med)",
      lineHeight: 1.6,
    }} className="md-detail">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{changelog}</ReactMarkdown>
    </div>
  );
}

/* ── Right info card ───────────────────────────────────────────────── */

function InfoCard({
  repoUrl, repoLabel, license, providers, tags, secrets, homepage, minFleetifyVersion,
}: {
  repoUrl: string | null;
  repoLabel: string;
  license?: string;
  providers: string[];
  tags: string[];
  secrets: PluginDetail["manifest"]["requires_secrets"];
  homepage: string | null;
  minFleetifyVersion?: string;
}) {
  return (
    <aside style={{
      width: 240, flexShrink: 0,
      borderRadius: 10,
      border: "1px solid var(--sidebar-border)",
      background: "var(--sidebar)",
      padding: "14px 14px 10px",
    }}>
      <Row label="Repository">
        {repoUrl ? (
          <a
            href={repoUrl}
            onClick={(e) => { e.preventDefault(); openExternalUrl(repoUrl); }}
            style={linkStyle}
          >
            {repoLabel} <ExternalLink size={10} />
          </a>
        ) : repoLabel}
      </Row>
      {homepage && (
        <Row label="Homepage">
          <a
            href={homepage}
            onClick={(e) => { e.preventDefault(); openExternalUrl(homepage); }}
            style={linkStyle}
          >
            {homepage.replace(/^https?:\/\//, "")} <ExternalLink size={10} />
          </a>
        </Row>
      )}
      {license && <Row label="License">{license}</Row>}
      <Row label="Providers">
        {providers.length > 0 ? (
          <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6,
          }}>
            {providers.map((id, i) => (
              <Fragment key={id}>
                {i > 0 && <span style={{ color: "var(--c-ghost)", userSelect: "none" }}>·</span>}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <ProviderLogo tool={id} size={12} />
                  {providerName(id)}
                </span>
              </Fragment>
            ))}
          </div>
        ) : (
          <span style={{ color: "var(--c-ghost)" }}>—</span>
        )}
      </Row>
      {tags.length > 0 && (
        <Row label="Tags">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tags.map(t => (
              <span key={t} style={{
                fontSize: 11, padding: "2px 7px",
                background: "var(--c-srf)",
                border: "1px solid var(--c-brd)",
                borderRadius: 999,
                color: "var(--c-low)",
              }}>{t}</span>
            ))}
          </div>
        </Row>
      )}
      {secrets.length > 0 && (
        <Row label="Secrets">
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {secrets.map(s => (
              <li key={s.key} style={{ marginBottom: 4, fontSize: 11.5, color: "var(--c-low)" }}>
                <code style={mono}>{s.key}</code>
                {s.label && (
                  <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 2 }}>
                    {s.label}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Row>
      )}
      {minFleetifyVersion && (
        <Row label="Requires Fleetify">{minFleetifyVersion}+</Row>
      )}
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 10.5, fontWeight: 600,
        color: "var(--c-dim)",
        letterSpacing: "0.10em",
        textTransform: "uppercase",
        marginBottom: 5,
      }}>{label}</div>
      <div style={{ fontSize: 12, color: "var(--c-med)", lineHeight: 1.5, wordBreak: "break-word" }}>
        {children}
      </div>
    </div>
  );
}

/* ── Small pieces ──────────────────────────────────────────────────── */

function Wrapper({ children }: { children: React.ReactNode }) {
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  // Windows owns the sidebar toggle in its dedicated title bar — suppress
  // the page-level toggle (and traffic-light inset) there. macOS keeps it.
  const inAppBar = usesInAppTitleBar();

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", height: "100%",
      background: "var(--card)",
      color: "var(--c-high)",
      overflow: "hidden",
      animation: "mp-detail-enter 0.26s cubic-bezier(0.22, 1, 0.36, 1) both",
    }}>
      <style>{`
        @keyframes mp-detail-enter {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Top bar — drag region. Mirrors the marketplace page chrome so
          window drag + sidebar-toggle stay reachable from the detail
          view too. */}
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

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "4px 24px 40px" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 8px 5px 6px",
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "var(--c-med)",
        fontSize: 12.5, fontWeight: 500,
        cursor: "pointer",
        marginBottom: 16,
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
      <ArrowLeft size={13} /> Back to Marketplace
    </button>
  );
}

function IconTile({ icon, size }: { icon?: string; size: number }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      borderRadius: size >= 40 ? 10 : 7,
      background: "#ffffff",
      border: "1px solid var(--sidebar-border)",
      display: "flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden",
    }}>
      {icon ? (
        <img
          src={icon}
          alt=""
          referrerPolicy="no-referrer"
          style={{
            width: Math.round(size * 0.65),
            height: Math.round(size * 0.65),
            objectFit: "contain",
          }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : (
        <Package size={Math.round(size * 0.4)} style={{ color: "#333" }} />
      )}
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  color: "var(--c-med)",
  display: "inline-flex", alignItems: "center", gap: 4,
  textDecoration: "none",
};

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  padding: "1px 5px",
  background: "var(--c-srf2)",
  borderRadius: 3,
  color: "var(--c-high)",
};

const primaryBtn: React.CSSProperties = {
  padding: "6px 16px",
  background: "var(--c-high)",
  color: "var(--card)",
  border: "none", borderRadius: 7,
  fontSize: 12.5, fontWeight: 600,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 12px",
  background: "transparent",
  color: "var(--c-low)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  fontSize: 12, fontWeight: 500,
  cursor: "pointer",
};

const emptyCard: React.CSSProperties = {
  padding: "16px 18px",
  borderRadius: 10,
  border: "1px solid var(--sidebar-border)",
  background: "var(--sidebar)",
  fontSize: 12.5, color: "var(--c-low)",
  lineHeight: 1.55,
};
