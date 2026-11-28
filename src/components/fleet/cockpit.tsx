/** The cockpit: diving into an agent from the map. The card grows from where it
 *  sits into the whole view while the map dims behind it; Esc shrinks it back
 *  into its card. Inside, everything about the agent has room: who and where it
 *  is with its controls along the top, then four tabs — the real conversation
 *  (the app's own chat, with its composer), the work (plan and timeline), the
 *  changes (diffs, commit and push), and how it is set up. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import type { Session } from "@/types/session";
import { AgentControls } from "./card-controls";
import { FileRows, PlanRows, Timeline, filesTouched, hasPending, logOf, money, planOf } from "./fleet-cards";
import { AgentFacts, AgentLead } from "./fleet-tools";
import { nodeState, type NodeState } from "./roots-layout";

type Tab = "chat" | "work" | "changes" | "setup";
const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Conversation" }, { id: "work", label: "Work" }, { id: "changes", label: "Changes" }, { id: "setup", label: "Settings" },
];
const EASE = "cubic-bezier(.2,.8,.2,1)";

/** The dive, as a camera move: the map zooms toward the card until the card fills the view, and the
 *  cockpit arrives out of it; on the way out the camera pulls back and the card settles into its place.
 *  The zoom's origin is the card's middle, its scale what makes the card fill the view. */
