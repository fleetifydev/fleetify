import { useEffect, useRef, useState } from "react";
import { RefreshCw, FileJson2, Plus } from "lucide-react";
import { useMCPStore } from "@/stores/mcp-store";
import { openConfig, getConfigPath, startAuth, signOut, type MCPServerRow } from "@/lib/mcp-api";
import { MCPCard } from "./mcp-card";
import { MCPEditDialog } from "./mcp-edit-dialog";

/** Open a URL in the OS default browser. In the Tauri webview `window.open`
 *  is swallowed, so route through the preload `openExternal` bridge (same as
 *  auth-required-card.tsx); fall back to window.open in a plain web dev view. */
function openExternal(url: string): void {
  const w = window as unknown as { electronAPI?: { openExternal?: (u: string) => unknown } };
  if (w.electronAPI?.openExternal) void w.electronAPI.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function MCPSection() {
  const {
    servers, loading, refreshing, error,
    fetchAll, refresh, add, update, remove, probe,
  } = useMCPStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MCPServerRow | null>(null);
  const [configPath, setConfigPath] = useState<string>("");
  const [authInFlight, setAuthInFlight] = useState<Set<string>>(new Set());
  const pollHandles = useRef<Record<string, number>>({});

  useEffect(() => {
    fetchAll();
    getConfigPath().then(setConfigPath).catch(() => {});
  }, [fetchAll]);

  useEffect(() => {
    return () => {
      for (const h of Object.values(pollHandles.current)) {
        window.clearInterval(h);
      }
    };
  }, []);

  function handleAdd() {
    setEditing(null);
    setDialogOpen(true);
  }

  function handleEdit(row: MCPServerRow) {
    setEditing(row);
    setDialogOpen(true);
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete MCP server "${name}"?`)) return;
    try { await remove(name); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }

  async function handleAuth(name: string) {
    let url: string;
    try {
      url = await startAuth(name);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      return;
    }
    // Open the authorization URL in the OS browser (window.open is swallowed
    // in the Tauri webview). The backend callback stores the tokens; we poll
    // /servers until the status flips off of auth_needed.
    openExternal(url);
    setAuthInFlight(prev => new Set(prev).add(name));

    // Poll for up to 3 minutes with a 2s cadence. The mask also lifts
    // once we see a decisive result (connected, failed, or a rejected
    // token — indicated by auth_needed with an error payload).
    let ticks = 0;
    const maxTicks = 90;
    const handle = window.setInterval(async () => {
      ticks++;
      await probe(name).catch(() => {});
      const current = useMCPStore.getState().servers.find(s => s.name === name);
      const status = current?.status.status;
      const rejected = status === "auth_needed" && !!current?.status.error;
      if (status === "connected" || status === "failed" || rejected || ticks >= maxTicks) {
        window.clearInterval(handle);
        delete pollHandles.current[name];
        setAuthInFlight(prev => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    }, 2000);
    pollHandles.current[name] = handle;
  }

  async function handleSignOut(name: string) {
    if (!confirm(`Sign out of "${name}"?`)) return;
    try {
      await signOut(name);
      await probe(name);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "flex-start", marginBottom: 14, gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--c-low)", lineHeight: 1.5, maxWidth: 520 }}>
            Model Context Protocol servers are shared across every agent (Claude Code, Codex, Gemini CLI, …).
            Add a server below; Fleet will probe it and inject it into every agent spawn.
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <IconBtn
            testId="mcp-open-raw-json"
            title={configPath ? `Open raw JSON (${configPath})` : "Open raw JSON"}
            onClick={() => openConfig().catch(e => alert(e.message))}
          >
            <FileJson2 size={14} />
          </IconBtn>
          <IconBtn
            testId="mcp-refresh"
            title={refreshing ? "Refreshing…" : "Refresh"}
            disabled={refreshing}
            onClick={() => refresh()}
          >
            <RefreshCw
              size={14}
              style={{ animation: refreshing ? "spin 0.8s linear infinite" : undefined }}
            />
          </IconBtn>
          <IconBtn
            testId="mcp-add"
            title="Add server"
            primary
            onClick={handleAdd}
          >
            <Plus size={14} />
          </IconBtn>
        </div>
      </div>

      {error && (
        <div style={{
          marginBottom: 12, padding: "8px 12px", borderRadius: 7,
          background: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {loading && servers.length === 0 && (
        <div style={{ padding: "32px 0", textAlign: "center", color: "var(--c-dim)", fontSize: 13 }}>
          Loading servers…
        </div>
      )}

      {!loading && servers.length === 0 && (
        <div
          data-testid="mcp-empty"
          style={{
            padding: "40px 20px", textAlign: "center",
            border: "1px dashed var(--c-brd2)", borderRadius: 10,
            color: "var(--c-dim)", fontSize: 13,
          }}
        >
          No MCP servers yet.<br />
          Click <strong>Add Server</strong> to register your first one.
        </div>
      )}

      {servers.map(row => (
        <MCPCard
          key={row.name}
          row={authInFlight.has(row.name)
            ? { ...row, status: { ...row.status, status: "checking" } }
            : row}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onProbe={probe}
          onAuth={handleAuth}
          onSignOut={handleSignOut}
        />
      ))}

      <MCPEditDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSubmit={async (name, config) => {
          if (editing) await update(name, config);
          else await add(name, config);
        }}
      />

      <style>{`@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

function IconBtn({
  children, onClick, title, disabled, primary, testId,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  primary?: boolean;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        width: 28, height: 28, borderRadius: 7, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: primary ? "var(--c-high)" : "none",
        border: primary ? "none" : "1px solid var(--c-brd)",
        color: primary ? "var(--card)" : "var(--c-med)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.1s, border-color 0.1s, color 0.1s",
      }}
      onMouseEnter={e => {
        if (disabled) return;
        if (primary) { e.currentTarget.style.opacity = "0.85"; }
        else { e.currentTarget.style.background = "var(--c-srf2)"; e.currentTarget.style.color = "var(--c-high)"; }
      }}
      onMouseLeave={e => {
        if (primary) { e.currentTarget.style.opacity = disabled ? "0.5" : "1"; }
        else { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-med)"; }
      }}
    >
      {children}
    </button>
  );
}
