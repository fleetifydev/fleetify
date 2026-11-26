import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutGrid, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { useChatStore, type SessionChatState } from "@/stores/chat-store";
import { wsManager } from "@/services/ws-manager";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { StatusRing, StatPair, shortModel } from "@/components/dashboard/fleet-panel";
import { folderName } from "@/lib/utils";
import type { Session } from "@/types/session";
import { layoutOrbits, pointOn, ringFor, type OrbitRing } from "./orbit-layout";
import { RiveScene, SCENE_RADIUS, SCENE_SIZE } from "./scene/rive-scene";
import { accentFor, buildScene } from "./scene/scene-model";

/** Fleet's home: every session on one of three orbits around Fleet. The inner
 *  ring holds what needs the user, the middle ring what is working, the outer
 *  ring what has finished. It is built from the Fleet hub's own parts: the
 *  session row (status ring, agent logo, title, project · model · cost), the
 *  hub's stat strip, and the Fleet decision card for what a session asks. */

const MONO = "'SF Mono','Menlo','Consolas',monospace";
const C_ORANGE = "#fb923c";

const RINGS: { ring: OrbitRing; scale: number; label: string }[] = [
  { ring: "needs", scale: 0.36, label: "Needs you" },
  { ring: "working", scale: 0.68, label: "Working" },
  { ring: "done", scale: 1, label: "Done" },
];

interface Props {
  sessions: Session[];
  onOpen: (id: string) => void;
}

/** What a waiting session is asking, in its own words. */
function askOf(cs: SessionChatState | undefined): { text: string; permission: boolean } | null {
  if (!cs) return null;
  if (cs.permissionRequest) {
    const p = cs.permissionRequest;
    return { text: `Run ${p.command || p.tool_name}`, permission: true };
  }
  const q = cs.askQuestion?.questions[0]?.question;
  if (q) return { text: q, permission: false };
  for (let i = cs.messages.length - 1; i >= 0; i--) {
    const m = cs.messages[i];
    if (!m || m.role !== "assistant") continue;
    const text = m.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join(" ").trim();
    if (text) return { text, permission: false };
  }
  return null;
}

const money = (n: number | undefined) => ((n ?? 0) > 0 ? `$${(n ?? 0).toFixed(2)}` : "$0");
const agoMin = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** The Fleet hub's session row, folded into a chip that sits on an orbit. */
function SessionChip({ session, ring, onOpen, bare = false }: { session: Session; ring: OrbitRing; onOpen: () => void; bare?: boolean }) {
  const waiting = ring === "needs";
  const project = session.project_path ? folderName(session.project_path) : null;
  const model = shortModel(session.model_name);
  if (ring === "done") {
    // Finished work sits far out and small: one line, no meta.
    return (
      <button type="button" onClick={onOpen} className="orbit-chip orbit-chip--done" title={`Open ${session.title}`}>
        <span className="orbit-chip-row">
          {!bare && <StatusRing status={session.status} size={10} />}
          {session.tool && <ProviderLogo tool={session.tool} size={10} />}
          <span className="orbit-chip-title">{session.title || "Untitled"}</span>
        </span>
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} className={`orbit-chip${waiting ? " orbit-chip--waiting" : ""}`}
      title={`Open ${session.title}`}>
      {waiting && <span aria-hidden className="orbit-chip-strip" />}
      <span className="orbit-chip-row">
        {!bare && <StatusRing status={waiting ? "waiting" : session.status} size={11} />}
        {session.tool && <ProviderLogo tool={session.tool} size={11} />}
        <span className="orbit-chip-title">{session.title || "Untitled"}</span>
      </span>
      <span className="orbit-chip-meta" style={{ fontFamily: MONO, marginLeft: bare ? 19 : undefined }}>
        {project && <span>{project}</span>}
        {model && <><i>·</i><span className="dim">{model}</span></>}
        <i>·</i><span>{money(session.budget_used)}</span>
      </span>
    </button>
  );
}

