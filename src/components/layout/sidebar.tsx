import { useCallback, useState, useRef, useEffect, useMemo, memo } from "react";
import { ReactLenis } from "lenis/react";
import {
  Plus, Search, Settings, HelpCircle, Library, MessageCircle,
  LayoutGrid, Store, Repeat,
  Pin, PinOff, Type, GitFork, Archive,
  SlidersHorizontal, X, Check,
  User, Sun, Square, RotateCcw, RefreshCw, PanelLeft, PanelLeftClose,
  Download,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { useThemeStore } from "@/stores/theme-store";
import { useChatStore } from "@/stores/chat-store";
import { useShallow } from "zustand/react/shallow";
import { forkSession, fetchBulkStats, stopSession, restartSession, resetSession, archiveSession } from "@/lib/api";
import { exportChat } from "@/lib/export-chat";
import { usesInAppTitleBar, folderName } from "@/lib/utils";
import { isStudioTool } from "@/lib/studio-tools";
import type { Session } from "@/types/session";
import { FeedbackModal } from "@/components/feedback-modal";

type SessionStats = { message_count: number; total_cost_usd: number };

/* ── Account Footer ──
   Matches the Claude Code reference: a single full-width row with user
   icon + name on the left and a small theme toggle on the right.
   Visually identical to a SideRow so it sits flush with Settings / Get Help. */
function AccountFooter() {
  const raw = localStorage.getItem("fleet:user");
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
        transition: "none",
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

/* ── helpers ── */

/** Open the public docs site in the user's default browser.
 *  Prefers Electron's `shell.openExternal` (via the preload bridge) so
 *  the URL lands in Chrome/Safari/Firefox instead of a new Electron
 *  BrowserWindow; falls back to `window.open` for the dev web view
 *  where the bridge isn't mounted. Used by every "Get Help" / "Help"
 *  row across the sidebar surfaces (main, collapsed rail, Settings,
 *  Library) so the affordance behaves the same everywhere. */
export function openDocs(): void {
  const url = "https://fleetify.dev/docs";
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url).catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60_000);
  const h = Math.floor(d / 3_600_000);
  const day = Math.floor(d / 86_400_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (h < 24) return `${h}h`;
  return `${day}d`;
}


/* ── tiny icon button ──
   Compact 24×24 cell — large enough to give the icon a clear hit area
   without dominating the header. Smaller than the chat-view's 30×30
   IBtn on purpose: the sidebar header carries quiet workspace controls
   (search / sort), the chat header carries primary actions. */
export function Ib({ children, onClick, title }: { children: React.ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 24, height: 24, borderRadius: 5, flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "none", border: "none", color: "var(--c-dim)", cursor: "pointer",
    }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-med)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }}
    >{children}</button>
  );
}

