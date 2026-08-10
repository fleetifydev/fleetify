import { LogoMark } from "@/components/brand/logo-mark";
import { useChatStore } from "@/stores/chat-store";

/** Inline container-provisioning status.
 *
 *  A `docker-run` session builds its container on the first turn, and a cold
 *  `docker pull` can run for minutes. Doing that silently made the user's
 *  first message look like a hang — there was no way to tell "downloading a
 *  600MB image" from "stuck". This says which step is running, and how far
 *  the pull has got.
 *
 *  Same treatment as the compaction pill and the live "Thinking…" row: a
 *  glowing Fleetify mark plus a shimmer label, no box and no border. Only the
 *  running state renders — completion just removes it, and failures are
 *  cleared and surfaced through the shared <ChatError> like every other
 *  in-chat error, so there is no success or failure state to draw here.
 */
export function ContainerSetupPill({ sessionId }: { sessionId: string }) {
  const setup = useChatStore(s => s.sessions[sessionId]?.containerSetup ?? null);

  if (!setup) return null;

  // No elapsed counter: the shimmering label already says "working", and a
  // ticking clock would mean reading Date.now() during render.
  // Only the pull reports a fraction; start/verify are single beats.
  const pct = setup.step === "pull" && setup.pct != null
    ? Math.round(Math.min(1, Math.max(0, setup.pct)) * 100)
    : null;

  return (
    <div className="fade-in" style={{ margin: "8px 0", maxWidth: 640 }}>
      <div role="status" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <LogoMark size={13} glow style={{ flexShrink: 0, color: "var(--c-high)" }} />
        <span
          className="thinking-shimmer-text"
          data-label={setup.detail}
          style={{
            fontSize: 12, fontWeight: 500,
            fontFamily: "var(--font-sans)", letterSpacing: "-0.01em",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {setup.detail}
        </span>
        {pct != null && (
          <>
            <span
              aria-hidden
              style={{
                flexShrink: 0, width: 64, height: 3, borderRadius: 2,
                background: "rgba(var(--fg-rgb),0.10)", overflow: "hidden",
              }}
            >
              <span style={{
                display: "block", height: "100%", width: `${pct}%`,
                background: "var(--c-high)", transition: "width 0.3s ease",
              }} />
            </span>
            <span style={{ fontSize: 9.5, color: "var(--c-ghost)", opacity: 0.6, flexShrink: 0 }}>
              {pct}%
            </span>
          </>
        )}
      </div>
    </div>
  );
}
