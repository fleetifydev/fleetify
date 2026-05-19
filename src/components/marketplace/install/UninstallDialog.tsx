/**
 * UninstallDialog — scope picker shown when the user fires "Uninstall"
 * on an installed plugin. Hub for the three teardown levels:
 *
 *   * "Everywhere" — full uninstall (drops files + DB row + every
 *     scope's external state).
 *   * "Global only" — peel off the user-scope enablement; project
 *     scopes (if any) stay live.
 *   * "From specific projects…" — multi-select picker over the active
 *     project-scope enablements. Each ticked project is peeled off in
 *     turn; the plugin stays installed for whatever scopes remain.
 *
 * Renders only the scope buckets that would actually do something —
 * "Global only" hides when no user-scope enablement exists, and
 * "From specific projects…" hides when no project scopes are active.
 * "Everywhere" is always available so a fully-installed plugin can be
 * removed in one shot.
 *
 * Visual language matches InstallDialog (same scrim, card surface,
 * radio recipe) so the two dialogs feel like halves of one workflow.
 */
import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { usePluginStore } from "@/stores/plugin-store";
import * as pluginApi from "@/lib/plugin-api";
import type { PluginInstall, ScopeType } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";

interface Props {
  install: PluginInstall;
  onClose: () => void;
  onSuccess: () => void;
}

type ChoiceKind = "everywhere" | "user" | "projects";