/** The Fleet decision card (fleet-decision-card.tsx), for a session that asks. */
function AskCard({ session, cs, onOpen }: { session: Session; cs: SessionChatState | undefined; onOpen: () => void }) {
  const ask = askOf(cs);
  const perm = cs?.permissionRequest ?? null;
  const Icon = ask?.permission ? ShieldQuestion : MessageCircleQuestion;
  return (
    <div className="orbit-ask">
      <div className="orbit-ask-head">
        <span className="orbit-ask-name">{session.title || "Untitled"}</span>
        <span className="orbit-ask-kind">· {ask?.permission ? "Wants permission" : "Needs your input"}</span>
        <span style={{ flex: 1 }} />
        <span className="orbit-ask-ago">{agoMin(session.last_accessed)}</span>
      </div>
      <div className="orbit-ask-body">
        <Icon size={13} strokeWidth={2} style={{ color: C_ORANGE, flexShrink: 0, marginTop: 2 }} />
        <span>{ask ? ask.text : "Waiting for you."}</span>
      </div>
      <div className="orbit-ask-actions">
        {perm ? (
          <>
            <button type="button" className="orbit-pill orbit-pill--primary"
              onClick={() => wsManager.sendPermissionResponse(session.id, perm.id, true, false, perm.tool_name)}>Allow</button>
            <button type="button" className="orbit-pill"
              onClick={() => wsManager.sendPermissionResponse(session.id, perm.id, false, false, perm.tool_name)}>Deny</button>
            <button type="button" className="orbit-pill" onClick={onOpen}>Open</button>
          </>
        ) : (
          <>
            <button type="button" className="orbit-pill orbit-pill--primary" onClick={onOpen}>Answer</button>
            <button type="button" className="orbit-pill" onClick={onOpen}>Open session</button>
          </>
        )}
      </div>
    </div>
  );
}