function diveInto(id: string, map: HTMLElement): { origin: string; scale: number } | null {
  const el = document.querySelector<HTMLElement>(`.fr-node[data-id="s:${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect(), m = map.getBoundingClientRect();
  if (!r.width || !r.height || !m.width) return null;
  const head = Math.min(r.height, 180);
  const scale = Math.max(1.6, Math.min(5, Math.min(m.width / r.width, m.height / head)));
  return { origin: `${r.left - m.left + r.width / 2}px ${r.top - m.top + head / 2}px`, scale };
}
const mapEl = () => document.querySelector<HTMLElement>(".fr-map");
/** the camera accelerating in, and easing out as it pulls back */
const DIVE_IN = "cubic-bezier(.55,0,.85,.25)", DIVE_OUT = "cubic-bezier(.15,.75,.25,1)";

export function FleetCockpit({ session, chat, onClose }: { session: Session; chat: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const closing = useRef(false);
  const cs = useChatStore(st => st.sessions[session.id]);
  const state: NodeState = nodeState(session.status, hasPending(cs), !!cs?.isStreaming);
  const log = logOf(cs);
  const todos = planOf(log);
  const files = filesTouched(log);
  const steps = log.filter(e => !/^todowrite$/i.test(e.name)).length;
  const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // the chat (heavy to mount) comes in once the opening has played, so nothing competes with its frames
  const [ready, setReady] = useState(reduce);

  // Fleet's composer stays where it is, on top of the cockpit
  useLayoutEffect(() => {
    const el = ref.current, comp = document.querySelector<HTMLElement>("[data-fleet-composer]"), parent = el?.offsetParent as HTMLElement | null;
    if (!el || !comp || !parent) return;
    // the cockpit runs the full height behind it, so nothing of the map shows around the composer; its pages leave that much room at the bottom
    const fit = () => { const pr = parent.getBoundingClientRect(), cr = comp.getBoundingClientRect(); el.style.setProperty("--ck-pad", `${Math.max(0, pr.bottom - cr.top)}px`); };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(comp); ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  // the dive in: the camera plunges toward the card; as the card fills the view the map gives way and
  // the cockpit comes forward into place. The chat mounts once it has arrived.
  const mapMove = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = ref.current, map = mapEl();
    if (!el || reduce) return;
    const d = map ? diveInto(session.id, map) : null;
    if (map && d) {
      map.style.transformOrigin = d.origin;
      mapMove.current = map.animate([
        { transform: "scale(1)", opacity: 1, offset: 0 },
        { transform: `scale(${d.scale * 0.55})`, opacity: 1, offset: 0.55 },
        { transform: `scale(${d.scale})`, opacity: 0, offset: 1 },
      ], { duration: 520, easing: DIVE_IN, fill: "forwards" });
    }
    const arrive = el.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: d ? 300 : 0, easing: EASE, fill: "backwards" });
    arrive.onfinish = () => setReady(true);
    // leaving some other way (the view changes): the map is put back as it was
    return () => { if (!closing.current) { mapMove.current?.cancel(); if (map) map.style.transformOrigin = ""; } };
  // only on the way in
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // another agent while inside (Tab, a number): the content changes in place, with a quick fade
  const firstId = useRef(session.id);
  useEffect(() => {
    if (session.id === firstId.current || reduce) return;
    inner.current?.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }, [session.id, reduce]);

  // the way out: the cockpit falls back and fades while the camera pulls out of the card, which lands where it was
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const el = ref.current, map = mapEl();
    map?.classList.remove("is-dived");
    if (!el || reduce) { mapMove.current?.cancel(); onClose(); return; }
    el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.92)" }], { duration: 240, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    // the card is measured with the zoom taken off, then the camera flies back from it
    mapMove.current?.cancel();
    const d = map ? diveInto(session.id, map) : null;
    let back: Animation | null = null;
    if (map && d) {
      map.style.transformOrigin = d.origin;
      back = map.animate([
        { transform: `scale(${d.scale})`, opacity: 0, offset: 0 },
        { transform: `scale(${d.scale * 0.5})`, opacity: 1, offset: 0.4 },
        { transform: "scale(1)", opacity: 1, offset: 1 },
      ], { duration: 560, delay: 60, easing: DIVE_OUT, fill: "backwards" });
    }
    const done = () => { if (map) map.style.transformOrigin = ""; onClose(); };
    if (back) back.onfinish = done; else window.setTimeout(done, 260);
  };
  const closeRef = useRef(close);
  useLayoutEffect(() => { closeRef.current = close; });

  // keys: Esc leaves a field first, then the cockpit (and never stops the agent); [ and ] change tabs.
  // Fleet's own keys (Tab, A, D, R, 1–9, ⌘K, …) keep working in here: the map handles them.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (closing.current) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable='true']");
      if (e.key === "Escape") {
        if (document.querySelector("[aria-modal='true']")) return;
        e.preventDefault(); e.stopPropagation();
        if (typing) { (t as HTMLElement).blur(); return; }
        closeRef.current();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "]" || e.key === "[") {
        e.preventDefault(); e.stopPropagation();
        setTab(cur => { const i = TABS.findIndex(x => x.id === cur); return TABS[(i + (e.key === "]" ? 1 : TABS.length - 1)) % TABS.length]!.id; });
      }
    };
    const surface = () => closeRef.current();
    window.addEventListener("keydown", key, true);
    window.addEventListener("fleet:surface", surface);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("fleet:surface", surface); };
  }, []);

  const count: Record<Tab, string> = {
    chat: "", work: todos.length ? `${todos.filter(t => t.status === "completed").length}/${todos.length}` : steps ? String(steps) : "",
    changes: files.length ? String(files.length) : "", setup: "",
  };
  const live = state === "working" || !!(cs?.streamingText || cs?.streamingThinking);
  return (
    <div ref={ref} className="fr-cockpit" data-fleet-panel role="region" aria-label={`${session.title || "Session"}, in full`}>
      <div className="fr-ck-shell" aria-hidden />
      <div ref={inner} className="fr-cockpit-in">
        {/* one bar, the height and type of the chat's own header: the way back, who, the tabs, what to do */}
        <header className="fr-ck-head">
          <button type="button" className="fr-ck-back" onClick={close} title="Back to the map (Esc)"><ArrowLeft size={14} /><span>Fleet</span></button>
          <i className="fr-ck-sep" />
          <AgentLead tool={session.tool} state={state} />
          <span className="fr-ck-title" title={session.title}>{session.title || "Session"}</span>
          <AgentFacts session={session} cs={cs} />
          <span className="fr-bar-gap" />
          <nav className="fr-viewswitch fr-ck-tabs" role="tablist" aria-label="Cockpit">
            {TABS.map(t => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "is-on" : undefined} onClick={() => setTab(t.id)} title={`${t.label} ([ ])`}>
                {t.label}{count[t.id] && <em>{count[t.id]}</em>}
              </button>
            ))}
          </nav>
          <span className="fr-bar-gap" />
          <AgentControls session={session} live={live} parts={["life"]} compact />
        </header>
        <div className="fr-ck-body">
          {/* the conversation stays mounted, so its scroll and draft survive a look at another tab */}
          <div className="fr-ck-chat" hidden={tab !== "chat"}>{ready ? chat : null}</div>
          {tab === "work" && (
            <div className="fr-ck-page">
              <PlanRows log={log} />
              <Timeline cs={cs} />
              {!todos.length && !steps && <p className="fr-ck-empty">No work yet.</p>}
            </div>
          )}
          {tab === "changes" && (
            <div className="fr-ck-page">
              <AgentControls session={session} live={live} parts={["git"]} />
              <FileRows log={log} />
              {!files.length && <p className="fr-ck-empty">No changes yet.</p>}
            </div>
          )}
          {tab === "setup" && (
            <div className="fr-ck-page">
              <AgentControls session={session} live={live} parts={["settings"]} />
              <p className="fr-ck-note">Spent {money(session.budget_used)} so far. Rename, reset or archive it from the ⋯ menu at the top.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