export function UninstallDialog({ install, onClose, onSuccess }: Props) {
  const uninstall = usePluginStore(s => s.uninstall);
  const uninstallScope = usePluginStore(s => s.uninstallScope);
  const refreshInstalls = usePluginStore(s => s.refreshInstalls);

  // Enumerate the currently-enabled project scopes — those are the
  // candidates for the multi-select. User + everywhere live in the
  // radio list above; here we only deal with project rows.
  const activeProjects = useMemo(
    () =>
      install.enablements
        .filter(e => e.enabled && e.scope_type === "project" && e.scope_id)
        .map(e => e.scope_id as string),
    [install],
  );
  const hasUserScope = useMemo(
    () => install.enablements.some(e => e.enabled && e.scope_type === "user"),
    [install],
  );

  const initialKind: ChoiceKind = "everywhere";
  const [kind, setKind] = useState<ChoiceKind>(initialKind);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleProject = (path: string) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const allProjectsSelected =
    activeProjects.length > 0 &&
    selectedProjects.size === activeProjects.length;
  const toggleAllProjects = () => {
    setSelectedProjects(
      allProjectsSelected ? new Set() : new Set(activeProjects),
    );
  };

  const canSubmit =
    !busy &&
    (kind !== "projects" || selectedProjects.size > 0);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "everywhere") {
        await uninstall(install.id);
      } else if (kind === "user") {
        await uninstallScope(install.id, "user" as ScopeType, null);
      } else {
        // Multi-project peel — fire each scope removal sequentially so
        // a mid-loop backend error surfaces against the right project
        // and partial progress sticks (the ones already removed stay
        // removed). One refresh at the end keeps the store quiet
        // instead of N intermediate refetches.
        for (const path of selectedProjects) {
          await pluginApi.uninstallScope(
            install.id, "project" as ScopeType, path,
          );
        }
        await refreshInstalls();
      }
      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const everywhereWarning = kind === "everywhere"
    ? "Removes the plugin completely — files, hook entries, every scope."
    : null;

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
          padding: 22, width: "100%", maxWidth: 460,
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
            <h2 style={{
              margin: 0, fontSize: 16, fontWeight: 600,
              color: "var(--c-high)", letterSpacing: "-0.01em",
            }}>
              Uninstall {pluginLabel(install.manifest)}
            </h2>
            <div style={{
              fontSize: 11, color: "var(--c-dim)", marginTop: 4,
            }}>
              Choose what to remove. Other scopes stay active unless
              you pick "Everywhere".
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

        {/* Choices */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ChoiceRadio
            label="Everywhere"
            hint="Full uninstall — every scope, every file"
            checked={kind === "everywhere"}
            onSelect={() => setKind("everywhere")}
          />
          {hasUserScope && (
            <ChoiceRadio
              label="From global (all my projects)"
              hint="Removes the user-scope enablement; project scopes stay"
              checked={kind === "user"}
              onSelect={() => setKind("user")}
            />
          )}
          {activeProjects.length > 0 && (
            <ChoiceRadio
              label="From specific projects…"
              hint={
                activeProjects.length === 1
                  ? "1 project active"
                  : `${activeProjects.length} projects active — pick which ones to remove`
              }
              checked={kind === "projects"}
              onSelect={() => setKind("projects")}
            >
              {kind === "projects" && (
                <ProjectPicker
                  projects={activeProjects}
                  selected={selectedProjects}
                  onToggle={toggleProject}
                  allSelected={allProjectsSelected}
                  onToggleAll={toggleAllProjects}
                />
              )}
            </ChoiceRadio>
          )}
        </div>

        {everywhereWarning && (
          <div style={{
            padding: "8px 12px",
            background: "rgba(248,113,113,0.10)",
            border: "1px solid rgba(248,113,113,0.35)",
            borderRadius: 7, fontSize: 11.5, color: "#f87171",
          }}>{everywhereWarning}</div>
        )}

        {error && (
          <div style={{
            padding: "8px 12px",
            background: "rgba(248,113,113,0.10)",
            border: "1px solid rgba(248,113,113,0.35)",
            borderRadius: 7, fontSize: 12, color: "#f87171",
          }}>{error}</div>
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
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              padding: "7px 18px",
              background: "#dc2626",
              border: "none",
              borderRadius: 7,
              color: "#fff",
              cursor: !canSubmit ? (busy ? "wait" : "not-allowed") : "pointer",
              fontSize: 12, fontWeight: 600,
              opacity: !canSubmit ? 0.55 : 1,
              transition: "opacity 0.12s",
            }}
            onMouseEnter={e => { if (canSubmit) e.currentTarget.style.opacity = "0.88"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = !canSubmit ? "0.55" : "1"; }}
          >
            {busy
              ? "Removing…"
              : kind === "projects" && selectedProjects.size > 1
                ? `Remove from ${selectedProjects.size} projects`
                : "Remove"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ChoiceRadio({
  label, hint, checked, onSelect, children,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div style={{
      background: checked ? "var(--c-srf)" : "transparent",
      border: "1px solid",
      borderColor: checked ? "var(--c-brd)" : "var(--sidebar-border)",
      borderRadius: 7,
      transition: "background 0.08s, border-color 0.08s",
      overflow: "hidden",
    }}>
      <label style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "9px 11px",
        cursor: "pointer",
      }}>
        <input
          type="radio"
          checked={checked}
          onChange={onSelect}
          style={{
            marginTop: 2,
            accentColor: "var(--c-high)",
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 12.5, color: "var(--c-high)", fontWeight: 500,
            lineHeight: 1.3,
          }}>
            {label}
          </div>
          <div style={{
            fontSize: 11, color: "var(--c-dim)", marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{hint}</div>
        </div>
      </label>
      {children}
    </div>
  );
}

/* ── ProjectPicker ───────────────────────────────────────────────────
 *  Checkbox list of currently-active project scopes, revealed inline
 *  under the "From specific projects…" radio when it's selected.
 *  Each row shows the project basename + full path (mono, ellipsised).
 *  Header row offers a Select all / none toggle for the common case
 *  where the user wants to peel the plugin off every project at once.
 */
function ProjectPicker({
  projects, selected, onToggle, allSelected, onToggleAll,
}: {
  projects: string[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  allSelected: boolean;
  onToggleAll: () => void;
}) {
  return (
    <div style={{
      borderTop: "1px solid var(--sidebar-border)",
      background: "var(--c-srf2)",
      maxHeight: 240,
      overflowY: "auto",
    }}>
      {projects.length > 1 && (
        <button
          type="button"
          onClick={onToggleAll}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            width: "100%",
            padding: "7px 12px",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--sidebar-border)",
            cursor: "pointer",
            color: "var(--c-dim)",
            fontSize: 11, fontWeight: 500,
            textAlign: "left",
          }}
        >
          <span>{allSelected ? "Deselect all" : "Select all"}</span>
          <span style={{ color: "var(--c-ghost)", fontFamily: "var(--font-mono)" }}>
            {selected.size} / {projects.length}
          </span>
        </button>
      )}
      {projects.map(path => {
        const isChecked = selected.has(path);
        return (
          <label
            key={path}
            style={{
              display: "flex", alignItems: "center", gap: 9,
              padding: "7px 12px",
              cursor: "pointer",
              borderBottom: "1px solid var(--sidebar-border)",
              transition: "background 0.08s",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 14, height: 14, flexShrink: 0,
              borderRadius: 3,
              border: "1px solid",
              borderColor: isChecked ? "var(--c-high)" : "var(--c-brd)",
              background: isChecked ? "var(--c-high)" : "transparent",
              transition: "background 0.08s, border-color 0.08s",
            }}>
              {isChecked && <Check size={10} color="var(--card)" strokeWidth={3} />}
            </span>
            <input
              type="checkbox"
              checked={isChecked}
              onChange={() => onToggle(path)}
              style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 12, color: "var(--c-high)", fontWeight: 500,
                lineHeight: 1.3,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{basename(path)}</div>
              <div title={path} style={{
                fontSize: 10.5, color: "var(--c-dim)",
                marginTop: 1,
                fontFamily: "var(--font-mono)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{path}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function basename(p: string): string {
  // Cross-platform basename — handle both separators for POSIX and
  // Windows paths. Falls back to the full path when neither yields a
  // non-empty trailing segment.
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}