export function OrbitMap({ sessions, onOpen }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chat = useChatStore(s => s.sessions);

  const { placed, hidden, byId } = useMemo(() => {
    const byId = new Map(sessions.map(s => [s.id, s]));
    const items = sessions.map(s => {
      const cs = chat[s.id];
      return {
        id: s.id,
        ring: ringFor(s.status, !!(cs?.permissionRequest || cs?.askQuestion), !!cs?.isStreaming),
        lastActive: s.last_accessed ? new Date(s.last_accessed).getTime() : 0,
      };
    });
    return { ...layoutOrbits(items), byId };
  }, [sessions, chat]);

  const counts = { needs: 0, working: 0, done: 0 } as Record<OrbitRing, number>;
  for (const p of placed) counts[p.ring]++;
  const spent = sessions.reduce((a, s) => a + (s.budget_used ?? 0), 0);

  const { w, h } = size;
  const cx = w / 2, cy = h / 2;

  // The Rive scene draws the orbits, the core and the nodes; it is off for
  // Reduce Motion and wherever WebGL2 or the file fails, and the DOM map below
  // (the static tier) takes over.
  const [riveState, setRiveState] = useState<"loading" | "on" | "off">(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "off" : "loading");
  const useRive = riveState !== "off";
  const scene = useMemo(() => buildScene(
    placed,
    id => ({ activity: chat[id]?.isStreaming ? 0.8 : 0, accent: accentFor(byId.get(id)?.tool) }),
    "full",
  ), [placed, chat, byId]);

  // Geometry: the Rive file's own orbits (fit contain) when it draws, else the DOM ellipses.
  const fit = Math.min(w / SCENE_SIZE.w, h / SCENE_SIZE.h);
  const RX = Math.max(0, Math.min(w / 2 - 120, 500));
  const RY = Math.max(0, Math.min(h / 2 - 30, 300));
  const at = (ring: OrbitRing, angle: number) => {
    if (useRive) return pointOn(cx, cy, SCENE_RADIUS[ring] * fit, SCENE_RADIUS[ring] * fit, angle);
    const scale = RINGS.find(r => r.ring === ring)!.scale;
    return pointOn(cx, cy, RX * scale, RY * scale, angle);
  };
  const ringTop = (ring: OrbitRing, scale: number) => useRive ? cy - SCENE_RADIUS[ring] * fit : cy - RY * scale;
  const needs = placed.filter(p => p.ring === "needs");

  return (
    <div className="orbit-map">
      <div className="orbit-strip">
        <StatPair value={sessions.length} label="Agents" />
        <StatPair value={counts.needs} label="Need you" accent={counts.needs ? C_ORANGE : undefined} />
        <StatPair value={counts.working} label="Working" />
        <StatPair value={money(spent)} label="Spent" />
        {hidden > 0 && <span className="orbit-strip-note">{hidden} more in the sidebar</span>}
      </div>

      <div ref={ref} className="orbit-field">
        {useRive && <RiveScene state={scene} onReady={ok => setRiveState(ok ? "on" : "off")} />}
        {w > 0 && (
          <>
            {!useRive && <svg aria-hidden width={w} height={h} className="orbit-lines">
              {RINGS.map(r => (
                <ellipse key={r.ring} cx={cx} cy={cy} rx={RX * r.scale} ry={RY * r.scale}
                  fill="none" stroke="var(--c-brd)" strokeWidth={1} strokeDasharray={r.ring === "done" ? "2 4" : undefined} />
              ))}
              {needs.map(p => {
                const [x, y] = at("needs", p.angle);
                return <line key={p.id} x1={cx} y1={cy} x2={x} y2={y} stroke={C_ORANGE} strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 4" />;
              })}
            </svg>}

            {RINGS.map(r => (
              <div key={r.ring} className="orbit-ring-label" style={{ left: cx, top: ringTop(r.ring, r.scale) }}>
                <span>{r.label}</span>
                {counts[r.ring] > 0 && <b>{counts[r.ring]}</b>}
              </div>
            ))}

            {placed.map(p => {
              const s = byId.get(p.id);
              if (!s) return null;
              // Over the Rive scene, a session with a question card is named by its card.
              if (useRive && needs.slice(0, 2).some(n => n.id === p.id)) return null;
              const [x, y] = at(p.ring, p.angle);
              // Over the Rive scene the label sits beside its node; on the DOM map the chip is the node.
              const side = !useRive ? "" : x < cx - 4 ? " orbit-anchor--left" : " orbit-anchor--right";
              return (
                <div key={p.id} className={`orbit-anchor${side}`} style={{ left: x, top: y }}>
                  <SessionChip session={s} ring={p.ring} bare={useRive} onOpen={() => onOpen(p.id)} />
                </div>
              );
            })}

            {/* The first two that ask: their card opens on the outer side. */}
            {needs.slice(0, 2).map(p => {
              const s = byId.get(p.id);
              if (!s) return null;
              const [x, y] = at("needs", p.angle);
              const left = x < cx;
              const cw = 300, gap = 112;
              const lx = left ? Math.max(12, x - gap - cw) : Math.min(w - cw - 12, x + gap);
              return (
                <div key={p.id} className="orbit-ask-anchor" style={{ left: lx, top: y, width: cw }}>
                  <AskCard session={s} cs={chat[p.id]} onOpen={() => onOpen(p.id)} />
                </div>
              );
            })}

            {!useRive ? (
              <div className="orbit-core" style={{ left: cx, top: cy }}>
                <span className="orbit-core-mark"><LayoutGrid size={19} /></span>
                <span className="orbit-core-name">Fleet</span>
              </div>
            ) : (
              <div className="orbit-core orbit-core--over" style={{ left: cx, top: cy + 34 * fit + 10 }}>
                <span className="orbit-core-name">Fleet</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
