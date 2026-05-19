/**
 * Pre-flight checks dialog.
 *
 * Surfaces structural blockers that would crash the Create PR happy
 * path BEFORE we fire it — nested git repos without commits, mid-
 * rebase state. Each issue has exactly one obvious fix, which the
 * user can apply with a single click. The dialog re-runs the
 * preflight after each fix so chained issues collapse to zero.
 *
 * This is deliberately small: detection is deterministic (fs +
 * `git status`), no agent involvement. Anything that needs the
 * agent's judgement (auth failures, push rejected, etc.) flows
 * through the RecoveryDialog *after* the dispatcher fails, not here.
 */
import { useEffect, useState } from "react";
import {
  Loader2, X, AlertTriangle, CheckCircle2, Wrench,
} from "lucide-react";
import { git, type PreflightIssue, type RecoveryRisk } from "@/lib/git-api";
import { glog } from "@/lib/git-log";

/** Flat coloured label for the risk tier — no border, no background,
 *  no uppercase. Sits inline beside the issue type so the row reads
 *  as a single line. */
function RiskLabel({ risk }: { risk: RecoveryRisk }) {
  const color = risk === "low" ? "#4ade80" : risk === "medium" ? "#fbbf24" : "#f87171";
  return (
    <span style={{ color, fontSize: 11, fontWeight: 500 }}>
      {risk} risk
    </span>
  );
}

/** Overall fix-in-flight state. Tracked at the dialog level (not
 *  per issue) since the bulk Fix button applies them in sequence. */
type BulkPhase = "idle" | "fixing" | "done" | "error";

