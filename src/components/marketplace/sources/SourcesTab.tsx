/**
 * SourcesTab — Settings-card layout. Header explains the surface +
 * primary "Add Marketplace" button on the right. The card below
 * lists each source as a Settings-style row with enable toggle,
 * refresh icon button, and (for non-official sources) a delete.
 */
import { useState } from "react";
import { ExternalLink, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { usePluginStore } from "@/stores/plugin-store";
import { safeExternalUrl } from "@/lib/utils";
import { followLink } from "@/components/markdown-link";
import { AddSourceDialog } from "./AddSourceDialog";

export function SourcesTab() {
  const sources = usePluginStore(s => s.sources);
  const setSourceEnabled = usePluginStore(s => s.setSourceEnabled);
  const deleteSource = usePluginStore(s => s.deleteSource);
  const refreshSource = usePluginStore(s => s.refreshSource);
  const [addOpen, setAddOpen] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const onRefresh = async (id: string) => {
    setRefreshing(id);
    try { await refreshSource(id); } finally { setRefreshing(null); }
  };

  const onDelete = async (id: string, name: string) => {
    if (!confirm(`Delete marketplace "${name}"? Plugins from this source will remain installed but updates will stop.`)) return;
    await deleteSource(id);
  };

  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "flex-end",
        marginBottom: 14,
      }}>
        <button
          onClick={() => setAddOpen(true)}
          style={primaryBtn}
        >
          <Plus size={12} /> Add source
        </button>
      </div>

      <div style={{
        borderRadius: 10,
        border: "1px solid var(--sidebar-border)",
        background: "var(--sidebar)",
        overflow: "hidden",
      }}>
        {sources.length === 0 && (
          <div style={{
            padding: "24px 16px", textAlign: "center",
            fontSize: 12.5, color: "var(--c-low)",
            lineHeight: 1.5,
          }}>
            No sources configured.
            <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--c-ghost)" }}>
              Click <strong>Add source</strong> to point Fleet at a GitHub repo containing a <code style={mono}>marketplace.json</code>.
            </div>
          </div>
        )}
        {sources.map((s, i, arr) => (
          <SourceRow
            key={s.id}
            source={s}
            last={i === arr.length - 1}
            refreshing={refreshing === s.id}
            onToggleEnabled={(v) => setSourceEnabled(s.id, v)}
            onRefresh={() => onRefresh(s.id)}
            onDelete={() => onDelete(s.id, s.name)}
          />
        ))}
      </div>

      {addOpen && <AddSourceDialog onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function SourceRow({
  source, last, refreshing,
  onToggleEnabled, onRefresh, onDelete,
}: {
  source: { id: string; name: string; description?: string | null; repo_url: string; is_official: boolean; enabled: boolean };
  last: boolean;
  refreshing: boolean;
  onToggleEnabled: (v: boolean) => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const safeUrl = safeExternalUrl(source.repo_url);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "14px 16px",
      borderBottom: last ? "none" : "1px solid var(--sidebar-border)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            fontSize: 13, fontWeight: 500, color: "var(--c-high)",
            lineHeight: 1.35,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {source.name}
          </span>
          {source.is_official && (
            <span
              title="Fleet Official — verified source"
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                color: "#4ade80", flexShrink: 0,
              }}
            >
              <ShieldCheck size={13} strokeWidth={2.2} />
            </span>
          )}
        </div>
        {source.description && (
          <div style={{
            fontSize: 12, color: "var(--c-low)",
            lineHeight: 1.5, marginTop: 3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{source.description}</div>
        )}
        {safeUrl ? (
          <a
            href={safeUrl} rel="noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 11, color: "var(--c-ghost)",
              marginTop: 4, textDecoration: "none",
              fontFamily: "var(--font-mono)",
            }}
            onClick={e => {
              e.stopPropagation();
              followLink(e, safeUrl);
            }}
          >
            {source.repo_url} <ExternalLink size={9} />
          </a>
        ) : (
          <div style={{
            fontSize: 11, color: "var(--c-ghost)", marginTop: 4,
            fontFamily: "var(--font-mono)",
          }}>{source.repo_url}</div>
        )}
      </div>

      <EnabledToggle on={source.enabled} onChange={onToggleEnabled} />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh catalog"
        style={iconBtn}
      >
        <RefreshCw size={12} className={refreshing ? "spin" : ""} />
      </button>
      {!source.is_official && (
        <button
          onClick={onDelete}
          title="Delete source"
          style={{ ...iconBtn, color: "#f87171" }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function EnabledToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      title={on ? "Enabled" : "Disabled"}
      style={{
        width: 30, height: 18, borderRadius: 999,
        padding: 0, position: "relative",
        border: "1px solid var(--c-brd)",
        background: on ? "rgb(74,222,128)" : "var(--c-srf2)",
        cursor: "pointer", flexShrink: 0,
        transition: "background 0.18s, border-color 0.18s",
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

const primaryBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 12px",
  background: "var(--c-high)",
  color: "var(--card)",
  border: "none", borderRadius: 7,
  fontSize: 12.5, fontWeight: 600,
  cursor: "pointer",
  flexShrink: 0,
};

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  padding: "1px 5px",
  background: "var(--c-srf)",
  borderRadius: 3,
  color: "var(--c-med)",
};
