/**
 * InstallDialog — secret + scope picker shown when the user fires "Get"
 * on a plugin. Lives at marketplace page level so it can host any
 * card's install action, not just the detail page's.
 *
 * Visual recipe matches the rest of the marketplace: var(--sidebar)
 * card surface, var(--sidebar-border) 1px outline, radius 12, scrim
 * rgba(0,0,0,0.55) over the page. Primary button uses the same
 * `var(--c-high) / var(--card)` inverse pair every Get button across
 * the surface uses (so the install CTA has identical typography in
 * every theme — light, dark, oled, gruvbox, etc).
 *
 * Scope picker: two options — "All my projects" (user scope) or
 * "Specific projects" (a multi-select dropdown of every distinct
 * folder path the user currently has an active session on). For
 * multi-project installs, the dialog calls the install API once with
 * the first selected path as the initial enablement, then
 * sequentially POSTs /scope for each additional path. A failure on
 * any of the follow-up enablements is non-fatal to the install — the
 * plugin is already on disk — so we surface it as an inline warning
 * instead of rolling back.
 */
import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X, ExternalLink, ShieldCheck } from "lucide-react";
import { usePluginStore } from "@/stores/plugin-store";
import { useAppStore } from "@/stores/app-store";
import type { PluginInstall, PluginManifest } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { safeExternalUrl } from "@/lib/utils";

interface Props {
  source_id: string;
  source_name: string;
  source_is_official: boolean;
  plugin_path: string;
  manifest: PluginManifest;
  /** When supplied the dialog runs in add-scope mode: secrets are
   *  hidden (already stored), the scope picker filters out
   *  already-enabled scopes, and submit calls setScope rather than
   *  re-running the install pipeline. The fresh-install path stays
   *  exactly as it was when this prop is omitted. */
  existingInstall?: PluginInstall;
  onClose: () => void;
  onSuccess: () => void;
}

type ScopeChoice = "user" | "specific";

const COMPONENT_LABELS = {
  mcp_servers: "MCP server",
  templates: "agent template",
  workflows: "workflow",
  skills: "skill",
  commands: "slash command",
  prompts: "Codex prompt",
  hooks: "hook",
} as const;

function aggregateCounts(d: PluginManifest["declares"]) {
  // Provider-scoped components are summed across providers for the install
  // dialog summary; the detail page is where we break them out per provider.
  //
  // Codex is asymmetric — its declares carry ``prompts`` (the Codex CLI
  // auto-loads them from ~/.codex/prompts/) rather than ``commands``. We
  // sum the two field families independently so the summary surfaces them
  // as separate rows ("3 slash commands" + "1 Codex prompt") instead of
  // silently producing NaN by adding ``codex.commands`` (the old shape
  // the type system no longer recognises).
  const provSkills = d.providers.claude.skills + d.providers.gemini.skills + d.providers.codex.skills;
  const provCommands = d.providers.claude.commands + d.providers.gemini.commands;
  const provPrompts = d.providers.codex.prompts;
  const provHooks = d.providers.claude.hooks + d.providers.gemini.hooks + d.providers.codex.hooks;
  return {
    mcp_servers: d.mcp_servers,
    templates: d.templates,
    workflows: d.workflows,
    skills: provSkills,
    commands: provCommands,
    prompts: provPrompts,
    hooks: provHooks,
  };
}