/* ── context menu ── */
function CtxMenu({ x, y, menuRef, session, onClose, onPin, onFork, onStop, onRestart, onReset }: {
  x: number; y: number; menuRef: React.RefObject<HTMLDivElement | null>;
  session: Session; onClose: () => void; onPin: () => void; onFork: () => void;
  onStop: () => void; onRestart: () => void; onReset: () => void;
}) {
  // Per-field selectors — full-state useAppStore() subscribed the menu
  // to every store mutation, even though it only needs two action
  // refs that never change identity.
  const updateSession = useAppStore(s => s.updateSession);
  const removeSession = useAppStore(s => s.removeSession);

  const doRename = () => {
    const n = prompt("Rename:", session.title);
    if (n) {
      fetch(`/api/sessions/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: n }) })
        .then(() => updateSession(session.id, { title: n }));
    }
  };

  const isActive = ["running", "waiting", "starting"].includes(session.status);

  const Row = ({ icon: Icon, label, danger = false, iconColor, onClick }: {
    icon: React.ElementType; label: string; danger?: boolean;
    iconColor?: string; onClick: () => void;
  }) => (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        padding: "5px 8px", background: "none", border: "none",
        borderRadius: 6, cursor: "pointer", fontSize: 12, textAlign: "left",
        color: danger ? "#f87171" : "var(--c-med)",
        transition: "none",
        fontFamily: "inherit",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = danger ? "rgba(248,113,113,0.09)" : "var(--c-srf)";
        if (!danger) e.currentTarget.style.color = "var(--c-high)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "none";
        e.currentTarget.style.color = danger ? "#f87171" : "var(--c-med)";
      }}
    >
      <Icon size={11} style={{ color: iconColor ?? (danger ? "#f87171" : "var(--c-ghost)"), flexShrink: 0 }} />
      <span>{label}</span>
    </button>
  );

  const Sep = () => <div style={{ height: 1, background: "var(--c-brd)", margin: "3px 0" }} />;

  /* Smart positioning — flip up if too close to bottom edge */
  const winH = typeof window !== "undefined" ? window.innerHeight : 800;
  const menuH = isActive ? 230 : 200;
  const top = y + menuH > winH - 16 ? y - menuH : y;

  return (
    <div ref={menuRef} style={{
      position: "fixed", left: x, top,
      zIndex: 9999, minWidth: 180,
      borderRadius: 10, padding: "4px",
      background: "var(--popover)",
      border: "1px solid var(--c-brd2)",
      boxShadow: "0 8px 24px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.06)",
    }}>
      {/* Session title header */}
      <div style={{
        padding: "5px 8px 6px", borderBottom: "1px solid var(--c-brd)", marginBottom: 3,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 500, color: "var(--c-ghost)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {session.title}
        </div>
      </div>

      <Row icon={session.pinned ? PinOff : Pin} label={session.pinned ? "Unpin" : "Pin to top"} onClick={() => { onClose(); onPin(); }} />
      <Row icon={Type}    label="Rename"       onClick={() => { onClose(); doRename(); }} />
      <Row icon={GitFork} label="Fork session" onClick={() => { onClose(); onFork(); }} />

      <Sep />

      {/* Export — was the chat-header "..." popover; relocated
          here per the user's spec. Reads messages live from the
          chat-store at click time so we don't have to keep them
          in sync as a prop. */}
      <Row icon={Download} label="Export as Markdown" onClick={() => {
        onClose();
        const msgs = useChatStore.getState().sessions[session.id]?.messages ?? [];
        exportChat({ title: session.title, sessionId: session.id, messages: msgs, format: "md" });
      }} />
      <Row icon={Download} label="Export as JSON" onClick={() => {
        onClose();
        const msgs = useChatStore.getState().sessions[session.id]?.messages ?? [];
        exportChat({ title: session.title, sessionId: session.id, messages: msgs, format: "json" });
      }} />

      <Sep />

      {isActive && (
        <Row icon={Square} label="Stop agent" iconColor="#fb923c" onClick={() => { onClose(); onStop(); }} />
      )}
      <Row icon={RotateCcw} label="Restart agent" onClick={() => { onClose(); onRestart(); }} />
      <Row icon={RefreshCw} label="Reset session" onClick={() => { onClose(); onReset(); }} />

      <Sep />

      <Row icon={Archive} label="Archive" danger onClick={() => {
        onClose();
        // ── Conductor-style auto-commit before archive ──
        // If the session's worktree has uncommitted changes, snapshot
        // them as a commit before we tear the session down. This is
        // exactly the affordance Conductor calls "Archiving a workspace
        // now saves uncommitted changes as a commit" — work isn't lost
        // when the user dismisses an agent. Best-effort: any failure
        // (no folder, no git, nothing to commit) is silent and we
        // proceed with the archive regardless.
        const folder = session.project_path;
        const archiveAfter = () => {
          removeSession(session.id);
          archiveSession(session.id).catch(() => {});
        };
        if (folder) {
          import("@/lib/git-api").then(async ({ git }) => {
            try {
              await git.commit(folder, `chore: snapshot before archive (${session.title})`);
            } catch { /* ignore — proceed to archive */ }
            archiveAfter();
          }).catch(archiveAfter);
        } else {
          archiveAfter();
        }
      }} />
    </div>
  );
}

/* ── agent status icon ──
 *
 * Single visual primitive across every state: a small ring of fixed
 * outer diameter and stroke thickness. State is communicated by what's
 * happening *inside* that ring:
 *
 *   running   — full ring, transparent → accent conic-gradient sweep,
 *               rotating. Smooth, premium, comet-trail look (CSS
 *               conic-gradient + radial-gradient mask). NO arc-dasharray,
 *               NO centre dot — those earlier attempts read as a "target"
 *               icon instead of a loader because the eye locked onto the
 *               static centre.
 *   starting  — same conic sweep, dimmer colour. Identical motion +
 *               identical shape so a row of mixed-state agents has a
 *               coherent rhythm; only the colour value tells you which
 *               are warming up vs. live.
 *   waiting   — orange pause bars (∥). Different shape on purpose: the
 *               state demands user action and earns a distinct silhouette.
 *   error     — solid red dot inside the ring outline. Static.
 *   idle/stopped — ring outline only, dim. Same outer silhouette as
 *               every other state so the agent list doesn't visually
 *               jiggle when an agent transitions.
 *
 * The unifying shape is a 9px ring at the visual centre of a 14px
 * touch box. Earlier iterations rendered the ring AT 14px, which
 * dominated the row like a pending checkbox; the smaller ring inside
 * a generous box gives the icon presence without competing with the
 * agent name typography. One frame, many fillings, one rhythm.
 *
 * Two layered design tokens make the ring feel premium without being
 * "basic": (1) a conic-gradient sweep with a wider transparent gap
 * (clean comet trail, not a filled C), and (2) a paper-thin stroke
 * (1px) that scales nicely on retina without looking heavy on 1×.
 */
function AgentStatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  // ── Status dot system ──
  // Every state shares the same outer touch box (`size`) so the row
  // rhythm never jumps when an agent transitions. Inside the box:
  //
  //   running   — solid #3b82f6 blue dot, gentle pulse animation.
  //               Calls clear attention to live work without spinning.
  //   starting  — same shape, dimmer blue, no pulse (still warming up).
  //   waiting   — orange pause bars (∥). Demands user action — distinct
  //               silhouette earns it.
  //   error     — solid red dot.
  //   idle/stopped — small hollow neutral ring. Present but recessive.
  //
  // Sizes are tuned for a 12px outer box: dot 5px, ring 5px.
  // Rationale: tiny enough that a column of idle agents stays calm,
  // big enough that a colored status reads instantly.

  if (status === "running") {
    // ── Working dots ──
    // Three dots fading in sequence — bare, no surrounding pill. The
    // surrounding row already provides enough visual context; wrapping
    // the dots in a chip made the running state feel like a separate
    // tag instead of an inline status. Same animation, just floating.
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        height: size, gap: 2.5, flexShrink: 0,
      }}>
        <style>{`@keyframes wdots { 0%,80%,100%{opacity:0.25;transform:translateY(0)} 40%{opacity:1;transform:translateY(-0.5px)} }`}</style>
        {[0, 1, 2].map(i => (
          <span key={i} aria-hidden style={{
            display: "block",
            width: 2.5, height: 2.5, borderRadius: "50%",
            background: "var(--c-med)",
            animation: `wdots 1.2s ease-in-out ${i * 0.18}s infinite`,
          }} />
        ))}
      </span>
    );
  }

  if (status === "starting") {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size, height: size, flexShrink: 0,
      }}>
        <span aria-hidden style={{
          display: "block",
          width: 5, height: 5, borderRadius: "50%",
          background: "#1e40af",
        }} />
      </span>
    );
  }

  if (status === "waiting") {
    return (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", gap: 2, flexShrink: 0 }}>
        <style>{`@keyframes pause-bar { 0%,100%{opacity:0.4;transform:scaleY(0.7)} 50%{opacity:1;transform:scaleY(1)} }`}</style>
        {[0, 1].map(i => (
          <span key={i} style={{
            width: 2, height: 6, borderRadius: 1.5, display: "block", flexShrink: 0,
            background: "#fb923c",
            animation: `pause-bar 1.8s ease-in-out ${i * 0.25}s infinite`,
            transformOrigin: "center",
          }} />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size, height: size, flexShrink: 0,
      }}>
        <span aria-hidden style={{
          width: 5, height: 5, borderRadius: "50%",
          background: "#f87171", display: "block",
        }} />
      </span>
    );
  }

  // idle / stopped — small hollow ring. Visible but quiet.
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, flexShrink: 0,
    }}>
      <span
        aria-hidden
        style={{
          display: "block",
          width: 5, height: 5,
          borderRadius: "50%",
          border: "1px solid var(--c-dim)",
          boxSizing: "border-box",
          background: "transparent",
        }}
      />
    </span>
  );
}

/* ── agent row ──
   Wrapped in React.memo with a custom equality function below
   that compares ONLY data props (session ref, isActive, stats,
   drag flags, shortcut index). The callback props are recreated
   on every parent render — the memoised row ignores those because
   they're stable closures over the latest store state, so a
   "new" callback identity doesn't mean a behaviour change. With
   N=20 sessions and a status-update arriving every few seconds,
   this drops sidebar work from "re-render every row" to "re-
   render only the row whose stats / status actually changed". */
function AgentRowImpl({ session, isActive, stats, onClick, onPin, onFork, onStop, onRestart, onReset, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isDropTarget, shortcutIndex }: {
  session: Session; isActive: boolean; stats?: SessionStats;
  onClick: () => void; onPin: () => void; onFork: () => void;
  onStop: () => void; onRestart: () => void; onReset: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void; onDragEnd: () => void;
  isDragging: boolean; isDropTarget: boolean;
  shortcutIndex?: number; // 1-based, 1-9
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menu]);

  const cost = stats?.total_cost_usd;
  const costLabel = cost != null && cost > 0
    ? cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
    : null;

  const isRunning = session.status === "running";
  const bgColor = isActive ? "var(--c-srf2)" : hovered ? "var(--c-srf)" : "transparent";
  const timeLabel = timeAgo(session.last_accessed ?? session.created_at);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: "relative", opacity: isDragging ? 0.4 : 1, transition: "none" }}
    >
      {isDropTarget && (
        <div style={{
          position: "absolute", top: 0, left: 8, right: 8, height: 2,
          background: "var(--primary)", borderRadius: 1, zIndex: 10, pointerEvents: "none",
        }} />
      )}

      <button
        onClick={onClick}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", padding: "4px 9px",
          borderRadius: 5, border: "none", cursor: "pointer", textAlign: "left",
          transition: "none",
          background: bgColor,
        }}
      >
        {/* Status indicator — the only visual ‘state’ signal. The active
            row carries it via background; nothing else needs to compete. */}
        <AgentStatusIcon status={session.status} size={11} />

        {/* Title — single line, ellipsis. Active OR running uses --c-high;
            everything else stays at --c-med so the live work stands out. */}
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 12.5, fontWeight: isActive ? 500 : 400, lineHeight: "17px",
          color: isRunning || isActive ? "var(--c-high)" : "var(--c-med)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {session.title}
        </span>

        {/* Right meta — at rest: just the time. On hover: provider logo +
            cost (or ⌘N if no cost yet). One thing per state, never both,
            so the row stops feeling like an info dump. */}
        {hovered ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <ProviderLogo tool={session.tool} size={10} />
            {costLabel ? (
              <span style={{
                fontSize: 10.5, color: "var(--c-dim)",
                fontFamily: "var(--font-mono)", lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
              }}>
                {costLabel}
              </span>
            ) : shortcutIndex != null && shortcutIndex <= 9 ? (
              <span style={{
                fontSize: 9.5, color: "var(--c-ghost)",
                fontFamily: "var(--font-mono)",
                border: "1px solid var(--c-brd2)", borderRadius: 3,
                padding: "0px 3px", lineHeight: "13px",
              }}>
                ⌘{shortcutIndex}
              </span>
            ) : null}
          </div>
        ) : (
          <span style={{
            fontSize: 11, color: "var(--c-ghost)", flexShrink: 0,
            fontFamily: "var(--font-mono)", lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}>
            {timeLabel}
          </span>
        )}

        {session.pinned && !hovered && (
          <Pin size={9} style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: 0.55 }} />
        )}
      </button>

      {menu && (
        <CtxMenu x={menu.x} y={menu.y} menuRef={menuRef} session={session}
          onClose={() => setMenu(null)} onPin={onPin} onFork={onFork}
          onStop={onStop} onRestart={onRestart} onReset={onReset} />
      )}
    </div>
  );
}

const AgentRow = memo(AgentRowImpl, (prev, next) => {
  // Re-render only when row-visible data changes. Callback props
  // are deliberately ignored — they're recreated each parent
  // render but always close over the latest store state, so an
  // "identity change" without a behaviour change shouldn't force
  // a re-render across N rows.
  return prev.session === next.session
    && prev.isActive === next.isActive
    && prev.stats === next.stats
    && prev.isDragging === next.isDragging
    && prev.isDropTarget === next.isDropTarget
    && prev.shortcutIndex === next.shortcutIndex;
});

/* ── sort menu ──
   `align` controls which side of the trigger the menu hangs from:
   "right" anchors the menu's right edge to the icon (macOS sidebar
   header — icons live on the right, menu grows leftward into the
   sidebar). "left" anchors the left edge (Windows title bar — icons
   live on the far left of the screen, so a right-anchored menu would
   spill off the left window edge). */
export function SortMenu({ value, onChange, align = "right" }: {
  value: string;
  onChange: (v: "recent" | "status" | "name") => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Ib onClick={() => setOpen(!open)} title="Sort agents"><SlidersHorizontal size={12} /></Ib>
      {open && (
        <div style={{
          position: "absolute",
          ...(align === "left" ? { left: 0 } : { right: 0 }),
          top: 28, zIndex: 9999,
          width: 120, borderRadius: 8, padding: "3px 0",
          background: "var(--popover)", border: "1px solid var(--border)",
          boxShadow: "0 6px 20px rgba(0,0,0,0.55)",
        }}>
          <div style={{ padding: "5px 10px 3px", fontSize: 11, color: "var(--c-dim)", fontWeight: 500 }}>Sort</div>
          {(["recent", "status", "name"] as const).map(k => (
            <button key={k} onClick={() => { onChange(k); setOpen(false); }} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              width: "100%", padding: "6px 10px", background: "none", border: "none",
              cursor: "pointer", fontSize: 12.5, textAlign: "left",
              color: value === k ? "var(--c-high)" : "var(--c-low)",
            }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--accent)"}
              onMouseLeave={e => e.currentTarget.style.background = "none"}
            >
              {k.charAt(0).toUpperCase() + k.slice(1)}
              {value === k && <Check size={10} style={{ color: "var(--c-low)" }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* (ModeRow segmented-toggle removed — Fleet / Workflows / Marketplace
   now live as ordinary SideRow entries in the main vertical nav stack
   so the sidebar reads as one consistent list instead of a toggle on
   top of a list.) */

/* ── SideRow ──
   The single nav primitive used everywhere in the sidebar — primary
   actions, mode switches (Fleet/Workflows/Marketplace), and footer items
   all share these metrics so the whole rail reads as one consistent list.

   Active state lifts onto the same surface the agent rows use, so a
   selected mode visually mirrors a selected session. */
function SideRow({ icon, label, onClick, badge, active, count, tourKey }: {
  icon: React.ReactNode; label: string; onClick?: () => void;
  badge?: string; active?: boolean; count?: number;
  /** Optional data-tour attribute so the first-launch tour can
   *  anchor a spotlight to this row by selector. */
  tourKey?: string;
}) {
  const baseBg    = active ? "var(--c-srf2)" : "transparent";
  const baseColor = active ? "var(--c-high)" : "var(--c-med)";
  const iconColor = active ? "var(--c-high)" : "var(--c-dim)";
  return (
    <button onClick={onClick} data-tour={tourKey} style={{
      display: "flex", alignItems: "center", gap: 9, width: "100%",
      padding: "4px 9px", border: "none", cursor: "pointer",
      textAlign: "left", fontSize: 12.5,
      fontWeight: active ? 500 : 400,
      borderRadius: 5, background: baseBg,
      color: baseColor,
      transition: "none",
    }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; } }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-med)"; } }}
    >
      <span style={{ flexShrink: 0, display: "flex", color: iconColor, transition: "none" }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {count != null && count > 0 && (
        <span style={{
          fontSize: 10.5, color: active ? "var(--c-low)" : "var(--c-ghost)",
          fontVariantNumeric: "tabular-nums", lineHeight: 1, flexShrink: 0,
        }}>
          {count}
        </span>
      )}
      {badge && (
        <span style={{
          fontSize: 9.5, color: "var(--c-low)",
          background: "var(--c-srf2)",
          padding: "1px 6px", borderRadius: 3, fontWeight: 500,
          letterSpacing: 0.2,
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}

/* ══════════════════════════════════════
   SIDEBAR
══════════════════════════════════════ */
/* ── Collapsed rail — shown when sidebarCollapsed is true. Keeps the main
     app actions reachable with a single click so users don't have to reopen
     the full sidebar just to create or switch to a session. ── */
export function CollapsedSidebar() {
  const showLogo = useMemo(() => usesInAppTitleBar(), []);
  return <CollapsedRail showLogo={showLogo} />;
}

function CollapsedRail({ showLogo }: { showLogo: boolean }) {
  // Per-field selectors — full-state useAppStore() re-rendered the rail
  // on every notification push, pane focus change, draft keystroke, etc.
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const handleNew = useCallback(() => {
    window.dispatchEvent(new Event("fleet:new-agent"));
  }, []);

  const railBtn = (
    title: string,
    icon: React.ReactNode,
    onClick: () => void,
    active = false,
    tourKey?: string,
  ) => (
    <button
      key={title}
      title={title}
      onClick={onClick}
      data-tour={tourKey}
      style={{
        width: 32, height: 32, borderRadius: 8, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: active ? "var(--c-srf2)" : "none",
        color: active ? "var(--c-high)" : "var(--c-dim)",
        border: "none", cursor: "pointer", transition: "none",
      }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-med)"; } }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; } }}
    >
      {icon}
    </button>
  );

  return (
    <nav data-tour="sidebar-rail" style={{
      height: "100%", width: "100%",
      display: "flex", flexDirection: "column", alignItems: "center",
      background: "var(--sidebar)", overflow: "hidden", userSelect: "none",
      paddingBottom: 10,
    }}>
      {/* Top slot — drag spacer only.
          On Windows the brand mark moved out of the sidebar entirely
          (sidebar controls now live in the dedicated title bar above
          the shell), and we collapse the slot height so the rail
          buttons sit closer to the top. On macOS we still reserve a
          generous slot so the OS-drawn traffic lights have room. */}
      <div
        className="drag-region"
        style={{
          height: showLogo ? 8 : 38, width: "100%", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      />
      {/* No brand mark on Windows — the title bar above the shell
          owns the chrome (and our caption controls). On macOS the
          empty drag region above keeps the OS traffic-light buttons
          clear of the rail buttons below. */}

      {/* Primary actions — vision: Fleet stays the only main surface, no
          competing tabs in the rail. Workflows/Marketplace move to the
          bottom "Tools" section in the expanded sidebar only. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
        {railBtn("Expand sidebar", <PanelLeftClose size={15} style={{ transform: "rotate(180deg)" }} />, toggleSidebar)}
        {railBtn("New agent",      <Plus size={15} strokeWidth={2} />, handleNew, false, "new-agent")}
        {railBtn("Fleet",          <LayoutGrid size={14} />, () => setActiveSession(null), !activeSessionId, "fleet-hub")}
        {railBtn("Search",         <Search size={14} />, () => {
          window.dispatchEvent(new Event("fleet:new-agent"));
        })}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Footer actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {railBtn("Settings", <Settings size={14} />, () =>
          window.dispatchEvent(new Event("fleet:open-settings")),
          false, "settings",
        )}
        {railBtn("Help", <HelpCircle size={14} />, openDocs)}
      </div>
    </nav>
  );
}

export function Sidebar() {
  const showLogo = useMemo(() => usesInAppTitleBar(), []);
  // ── Per-field selectors ──
  // Was: a single full-state destructure of useAppStore(). Zustand
  // returns the entire state, so EVERY app-store mutation (every
  // notification push, every draft keystroke, every pane focus
  // change, every WS-driven session-status patch) re-rendered the
  // sidebar — re-running the heavy sort/group/filter pipeline below
  // and rebuilding all the AgentRow JSX (which then bailed out on
  // memo, but the parent work was wasted). Per-field selectors
  // return primitives or function refs (stable), so the sidebar
  // only re-renders when one of these specific fields actually
  // changes.
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const staffSessionId = useAppStore(s => s.staffSessionId);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const addSession = useAppStore(s => s.addSession);
  const updateSession = useAppStore(s => s.updateSession);
  const mainView = useAppStore(s => s.mainView);
  const setMainView = useAppStore(s => s.setMainView);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  const splitPaneIds = useAppStore(s => s.splitPaneIds);
  const appMode = useAppStore(s => s.appMode);
  const setAppMode = useAppStore(s => s.setAppMode);
  const studioComposerOpen = useAppStore(s => s.studioComposerOpen);
  const openStudioComposer = useAppStore(s => s.openStudioComposer);
  const closeStudioComposer = useAppStore(s => s.closeStudioComposer);
  // Sessions that were spawned by a routine — filtered out of the
  // sidebar so background routine work doesn't pollute the user's
  // agent list. Re-reads on every routine-runtime notify (run added,
  // routine deleted, etc.).
  const [spawnedSet, setSpawnedSet] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("fleet:routines:spawned:v1");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    let cancelled = false;
    void import("@/services/routines-runtime").then(m => {
      if (cancelled) return;
      setSpawnedSet(m.loadSpawnedSessionIds());
      const off = m.subscribe(() => {
        if (!cancelled) setSpawnedSet(m.loadSpawnedSessionIds());
      });
      return () => { cancelled = true; off(); };
    });
    return () => { cancelled = true; };
  }, []);
  // Sessions that currently have a pending permission dialog.
  // Was: `useChatStore(s => s.sessions)` which subscribed to the whole
  // sessions record — Zustand replaces that top-level ref on EVERY
  // streaming-token patch (appendStreamAndContent rebuilds the
  // sessions object). With 30 deltas/sec the sidebar re-ran its
  // sort/filter/group pipeline 30 times/sec during a stream, all to
  // notice that the permission set was unchanged. useShallow over a
  // permission-only id array compares element-wise, so the sidebar
  // only re-renders when the SET of waiting ids actually changes.
  const waitingIdList = useChatStore(useShallow((s) => {
    const ids: string[] = [];
    for (const id in s.sessions) {
      if (s.sessions[id]!.permissionRequest != null) ids.push(id);
    }
    return ids;
  }));
  const waitingIds = useMemo(() => new Set(waitingIdList), [waitingIdList]);

  // Search + sort were lifted to the store so the Windows title bar
  // (which now owns these icon controls) and the sidebar (which still
  // owns the overlay + list) share one source of truth. On macOS the
  // icons stay in the sidebar header and read the same state, so the
  // behavior is identical across platforms even though the icon home
  // differs.
  const searchOpen = useAppStore(s => s.sidebarSearchOpen);
  const setSearchOpen = useAppStore(s => s.setSidebarSearchOpen);
  const toggleSearch = useAppStore(s => s.toggleSidebarSearch);
  const searchVal = useAppStore(s => s.sidebarSearchVal);
  const setSearchVal = useAppStore(s => s.setSidebarSearchVal);
  const sortBy = useAppStore(s => s.sidebarSortBy);
  const setSortBy = useAppStore(s => s.setSidebarSortBy);
  const [statsMap,   setStatsMap]   = useState<Record<string, SessionStats>>({});
  const [dragId,     setDragId]     = useState<string | null>(null);
  const [dropId,     setDropId]     = useState<string | null>(null);
  const [dropPinZone, setDropPinZone] = useState(false);
  // Give-Feedback modal — mounted at the bottom of the sidebar's JSX
  // and triggered from the footer's "Give Feedback" row. Lives here
  // (not at the app root) because the trigger is part of this
  // component; the modal itself is position:fixed so DOM placement
  // doesn't affect stacking.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  // Fetch bulk stats periodically
  useEffect(() => {
    const load = () => fetchBulkStats().then(setStatsMap).catch(() => {});
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, []);

  const handleNew = useCallback(() => {
    window.dispatchEvent(new Event("fleet:new-agent"));
  }, []);

  const handlePin = useCallback(async (session: Session) => {
    const p = !session.pinned;
    await fetch(`/api/sessions/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: p }) });
    updateSession(session.id, { pinned: p });
  }, [updateSession]);

  const handleFork = useCallback(async (session: Session) => {
    try { const f = await forkSession(session.id); addSession(f); setActiveSession(f.id); }
    catch (e) { console.error(e); }
  }, [addSession, setActiveSession]);

  const handleStop = useCallback(async (session: Session) => {
    try {
      await stopSession(session.id);
      updateSession(session.id, { status: "idle" });
    } catch (e) { console.error(e); }
  }, [updateSession]);

  const handleRestart = useCallback(async (session: Session) => {
    try {
      await restartSession(session.id);
      updateSession(session.id, { status: "idle" });
    } catch (e) { console.error(e); }
  }, [updateSession]);

  const handleReset = useCallback(async (session: Session) => {
    // Confirm-then-reset. Mirrors the prompt() pattern used for
    // rename and archive — keeps the destructive action one keypress
    // away without dragging in a full modal.
    const ok = typeof window === "undefined" ? true : window.confirm(
      `Reset "${session.title}"?\n\n` +
      "This wipes the Claude conversation cursor and starts the next " +
      "message in a brand-new Claude session. Your chat history here " +
      "is preserved — only the upstream resume id is dropped. " +
      "Use this if the agent is stuck on \"No conversation found\"."
    );
    if (!ok) return;
    try {
      await resetSession(session.id);
      // Mirror the backend write — null the resume id in the client
      // store so the UI doesn't show stale state until the next refetch.
      updateSession(session.id, { status: "idle", claude_session_id: null });
    } catch (e) { console.error(e); }
  }, [updateSession]);

  // Local-only (compose-phase) sessions stay out of the sidebar
  // list until the user sends their first message — commitDraft()
  // swaps the local entry for a real backend row at that point, the
  // `local_only` flag goes away, and the session appears here
  // naturally. Keeps the list from being polluted by abandoned drafts.
  const allAgents = sessions.filter(s =>
    s.id !== staffSessionId
    && !s.local_only
    && !spawnedSet.has(s.id)
    && !isStudioTool(s.tool)
  );
  const filtered  = searchVal ? allAgents.filter(s => s.title.toLowerCase().includes(searchVal.toLowerCase())) : allAgents;
  const sorted = [...filtered].sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
    if (sortBy === "status") {
      const ord = { running: 0, waiting: 1, error: 2, starting: 3, idle: 4, stopped: 5 };
      return (ord[a.status as keyof typeof ord] ?? 4) - (ord[b.status as keyof typeof ord] ?? 4);
    }
    if (sortBy === "name") return a.title.localeCompare(b.title);
    return 0;
  });


  const handleDropToPin = useCallback(() => {
    if (!dragId) return;
    const session = allAgents.find(s => s.id === dragId);
    if (session && !session.pinned) handlePin(session);
    setDragId(null); setDropPinZone(false);
  }, [dragId, allAgents, handlePin]);

  const handleDrop = useCallback((targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = sorted.map(s => s.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx   = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId);
    // ── Optimistic local update first, then persist with surfaced errors ──
    // Was: N PATCH requests fired in parallel with `.catch(() => {})`.
    // If 3 of 30 PATCHes failed, the local order persisted but the
    // server had a partial order — the next 5s poll then scrambled the
    // sidebar visibly. Now: persist all of them, await Promise.all, and
    // if anything failed surface a toast so the user knows to retry.
    next.forEach((id, i) => updateSession(id, { order_idx: i } as Partial<Session>));
    const auth = (() => {
      try { return JSON.parse(localStorage.getItem("fleet:token") ?? "null"); }
      catch { return null; }
    })();
    void auth; // future: send Authorization header
    Promise.allSettled(
      next.map((id, i) =>
        fetch(`/api/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_idx: i }),
        }).then(r => {
          if (!r.ok) throw new Error(`PATCH ${id} → ${r.status}`);
        })
      ),
    ).then(results => {
      const failed = results.filter(r => r.status === "rejected").length;
      if (failed > 0) {
        // Partial reorder failure — used to surface a notification toast,
        // but the notification system has been removed. Log so the failure
        // is at least visible in the console.
        console.warn(`[sidebar] Order not fully saved: ${failed} of ${next.length} agents could not be reordered.`);
      }
    });
    setDragId(null); setDropId(null);
  }, [dragId, sorted, updateSession]);

  const pinnedAgents = sorted.filter(s => s.pinned);
  const unpinned = sorted.filter(s => !s.pinned);
  const unpinnedGrouped = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of unpinned) {
      const key = folderName(s.project_path) ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries()).map(([name, items]) => ({ name, items }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, searchVal, sortBy]);

  // Build a 1-based shortcut index map over sorted sessions (1–9 only)
  const shortcutIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    sorted.forEach((s, i) => { if (i < 9) map.set(s.id, i + 1); });
    return map;
  }, [sorted]);

  const agentRowProps = (s: Session) => ({
    session: waitingIds.has(s.id) ? { ...s, status: "waiting" as const } : s,
    // In split mode every pane's session counts as active so the
    // sidebar marks ALL of them, not just the global activeSessionId.
    // Single-view falls back to the original equality check.
    isActive: splitPaneIds.length > 1
      ? splitPaneIds.includes(s.id)
      : s.id === activeSessionId,
    stats: statsMap[s.id],
    shortcutIndex: shortcutIndexMap.get(s.id),
    onClick: () => { setMainView("fleet"); setActiveSession(s.id); },
    onPin: () => handlePin(s),
    onFork: () => handleFork(s),
    onStop: () => handleStop(s),
    onRestart: () => handleRestart(s),
    onReset: () => handleReset(s),
    isDragging: dragId === s.id,
    isDropTarget: dropId === s.id && dragId !== s.id,
    onDragStart: (e: React.DragEvent) => {
      setDragId(s.id);
      // Cross-target drag payload for the split-pane grid (and any
      // other drop zone outside the sidebar). Sidebar-internal
      // reorder still uses dragId state; this just adds an extra
      // channel so dropping a session ONTO a chat pane works.
      e.dataTransfer.setData("application/x-fleet-session-id", s.id);
      e.dataTransfer.effectAllowed = "copyMove";
    },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDropId(s.id); },
    onDrop: () => handleDrop(s.id),
    onDragEnd: () => { setDragId(null); setDropId(null); },
  });

  return (
    <nav data-tour="sidebar-rail" style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: "var(--sidebar)", overflow: "hidden", userSelect: "none",
    }}>

      {/* Windows breathing room — sidebar sits flush under the dedicated
          title bar above it; without a small spacer the "New session" row
          (and the search overlay, when open) feel glued to the chrome. */}
      {showLogo && <div style={{ height: 10, flexShrink: 0 }} />}

      {/* ══ TOP BAR (macOS only) ══
          On macOS the OS-drawn traffic-light buttons live at the top
          of the window, so the sidebar still mounts its 44px top bar
          with a 78px left inset to clear them, and keeps the toggle /
          search / sort trio on the right. On Windows the same trio
          now lives in the dedicated top title-bar row at the very
          top of the shell — so we render no top bar here at all,
          and the sidebar content slides up to fill the freed space. */}
      {!showLogo && (
        <div
          className="drag-region"
          style={{
            height: 44, flexShrink: 0,
            display: "flex", alignItems: "center",
            padding: "0 10px 0 78px",
          }}
        >
          <div style={{ flex: 1 }} />
          {/* ── Vertical alignment math (macOS) ──
                traffic-light top      = y:16 (main.cjs)  → center y:22
                chat-view IBtn (30×30) = (44-30)/2 = top y:7  → center y:22
                sidebar starts at window y:8 (outer 8px inset)
                sidebar Ib (24×24) centered in 44px bar would land at
                  window y: 8 + (44-24)/2 + 12 = y:30 — 8px below the rest
                -8 marginTop pulls it back up to window y:22  ✓
              All three icon centers now sit on a single horizontal line. */}
          <div className="no-drag" style={{
            display: "flex", gap: 1,
            marginTop: -8,
          }}>
            <Ib onClick={toggleSidebar} title="Hide sidebar"><PanelLeft size={12} /></Ib>
            <Ib onClick={toggleSearch} title="Search"><Search size={12} /></Ib>
            <SortMenu value={sortBy} onChange={setSortBy} />
          </div>
        </div>
      )}

      {/* ══ SEARCH OVERLAY ══ */}
      {searchOpen && (
        <div style={{ padding: "0 8px 6px", flexShrink: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "5px 10px", borderRadius: 8,
            background: "var(--c-srf)", border: "1px solid var(--c-brd)",
          }}>
            <Search size={12} style={{ color: "var(--c-ghost)", flexShrink: 0 }} />
            <input
              ref={searchRef}
              value={searchVal}
              onChange={e => setSearchVal(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") { setSearchOpen(false); setSearchVal(""); } }}
              placeholder="Search…"
              style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 12.5, color: "var(--foreground)", fontFamily: "inherit" }}
            />
            <button onClick={() => { setSearchOpen(false); setSearchVal(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-ghost)", display: "flex", padding: 0 }}>
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* ══ FULL SCROLL AREA — nav + sessions flow together ══ */}
      <ReactLenis className="scroll-subtle" style={{ flex: 1, overflow: "hidden", minHeight: 0, overscrollBehavior: "none" }} options={{ lerp: 0.09, smoothWheel: true, wheelMultiplier: 0.9, easing: (t: number) => 1 - Math.pow(1 - t, 4) }}>
        <div style={{ padding: "0 6px" }}>

        {/* ── Primary nav stack ──
            One unified vertical list: action + 3 main views + utilities.
            All rows share the same SideRow metrics so the rail reads as
            a single coherent navigation surface. The active mode lifts
            onto the same surface a selected session uses, so mode and
            session selection feel like the same primitive. */}

        {/* ── Workspace / Studio mode toggle ──
            Top-level surface switch. Workspace = agent/chat experience;
            Studio = media-generation surface. */}
        <div style={{ display: "flex", gap: 4, padding: "0 3px 6px" }}>
          {(["workspace", "studio"] as const).map((m) => {
            const active = appMode === m;
            return (
              <button
                key={m}
                onClick={() => setAppMode(m)}
                style={{
                  flex: 1, padding: "4px 0", fontSize: 11.5,
                  fontWeight: active ? 600 : 500,
                  borderRadius: 5,
                  border: `1px solid ${active ? "var(--c-brd)" : "transparent"}`,
                  background: active ? "var(--c-srf2)" : "transparent",
                  color: active ? "var(--c-high)" : "var(--c-med)",
                  cursor: "pointer", transition: "none",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--c-high)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--c-med)"; }}
              >
                {m === "workspace" ? "Workspace" : "Studio"}
              </button>
            );
          })}
        </div>

        {/* Create action — Workspace creates an agent session; Studio opens
            the generation composer. Fleet below is the SAME shared operations
            center in both modes. Routines / Marketplace and the session list
            differ per mode (Workspace agents vs Studio generations). */}
        {appMode === "studio" ? (
          <SideRow
            icon={<Plus size={13} strokeWidth={2.2} />}
            label="New generation"
            active={studioComposerOpen}
            onClick={() => openStudioComposer()}
          />
        ) : (
          <SideRow
            icon={<Plus size={13} strokeWidth={2.2} />}
            label="New session"
            onClick={handleNew}
            tourKey="new-agent"
          />
        )}

        {/* Real Fleet surfaces — the SAME shared operations center in both
            Workspace and Studio modes. */}
        <SideRow
          icon={<LayoutGrid size={13} />}
          label="Fleet"
          active={mainView === "fleet" && !activeSessionId && !studioComposerOpen}
          count={allAgents.length}
          onClick={() => { closeStudioComposer(); setMainView("fleet"); setActiveSession(null); }}
        />
        {/* Routines + Marketplace are Workspace-only. */}
        {appMode === "workspace" && (
          <>
            <SideRow
              icon={<Repeat size={13} />}
              label="Routines"
              active={mainView === "workflows"}
              onClick={() => { setMainView("workflows"); setActiveSession(null); }}
            />
            <SideRow
              icon={<Store size={13} />}
              label="Marketplace"
              active={mainView === "marketplace"}
              onClick={() => { setMainView("marketplace"); setActiveSession(null); }}
            />
          </>
        )}
        {/* Subtle gap before sessions */}
        <div style={{ height: 6 }} />

        {/* Sessions — Studio shows generation sessions; Workspace shows agents. */}
        {appMode === "studio" ? (
        <div style={{ paddingBottom: 8 }}>
          {(() => {
            const studioSessions = sessions.filter(s => isStudioTool(s.tool) && !s.local_only && !s.archived_at);
            return studioSessions.length === 0 ? (
              <div style={{ padding: "4px 10px", fontSize: 11.5, color: "var(--c-ghost)" }}>No generations yet.</div>
            ) : (
              studioSessions.map(s => (
                <SideRow key={s.id} icon={<ProviderLogo tool="higgsfield" size={14} />} label={s.title || "Generation"} active={activeSessionId === s.id} onClick={() => setActiveSession(s.id)} />
              ))
            );
          })()}
        </div>
        ) : (
        <div style={{ paddingBottom: 8 }}>
            {sorted.length === 0 ? (
              <div style={{ padding: "4px 10px", fontSize: 11.5, color: "var(--c-ghost)", lineHeight: 1.5 }}>
                {searchVal ? "No results." : (
                  <button onClick={handleNew} style={{ background: "none", border: "none", color: "var(--c-ghost)", cursor: "pointer", fontSize: 11.5, padding: 0, fontFamily: "inherit", textAlign: "left" }}>
                    No agents yet. Create one →
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* ── Pinned section — always visible (matches reference) ── */}
                <div style={{ marginBottom: 2 }}>
                  <div style={{
                    padding: "10px 10px 4px",
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <span style={{
                      flex: 1,
                      fontSize: 11.5, color: "var(--c-ghost)", fontWeight: 400,
                    }}>
                      Pinned
                    </span>
                    {pinnedAgents.length > 0 && (
                      <span style={{
                        fontSize: 11, color: "var(--c-ghost)",
                        fontVariantNumeric: "tabular-nums", lineHeight: 1,
                      }}>
                        {pinnedAgents.length}
                      </span>
                    )}
                  </div>
                  {pinnedAgents.map(s => <AgentRow key={s.id} {...agentRowProps(s)} />)}

                  {/* Drag to pin — always shown unless dragging a pinned session */}
                  {(!dragId || !allAgents.find(s => s.id === dragId)?.pinned) && (
                    <div
                      onDragOver={e => { e.preventDefault(); setDropPinZone(true); }}
                      onDragLeave={() => setDropPinZone(false)}
                      onDrop={() => handleDropToPin()}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "4px 9px",
                        borderRadius: 5,
                        background: dropPinZone ? "var(--c-srf)" : "transparent",
                        transition: "none",
                      }}
                    >
                      <Pin size={11} style={{ color: dropPinZone ? "var(--c-med)" : "var(--c-ghost)", flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: dropPinZone ? "var(--c-low)" : "var(--c-ghost)" }}>
                        Drag to pin
                      </span>
                    </div>
                  )}
                </div>

                {/* ── Project groups ── */}
                {unpinnedGrouped.map(({ name, items }, gi) => (
                  <div key={name || "__none__"}>
                    {name ? (
                      <div style={{
                        padding: "12px 10px 4px",
                        display: "flex", alignItems: "center", gap: 6,
                      }}>
                        <span style={{
                          flex: 1,
                          fontSize: 11.5, fontWeight: 400,
                          color: "var(--c-ghost)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {name}
                        </span>
                        <span style={{
                          fontSize: 11, color: "var(--c-ghost)",
                          fontVariantNumeric: "tabular-nums", lineHeight: 1,
                          flexShrink: 0,
                        }}>
                          {items.length}
                        </span>
                      </div>
                    ) : (
                      /* unnamed group — add spacing when not first */
                      gi > 0 || pinnedAgents.length > 0
                        ? <div style={{ height: 6 }} />
                        : null
                    )}
                    {items.map(s => <AgentRow key={s.id} {...agentRowProps(s)} />)}
                  </div>
                ))}
              </>
            )}
        </div>
        )}
        </div>
      </ReactLenis>

      {/* ══ FOOTER GROUP ══
          Settings / Get Help / Account stack tightly at the bottom — one
          padded block, no separator line, matches the reference layout. */}
      <div style={{ flexShrink: 0, padding: "6px 6px 8px" }}>
        <SideRow icon={<Library size={13} />} label="Library"
          onClick={() => window.dispatchEvent(new Event("fleet:open-library"))} />
        <SideRow icon={<Settings size={13} />} label="Settings"
          onClick={() => window.dispatchEvent(new Event("fleet:open-settings"))}
          tourKey="settings" />
        <SideRow icon={<HelpCircle size={13} />} label="Get Help" onClick={openDocs} />
        <SideRow icon={<MessageCircle size={13} />} label="Give Feedback"
          onClick={() => setFeedbackOpen(true)} />
        <AccountFooter />
      </div>

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </nav>
  );
}
