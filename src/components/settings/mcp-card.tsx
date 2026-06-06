import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Trash2, Pencil, RefreshCw, LogIn, LogOut } from "lucide-react";
import type { MCPServerRow } from "@/lib/mcp-api";
import "@/components/settings/settings-ui.css";

interface Props {
  row: MCPServerRow;
  onEdit: (row: MCPServerRow) => void;
  onDelete: (name: string) => void;
  onProbe: (name: string) => void;
  onAuth: (name: string) => void;
  onSignOut: (name: string) => void;
}

function StatusPill({ row }: { row: MCPServerRow }) {
  const s = row.status.status;
  if (s === "checking") {
    return (
      <span className="s-pill">
        <span
          className="s-pill-dot"
          style={{ animation: "thinking-wave 1.4s ease-in-out infinite" }}
        />
        Checking…
      </span>
    );
  }
  if (s === "connected") {
    return (
      <span className="s-pill ok">
        <span className="s-pill-dot" />
        Connected{row.status.tool_count ? ` · ${row.status.tool_count} tools` : ""}
      </span>
    );
  }
  if (s === "auth_needed") {
    return (
      <span className="s-pill warn">
        <span className="s-pill-dot" />
        Auth needed
      </span>
    );
  }
  if (s === "failed") {
    return (
      <span title={row.status.error ?? ""} className="s-pill err">
        <span className="s-pill-dot" />
        Failed
      </span>
    );
  }
  return (
    <span className="s-pill">
      <span className="s-pill-dot" />
      Unknown
    </span>
  );
}

function summary(row: MCPServerRow): string {
  const c = row.config;
  if (c.type === "stdio") {
    return `${c.type} · ${c.command}${c.args && c.args.length ? " " + c.args.join(" ") : ""}`;
  }
  return `${c.type} · ${c.url}`;
}

export function MCPCard({ row, onEdit, onDelete, onProbe, onAuth, onSignOut }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isHttp = row.config.type === "http" || row.config.type === "sse";
  const needsAuth = row.status.status === "auth_needed" && isHttp;
  const isConnected = row.status.status === "connected";

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const btn = menuBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setMenuPos({
        top: r.bottom + 4,
        right: window.innerWidth - r.right,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (menuBtnRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      data-testid={`mcp-card-${row.name}`}
      style={{
        border: "1px solid var(--c-brd)", borderRadius: 10,
        padding: "14px 16px", marginBottom: 10,
        display: "flex", alignItems: "center", gap: 14,
        background: "var(--card)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--c-high)" }}>
            {row.name}
          </span>
          <StatusPill row={row} />
        </div>
        <div style={{
          fontSize: 12, color: "var(--c-low)",
          marginTop: 4, fontFamily: "var(--font-mono)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {summary(row)}
        </div>
      </div>

      {needsAuth && (
        <button
          data-testid={`mcp-authenticate-${row.name}`}
          onClick={() => onAuth(row.name)}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "5px 11px", borderRadius: 7,
            background: "#eab308", border: "none",
            color: "#0a0a0a", cursor: "pointer",
            fontSize: 12, fontWeight: 600,
            transition: "opacity 0.12s",
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = "0.9")}
          onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
        >
          <LogIn size={12} />
          Authenticate
        </button>
      )}

      <div>
        <button
          ref={menuBtnRef}
          data-testid={`mcp-menu-${row.name}`}
          onClick={() => setMenuOpen(v => !v)}
          style={{
            width: 28, height: 28, borderRadius: 6,
            background: menuOpen ? "var(--c-srf2)" : "none",
            border: "none", cursor: "pointer", color: "var(--c-dim)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && menuPos && createPortal(
          <div
            ref={menuRef}
            data-testid={`mcp-menu-popover-${row.name}`}
            style={{
              position: "fixed",
              top: menuPos.top,
              right: menuPos.right,
              minWidth: 180, zIndex: 2000,
              background: "var(--card)",
              border: "1px solid var(--c-brd)", borderRadius: 8,
              padding: 4,
              boxShadow: "0 10px 28px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3)",
              animation: "fleetMenuIn 0.12s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          >
            <MenuItem
              icon={<Pencil size={12} />} label="Edit"
              onClick={() => { setMenuOpen(false); onEdit(row); }}
            />
            <MenuItem
              icon={<RefreshCw size={12} />} label="Test connection"
              onClick={() => { setMenuOpen(false); onProbe(row.name); }}
            />
            {needsAuth && (
              <MenuItem
                icon={<LogIn size={12} />} label="Authenticate"
                onClick={() => { setMenuOpen(false); onAuth(row.name); }}
              />
            )}
            {isHttp && isConnected && (
              <MenuItem
                icon={<LogOut size={12} />} label="Sign out"
                onClick={() => { setMenuOpen(false); onSignOut(row.name); }}
              />
            )}
            <MenuItem
              icon={<Trash2 size={12} />} label="Delete" danger
              onClick={() => { setMenuOpen(false); onDelete(row.name); }}
            />
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        width: "100%", padding: "6px 8px", borderRadius: 5,
        background: "transparent", border: "none", cursor: "pointer",
        color: danger ? "#ef4444" : "var(--c-high)",
        textAlign: "left", fontSize: 12,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--c-srf2)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{
        width: 14, display: "flex",
        color: danger ? "#ef4444" : "var(--c-dim)",
      }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}