export function InstallDialog({
  source_id, source_name, source_is_official, plugin_path, manifest,
  existingInstall, onClose, onSuccess,
}: Props) {
  const install = usePluginStore(s => s.install);
  const setScope = usePluginStore(s => s.setScope);
  const sessions = useAppStore(s => s.sessions);

  const isAddScopeMode = !!existingInstall;
  // Set of scope-keys ("user", "project:/path/to/repo") that are
  // already enabled for this plugin. In add-scope mode the picker
  // hides these so the user can only pick scopes they don't have.
  const enabledScopeKeys = useMemo(() => {
    const out = new Set<string>();
    if (!existingInstall) return out;
    for (const en of existingInstall.enablements) {
      if (!en.enabled) continue;
      if (en.scope_type === "user") out.add("user");
      else if (en.scope_type === "project" && en.scope_id) {
        out.add(`project:${en.scope_id}`);
      }
    }
    return out;
  }, [existingInstall]);

  // Unique non-empty project paths from sessions the user hasn't
  // archived. Sorted so the dropdown order is stable across opens.
  // In add-scope mode we filter out paths the plugin is already
  // enabled for.
  const projectPaths = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.archived_at) continue;
      if (!s.project_path) continue;
      if (isAddScopeMode && enabledScopeKeys.has(`project:${s.project_path}`)) continue;
      set.add(s.project_path);
    }
    return Array.from(set).sort();
  }, [sessions, isAddScopeMode, enabledScopeKeys]);

  const userScopeAvailable = !isAddScopeMode || !enabledScopeKeys.has("user");
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>(
    userScopeAvailable ? "user" : "specific",
  );
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const togglePath = (path: string) => {
    setSelectedPaths(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path],
    );
  };

  const canSubmit = !busy && (
    scopeChoice === "user" ||
    (scopeChoice === "specific" && selectedPaths.length > 0)
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      // Build the list of scopes to apply. Both modes produce the
      // same shape — install vs add-scope differs only in which API
      // method we dispatch for each scope.
      const scopesToApply: Array<{ scope_type: "user" | "project"; scope_id: string | null }> =
        scopeChoice === "user"
          ? [{ scope_type: "user", scope_id: null }]
          : selectedPaths.map(p => ({ scope_type: "project", scope_id: p }));

      if (isAddScopeMode && existingInstall) {
        // Add-scope mode: every selected scope is a setScope call.
        // Failures are reported inline so the user sees which paths
        // didn't take, but earlier successes stay applied.
        const failed: string[] = [];
        for (const s of scopesToApply) {
          try {
            await setScope(existingInstall.id, s.scope_type, s.scope_id, true);
          } catch (err) {
            failed.push(s.scope_id ?? "user");
            // eslint-disable-next-line no-console
            console.warn("add_scope.failed", s, err);
          }
        }
        if (failed.length > 0) {
          setWarning(
            `Couldn't enable for ${failed.length} scope${failed.length === 1 ? "" : "s"}: ${failed.join(", ")}.`,
          );
          setTimeout(onSuccess, 1800);
          return;
        }
        onSuccess();
        return;
      }

      // Fresh-install mode: hit /install for the first scope (does
      // the download + materialise), then layer remaining scopes via
      // /scope. A failure on a follow-up enablement is non-fatal —
      // the plugin is already on disk — so we surface it as a
      // warning instead of rolling back.
      const first = scopesToApply[0]!;
      const rest = scopesToApply.slice(1);
      const result = await install({
        source_id, plugin_path,
        scope: first,
        secrets,
      });
      const failed: string[] = [];
      for (const s of rest) {
        try {
          await setScope(result.install_id, s.scope_type, s.scope_id, true);
        } catch (err) {
          failed.push(s.scope_id ?? "user");
          // eslint-disable-next-line no-console
          console.warn("install.extra_scope_failed", s, err);
        }
      }
      if (failed.length > 0) {
        setWarning(
          `Installed, but couldn't enable for ${failed.length} project${failed.length === 1 ? "" : "s"}: ${failed.join(", ")}. Open the Installed tab to retry.`,
        );
        setTimeout(onSuccess, 1800);
        return;
      }
      onSuccess();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const declaresList = Object.entries(aggregateCounts(manifest.declares))
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const label = COMPONENT_LABELS[k as keyof typeof COMPONENT_LABELS];
      return `${n} ${label}${n === 1 ? "" : "s"}`;
    });

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        animation: "mp-modal-fade 0.16s ease-out both",
      }}
    >
      <style>{`
        @keyframes mp-modal-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes mp-modal-pop {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      <form
        onSubmit={onSubmit}
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--sidebar)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 12,
          padding: 22, width: "100%", maxWidth: 480,
          display: "flex", flexDirection: "column", gap: 18,
          maxHeight: "85vh", overflowY: "auto",
          boxShadow: "0 20px 50px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)",
          animation: "mp-modal-pop 0.22s cubic-bezier(0.22, 1, 0.36, 1) both",
          color: "var(--c-high)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--c-high)", letterSpacing: "-0.01em" }}>
                {isAddScopeMode ? "Add scope to " : "Install "}{pluginLabel(manifest)}
              </h2>
              <span style={{
                fontSize: 11, color: "var(--c-ghost)",
                fontFamily: "var(--font-mono)",
              }}>v{manifest.version}</span>
            </div>
            <div style={{
              fontSize: 11, color: "var(--c-dim)",
              display: "flex", gap: 8, alignItems: "center",
            }}>
              <span>by {manifest.author?.name || "Unknown"}</span>
              <span style={{ color: "var(--c-ghost)" }}>·</span>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 3,
                color: source_is_official ? "#4ade80" : "var(--c-dim)",
              }}>
                {source_is_official && <ShieldCheck size={11} />}
                {source_name}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0,
              width: 24, height: 24, borderRadius: 5,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--c-dim)",
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }}
          >
            <X size={14} />
          </button>
        </div>

        {/* What this will add — hidden in add-scope mode since the
            user already saw it at first install. */}
        {!isAddScopeMode && declaresList.length > 0 && (
          <div>
            <SectionLabel>This will add to your Fleet</SectionLabel>
            <ul style={{
              margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--c-high)",
              lineHeight: 1.7,
            }}>
              {declaresList.map(line => <li key={line}>{line}</li>)}
            </ul>
          </div>
        )}

        {/* Required secrets — only on fresh install. Add-scope reuses
            the secrets that were stored at first install. */}
        {!isAddScopeMode && manifest.requires_secrets.length > 0 && (
          <div>
            <SectionLabel>Required secrets</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {manifest.requires_secrets.map(req => (
                <div key={req.key}>
                  <label style={{
                    fontSize: 12, color: "var(--c-med)",
                    display: "flex", alignItems: "center", gap: 6,
                    marginBottom: 5,
                  }}>
                    <span>{req.label}</span>
                    {(() => {
                      const safe = safeExternalUrl(req.url);
                      return safe ? (
                        <a
                          href={safe} target="_blank" rel="noreferrer"
                          style={{
                            fontSize: 11, color: "var(--c-dim)",
                            display: "inline-flex", alignItems: "center", gap: 3,
                            textDecoration: "none",
                          }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--c-high)"}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--c-dim)"}
                        >
                          Get <ExternalLink size={9} />
                        </a>
                      ) : null;
                    })()}
                  </label>
                  <input
                    type="password"
                    value={secrets[req.key] || ""}
                    onChange={e => setSecrets({ ...secrets, [req.key]: e.target.value })}
                    placeholder={req.key}
                    style={{
                      width: "100%", padding: "7px 11px",
                      background: "var(--c-srf)",
                      border: "1px solid var(--sidebar-border)",
                      borderRadius: 6,
                      color: "var(--c-high)",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      outline: "none",
                      boxSizing: "border-box",
                      transition: "border-color 0.10s",
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = "var(--c-brd)")}
                    onBlur={e => (e.currentTarget.style.borderColor = "var(--sidebar-border)")}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scope */}
        <div>
          <SectionLabel>{isAddScopeMode ? "Enable for" : "Activate for"}</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {userScopeAvailable && (
              <Radio
                checked={scopeChoice === "user"}
                onChange={() => setScopeChoice("user")}
                label="All my projects"
                hint="Every Fleet session, including projects you haven't opened yet"
              />
            )}
            <Radio
              checked={scopeChoice === "specific"}
              onChange={() => setScopeChoice("specific")}
              label="Specific projects"
              hint={
                projectPaths.length === 0
                  ? (isAddScopeMode
                      ? "No remaining session folders — all are already enabled"
                      : "No active session folders to bind")
                  : `Pick from ${projectPaths.length} ${isAddScopeMode ? "available" : "active"} session folder${projectPaths.length === 1 ? "" : "s"}`
              }
              disabled={projectPaths.length === 0}
            />
          </div>
          {scopeChoice === "specific" && projectPaths.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <ProjectMultiSelect
                paths={projectPaths}
                selected={selectedPaths}
                onToggle={togglePath}
                onClear={() => setSelectedPaths([])}
              />
            </div>
          )}
        </div>

        {error && (
          <div style={{
            padding: "8px 12px",
            background: "rgba(248,113,113,0.10)",
            border: "1px solid rgba(248,113,113,0.35)",
            borderRadius: 7, fontSize: 12, color: "#f87171",
          }}>{error}</div>
        )}
        {warning && (
          <div style={{
            padding: "8px 12px",
            background: "rgba(250,204,21,0.10)",
            border: "1px solid rgba(250,204,21,0.35)",
            borderRadius: 7, fontSize: 12, color: "#facc15",
          }}>{warning}</div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "7px 14px",
              background: "transparent",
              border: "1px solid var(--sidebar-border)",
              borderRadius: 7,
              color: "var(--c-med)",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: 12, fontWeight: 500,
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => { if (busy) return; e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-med)"; }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              padding: "7px 18px",
              background: "var(--c-high)",
              border: "none",
              borderRadius: 7,
              color: "var(--card)",
              cursor: busy ? "wait" : (canSubmit ? "pointer" : "not-allowed"),
              fontSize: 12, fontWeight: 600,
              opacity: canSubmit ? 1 : 0.55,
              transition: "opacity 0.12s",
            }}
            onMouseEnter={e => { if (canSubmit && !busy) e.currentTarget.style.opacity = "0.88"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = canSubmit ? "1" : "0.55"; }}
          >
            {busy
              ? (isAddScopeMode ? "Adding…" : "Installing…")
              : (isAddScopeMode ? "Add scope" : "Install")}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── ProjectMultiSelect ─────────────────────────────────────────────────
 *  Trigger button that toggles an INLINE expanding picker (search +
 *  checkbox list). Previously this was an absolute-positioned popover
 *  with zIndex 10, which slid up over the Install button beneath it
 *  and made the primary CTA unclickable while a project was being
 *  chosen. Inline lets the form's own scroll handle height growth and
 *  keeps the footer reachable in normal flow. */
function ProjectMultiSelect({
  paths, selected, onToggle, onClear,
}: {
  paths: string[];
  selected: string[];
  onToggle: (path: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Substring match against full path (case-insensitive). Selected
  // paths are NOT pinned to the top — the count + "Clear" affordance
  // above the list already tells the user what's locked in, and
  // pinning would shuffle rows around as they tick boxes.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return paths;
    return paths.filter(p => p.toLowerCase().includes(q));
  }, [paths, query]);

  const triggerLabel = selected.length === 0
    ? "Select projects…"
    : selected.length === 1
      ? `1 project selected`
      : `${selected.length} projects selected`;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(o => {
            const next = !o;
            // Autofocus the search box right when the picker reveals
            // so the user can start typing without an extra click.
            if (next) {
              requestAnimationFrame(() => searchRef.current?.focus());
            }
            return next;
          });
        }}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%",
          padding: "9px 11px",
          background: "var(--c-srf)",
          border: "1px solid",
          borderColor: open ? "var(--c-brd)" : "var(--sidebar-border)",
          borderRadius: open ? "7px 7px 0 0" : 7,
          cursor: "pointer",
          color: "var(--c-high)",
          fontSize: 12.5,
          fontWeight: 500,
          transition: "border-color 0.10s, background 0.08s, border-radius 0.10s",
        }}
      >
        <span style={{
          color: selected.length === 0 ? "var(--c-dim)" : "var(--c-high)",
        }}>{triggerLabel}</span>
        <ChevronDown
          size={13}
          style={{
            color: "var(--c-dim)",
            transform: open ? "rotate(180deg)" : "rotate(0)",
            transition: "transform 0.15s",
          }}
        />
      </button>

      {open && (
        <div
          style={{
            background: "var(--card, var(--sidebar))",
            border: "1px solid var(--c-brd)",
            borderTop: "none",
            borderRadius: "0 0 8px 8px",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Search bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "7px 10px",
            background: "var(--c-srf)",
            borderBottom: "1px solid var(--sidebar-border)",
          }}>
            <Search size={11} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search projects…"
              style={{
                flex: 1, background: "transparent", border: "none", outline: "none",
                color: "var(--c-high)", fontSize: 11.5,
                fontFamily: "var(--font-mono)",
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                aria-label="Clear search"
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 16, height: 16, padding: 0,
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--c-dim)",
                }}
              >
                <X size={10} />
              </button>
            )}
          </div>

          {/* Header: count + clear-all */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "6px 12px",
            borderBottom: "1px solid var(--sidebar-border)",
          }}>
            <span style={{
              fontSize: 10, fontWeight: 600,
              color: "var(--c-ghost)",
              textTransform: "uppercase",
              letterSpacing: "0.10em",
            }}>
              {selected.length} / {paths.length} selected
              {query && filtered.length !== paths.length && (
                <span style={{
                  marginLeft: 6,
                  color: "var(--c-dim)",
                  fontWeight: 500, textTransform: "none", letterSpacing: 0,
                }}>· {filtered.length} match{filtered.length === 1 ? "" : "es"}</span>
              )}
            </span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--c-dim)",
                  fontSize: 10.5,
                  padding: "2px 4px",
                  borderRadius: 4,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--c-high)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--c-dim)")}
              >
                Clear
              </button>
            )}
          </div>

          {/* List */}
          <div style={{
            maxHeight: 200,
            overflowY: "auto",
            padding: 4,
          }}>
            {filtered.length === 0 ? (
              <div style={{
                padding: "16px 12px",
                textAlign: "center",
                fontSize: 11.5, color: "var(--c-dim)",
              }}>
                No projects match "{query}"
              </div>
            ) : filtered.map(path => {
              const isSelected = selected.includes(path);
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => onToggle(path)}
                  title={path}
                  style={{
                    display: "flex", alignItems: "center", gap: 9,
                    width: "100%",
                    padding: "7px 9px",
                    background: isSelected ? "var(--c-srf)" : "transparent",
                    border: "none",
                    borderRadius: 5,
                    cursor: "pointer",
                    color: "var(--c-high)",
                    fontSize: 12,
                    textAlign: "left",
                    transition: "background 0.06s",
                  }}
                  onMouseEnter={e => {
                    if (!isSelected) e.currentTarget.style.background = "var(--c-srf)";
                  }}
                  onMouseLeave={e => {
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{
                    width: 14, height: 14, flexShrink: 0,
                    borderRadius: 3,
                    border: "1px solid",
                    borderColor: isSelected ? "var(--c-high)" : "var(--c-brd)",
                    background: isSelected ? "var(--c-high)" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "var(--card)",
                    transition: "background 0.10s, border-color 0.10s",
                  }}>
                    {isSelected && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span style={{
                    minWidth: 0, flex: 1,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    direction: "rtl", textAlign: "left",
                  }}>{path}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600,
      color: "var(--c-ghost)",
      textTransform: "uppercase",
      letterSpacing: "0.10em",
      marginBottom: 8,
    }}>{children}</div>
  );
}

function Radio({ checked, onChange, label, hint, disabled }: {
  checked: boolean; onChange: () => void; label: string; hint?: string; disabled?: boolean;
}) {
  return (
    <label style={{
      display: "flex", alignItems: "flex-start", gap: 10,
      padding: "9px 11px",
      background: checked ? "var(--c-srf)" : "transparent",
      border: "1px solid",
      borderColor: checked ? "var(--c-brd)" : "var(--sidebar-border)",
      borderRadius: 7,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: "background 0.08s, border-color 0.08s",
    }}>
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{
          marginTop: 2,
          accentColor: "var(--c-high)",
          flexShrink: 0,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: "var(--c-high)", fontWeight: 500, lineHeight: 1.3 }}>
          {label}
        </div>
        {hint && (
          <div style={{
            fontSize: 11, color: "var(--c-dim)", marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{hint}</div>
        )}
      </div>
    </label>
  );
}