export function PreflightDialog({
  folder, issues: initialIssues, onContinue, onCancel,
}: {
  folder: string;
  issues: PreflightIssue[];
  /** Called when the user clicks Continue — caller resumes the
   *  Create PR happy path with whatever state remains. */
  onContinue: () => void;
  /** Called when the user clicks Cancel — caller aborts Create PR. */
  onCancel: () => void;
}) {
  // Issues are read once from the prop at mount — the dialog
  // unmounts when the user clicks Continue / Cancel, so we never
  // need to react to prop changes mid-lifetime.
  const [issues] = useState<PreflightIssue[]>(initialIssues);
  const [phase, setPhase] = useState<BulkPhase>("idle");
  const [bulkError, setBulkError] = useState<string>("");
  const [progress, setProgress] = useState<{ done: number; total: number; current?: string }>({ done: 0, total: 0 });

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel]);

  // Sequentially fix every actionable issue, then run onContinue.
  // Sequential (not parallel) keeps the log trace + UI clear about
  // which fix failed if anything goes wrong, and avoids races on
  // .gitignore writes from multiple fixers at once.
  const fixAndContinue = async () => {
    const fixable = issues.filter(i => i.action !== "manual");
    if (fixable.length === 0) {
      // Only manual issues — nothing to do, just continue.
      onContinue();
      return;
    }
    glog("preflight", "bulk-fix.start", { count: fixable.length });
    setPhase("fixing");
    setBulkError("");
    setProgress({ done: 0, total: fixable.length });
    for (let i = 0; i < fixable.length; i++) {
      const issue = fixable[i];
      if (!issue) continue;  // unreachable — bounded loop — keeps TS narrowing happy
      setProgress({ done: i, total: fixable.length, current: issue.type });
      glog("preflight", "bulk-fix.step", { id: issue.id, action: issue.action, idx: i + 1, total: fixable.length });
      try {
        const r = await git.applyPreflightFix(folder, issue.action, issue.data);
        if (!r.ok) {
          glog("preflight", "bulk-fix.fail", { id: issue.id, error: r.error });
          setBulkError(`Failed at "${issue.type}": ${r.error}`);
          setPhase("error");
          return;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        glog("preflight", "bulk-fix.throw", { id: issue.id, error: msg });
        setBulkError(`Failed at "${issue.type}": ${msg}`);
        setPhase("error");
        return;
      }
    }
    glog("preflight", "bulk-fix.done", { count: fixable.length });
    setProgress({ done: fixable.length, total: fixable.length });
    setPhase("done");
    // Hand off to the Create PR happy path. The PreflightDialog
    // unmounts from BranchStrip's onContinue (sets preflight=null),
    // so no need to clear local state here.
    onContinue();
  };

  const allClear = issues.length === 0;
  const fixableCount = issues.filter(i => i.action !== "manual").length;
  const onlyManual = issues.length > 0 && fixableCount === 0;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 200,
        animation: "fleet-fade 0.12s ease-out",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Pre-flight checks"
        style={{
          width: "min(640px, 92vw)",
          maxHeight: "82vh",
          display: "flex", flexDirection: "column",
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 10,
          boxShadow: "0 18px 48px rgba(0,0,0,0.50)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "11px 14px",
          borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.07))",
        }}>
          <AlertTriangle size={14} strokeWidth={1.85} style={{ color: "#fbbf24" }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)", flex: 1 }}>
            Pre-flight checks · {allClear ? "all clear" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`}
          </div>
          <button
            onClick={onCancel}
            aria-label="Close dialog"
            style={{
              padding: 4, marginLeft: 4,
              background: "transparent", border: "none", outline: "none",
              color: "var(--c-low)", cursor: "pointer", borderRadius: 5,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.08)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div style={{
          flex: 1, minHeight: 160,
          padding: "10px 14px",
          overflowY: "auto",
        }}>
          {allClear && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, color: "#4ade80", fontSize: 13, padding: "8px 2px" }}>
              <CheckCircle2 size={14} strokeWidth={2} />
              No blockers found. Continue to Create PR?
            </div>
          )}

          {issues.map((issue) => {
            const isManual = issue.action === "manual";
            return (
              <div
                key={issue.id}
                style={{
                  padding: "10px 12px",
                  marginBottom: 8,
                  background: "rgba(var(--fg-rgb), 0.03)",
                  border: "1px solid rgba(var(--fg-rgb), 0.08)",
                  borderRadius: 7,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{
                    fontSize: 10.5, fontWeight: 600,
                    color: "var(--c-med)", letterSpacing: 0.3, textTransform: "uppercase",
                    fontFamily: "var(--font-mono)",
                  }}>
                    {issue.type}
                  </span>
                  <RiskLabel risk={issue.risk} />
                  {isManual && (
                    <span style={{ fontSize: 11, color: "var(--c-dim)", fontStyle: "italic" }}>
                      manual fix only
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "var(--c-high)", lineHeight: 1.5, marginBottom: 6 }}>
                  {issue.description}
                </div>
                <div style={{
                  padding: "5px 8px",
                  background: "rgba(var(--fg-rgb), 0.04)",
                  border: "1px solid rgba(var(--fg-rgb), 0.06)",
                  borderRadius: 5,
                  fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--c-med)",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>
                  {issue.command}
                </div>
              </div>
            );
          })}

          {phase === "error" && bulkError && (
            <div style={{
              padding: "8px 10px",
              background: "rgba(248,113,113,0.06)",
              border: "1px solid rgba(248,113,113,0.18)",
              borderRadius: 6,
              color: "#f87171", fontSize: 12,
              marginTop: 4,
            }}>
              {bulkError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8,
          padding: "10px 14px",
          borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.07))",
        }}>
          <button
            onClick={() => { glog("preflight", "cancel", {}); onCancel(); }}
            disabled={phase === "fixing"}
            style={{
              padding: "6px 12px",
              background: "transparent",
              border: "1px solid rgba(var(--fg-rgb), 0.10)",
              borderRadius: 6,
              color: "var(--c-med)", fontSize: 12, fontWeight: 500,
              cursor: phase === "fixing" ? "default" : "pointer",
              opacity: phase === "fixing" ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>

          {/* "Continue anyway" — skip the fixes and let the dispatcher
              try its luck. Useful when the user knows what they're
              doing and wants the recovery dialog instead. Hidden in
              the all-clear state (the Continue button to the right
              covers it). */}
          {!allClear && (
            <button
              onClick={() => { glog("preflight", "continue-anyway", { remaining: issues.length }); onContinue(); }}
              disabled={phase === "fixing"}
              style={{
                padding: "6px 12px",
                background: "transparent",
                border: "1px solid rgba(var(--fg-rgb), 0.10)",
                borderRadius: 6,
                color: "var(--c-med)", fontSize: 12, fontWeight: 500,
                cursor: phase === "fixing" ? "default" : "pointer",
                opacity: phase === "fixing" ? 0.5 : 1,
                fontFamily: "inherit",
              }}
              title="Skip the fixes — the dispatcher's recovery dialog will catch anything that's still blocking."
            >
              Continue anyway
            </button>
          )}

          {/* Primary affordance: Fix and Continue (or just Continue in
              the all-clear state). Single bulk button — applies every
              actionable issue in order, then hands off to the Create
              PR happy path. Hidden when ONLY manual issues remain
              (nothing to auto-fix). */}
          {allClear ? (
            <button
              onClick={() => { glog("preflight", "continue", { remaining: 0 }); onContinue(); }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px",
                background: "rgba(74,222,128,0.10)",
                border: "1px solid rgba(74,222,128,0.22)",
                borderRadius: 6,
                color: "var(--c-high)", fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              <CheckCircle2 size={11} strokeWidth={2} /> Continue
            </button>
          ) : !onlyManual ? (
            <button
              onClick={fixAndContinue}
              disabled={phase === "fixing"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px",
                background: "rgba(var(--fg-rgb), 0.08)",
                border: "1px solid rgba(var(--fg-rgb), 0.12)",
                borderRadius: 6,
                color: "var(--c-high)", fontSize: 12, fontWeight: 600,
                cursor: phase === "fixing" ? "default" : "pointer",
                fontFamily: "inherit",
                opacity: phase === "fixing" ? 0.85 : 1,
              }}
              title={`Apply ${fixableCount} fix${fixableCount === 1 ? "" : "es"} in sequence, then continue to Create PR.`}
            >
              {phase === "fixing"
                ? <><Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /> Fixing {progress.done + 1}/{progress.total}…</>
                : <><Wrench size={11} strokeWidth={2} /> Fix and Continue</>}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
