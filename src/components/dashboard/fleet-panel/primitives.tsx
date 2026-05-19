/**
 * Minimal primitives for the right panel.
 *
 * Just three things: a status dot (one circle, one accent), a context
 * rail (thin horizontal bar), and a small set of formatters. No chips,
 * no tiles, no tabs — the panel itself owns its layout, these are
 * just shared atoms.
 */
/** A single 8px disc. Running spins. Waiting blinks. Idle is hollow. */
export function StatusDot({ status }: { status: string }) {
  const size = 8;

  if (status === "running" || status === "starting") {
    // ── Working dots ──
    // Three dots fading in sequence, bare. The conic-spinner read as
    // "loading something specific"; agents thinking aren't loading.
    // Bare dots (no pill chip) keep the indicator inline — it sits
    // next to the agent title as a status, not a separate tag.
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        height: size, gap: 2.5, flexShrink: 0,
      }}>
        <style>{`@keyframes sd-wdots { 0%,80%,100%{opacity:0.25;transform:translateY(0)} 40%{opacity:1;transform:translateY(-0.5px)} }`}</style>
        {[0, 1, 2].map(i => (
          <span key={i} aria-hidden style={{
            display: "block",
            width: 2.5, height: 2.5, borderRadius: "50%",
            background: "var(--c-med)",
            animation: `sd-wdots 1.2s ease-in-out infinite`,
            animationDelay: `${i * 0.18}s`,
          }} />
        ))}
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <span aria-hidden style={{
        display: "inline-block",
        width: size, height: size, borderRadius: "50%", flexShrink: 0,
        background: "#fb923c",
        animation: "fp-pulse 1.6s ease-in-out infinite",
      }} />
    );
  }
  if (status === "error") {
    return (
      <span aria-hidden style={{
        display: "inline-block",
        width: size, height: size, borderRadius: "50%", flexShrink: 0,
        background: "#f87171",
      }} />
    );
  }
  // Idle — small subtle hollow ring.
  return (
    <span aria-hidden style={{
      display: "inline-block",
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      border: "1px solid var(--c-ghost)",
      boxSizing: "border-box",
    }} />
  );
}

/** Thin context-window fill. 3px tall. Color crosses thresholds. */
export function ContextRail({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(1, used / limit);
  const color =
      pct > 0.85 ? "#f87171"
    : pct > 0.65 ? "#fbbf24"
    :              "var(--c-low)";
  return (
    <span style={{
      display: "block",
      height: 3, borderRadius: 2,
      background: "var(--c-srf)", overflow: "hidden",
    }}>
      <span style={{
        display: "block",
        width: `${pct * 100}%`, height: "100%",
        background: color, transition: "width 0.5s ease-out",
      }} />
    </span>
  );
}

/** Inline middot separator for meta lines. */
export function Sep() {
  return (
    <span aria-hidden style={{
      color: "var(--c-brd2)", fontSize: 9, lineHeight: 1,
      flexShrink: 0,
    }}>
      ·
    </span>
  );
}

export function relativeTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff)) return "";
  const s = Math.floor(diff / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function fmtCost(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(3)}`;
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Inject keyframes used here. */
export function FleetStyles() {
  return (
    <style>{`
      @keyframes fp-pulse {
        0%, 100% { opacity: 0.55; transform: scale(0.85); }
        50%      { opacity: 1; transform: scale(1.15); }
      }
      @keyframes fp-fade-in {
        from { opacity: 0; transform: translateY(2px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .fp-card { transition: background 0.15s; }
      .fp-card:hover { background: var(--c-srf); }
    `}</style>
  );
}
