/**
 * Recovery dialog.
 *
 * Opens when Create PR fails with a recoverable git/gh error. The
 * session's CLI is asked for a structured diagnosis + a recovery
 * action drawn from a whitelist (pull-rebase, force-with-lease,
 * set-upstream, manual). The user explicitly approves the action;
 * the app — NOT the agent — runs the corresponding command. This
 * mirrors Aider's split: "AI generates strings, app runs the shell."
 *
 * Phases:
 *   diagnosing  → "Asking <cli> for diagnosis…"
 *   ready       → diagnosis + Apply (or Close-only for manual)
 *   applying    → "Running <action>…"
 *   recovered   → "Done. Retry Create PR?"
 *   failed      → recovery itself errored; show message + Close
 */
import { useEffect, useState } from "react";
import { claimEscape } from "@/hooks/use-escape-to-stop";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownLinkComponents } from "@/components/markdown-link";
import {
  Loader2, X, AlertTriangle, ShieldCheck, ShieldAlert, ShieldX,
  RefreshCw, ChevronRight, CheckCircle2,
} from "lucide-react";
import { git, type RecoveryAction, type RecoveryRisk } from "@/lib/git-api";
import { glog } from "@/lib/git-log";

type Phase = "diagnosing" | "ready" | "applying" | "recovered" | "failed";

interface Diagnosis {
  summary: string;
  action: RecoveryAction;
  rationale: string;
  command: string | null;
  risk: RecoveryRisk;
  cli?: string;
}

const ACTION_LABEL: Record<RecoveryAction, string> = {
  "pull-rebase":      "Pull (rebase) and retry",
  "force-with-lease": "Force-push (with lease)",
  "set-upstream":     "Set upstream and push",
  "custom-command":   "Run command",
  "manual":           "Manual recovery",
};

function RiskBadge({ risk }: { risk: RecoveryRisk }) {
  const palette = risk === "low"
    ? { bg: "rgba(74,222,128,0.10)", fg: "#4ade80", icon: <ShieldCheck size={11} strokeWidth={2} /> }
    : risk === "medium"
      ? { bg: "rgba(250,204,21,0.10)", fg: "#fbbf24", icon: <ShieldAlert size={11} strokeWidth={2} /> }
      : { bg: "rgba(248,113,113,0.12)", fg: "#f87171", icon: <ShieldX size={11} strokeWidth={2} /> };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 7px", borderRadius: 4,
      background: palette.bg, color: palette.fg,
      fontSize: 10.5, fontWeight: 600, letterSpacing: 0.2, textTransform: "uppercase",
    }}>
      {palette.icon} {risk} risk
    </span>
  );
}

export function RecoveryDialog({
  folder, baseBranch, tool, errorMessage, context, onClose, onRetry,
}: {
  folder: string;
  baseBranch: string;
  tool?: string | null;
  /** The original error returned by `git.createPR`. */
  errorMessage: string;
  /** Short label for what the user was trying to do — e.g. "Create PR".
   *  Forwarded to the agent so its diagnosis lands in context. */
  context?: string;
  onClose: () => void;
  /** Called when the user clicks Retry after a successful recovery.
   *  The caller (BranchStrip) re-fires the original Create PR call
   *  with the same opts. The dialog closes itself first. */
  onRetry: () => void;
}) {
  const [phase,     setPhase]     = useState<Phase>("diagnosing");
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [diagError, setDiagError] = useState<string>("");
  const [applyOut,  setApplyOut]  = useState<string>("");
  const [applyErr,  setApplyErr]  = useState<string>("");

  // Kick off diagnosis on mount. setState happens inside the async
  // resolver so `react-hooks/set-state-in-effect` stays quiet.
  useEffect(() => {
    let cancelled = false;
    glog("recovery", "mount", { folder, baseBranch, tool: tool || null, errorPreview: errorMessage.slice(0, 120) });
    git.diagnoseFailure(folder, errorMessage, tool ?? undefined, context, baseBranch)
      .then(r => {
        if (cancelled) return;
        if (r.ok) {
          glog("recovery", "diagnosis-ready", { cli: r.cli, action: r.action, risk: r.risk });
          setDiagnosis({
            summary: r.summary,
            action: r.action,
            rationale: r.rationale,
            command: r.command,
            risk: r.risk,
            cli: r.cli,
          });
          setPhase("ready");
        } else {
          glog("recovery", "diagnosis-failed", { error: r.error });
          setDiagError(r.error || "Diagnosis failed.");
          setPhase("failed");
        }
      })
      .catch(e => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        glog("recovery", "diagnosis-throw", { error: msg });
        setDiagError(msg);
        setPhase("failed");
      });
    return () => { cancelled = true; };
  }, [folder, errorMessage, tool, context, baseBranch]);

  useEffect(() => {
    // Claim the key, so the chat underneath neither stops its stream nor
    // answers a pending permission card with it.
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { claimEscape(e); onClose(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const apply = () => {
    if (!diagnosis || diagnosis.action === "manual") return;
    glog("recovery", "apply.start", { action: diagnosis.action, baseBranch, customCmd: diagnosis.action === "custom-command" ? diagnosis.command : undefined });
    setPhase("applying");
    setApplyErr("");
    // For custom-command, the EXACT command string the user just
    // saw + approved is the contract — pass it through. Whitelisted
    // verbs ignore the command arg (main process maps the verb to a
    // fixed argv array).
    const cmdArg = diagnosis.action === "custom-command" ? (diagnosis.command || "") : undefined;
    git.applyRecovery(folder, diagnosis.action, baseBranch, cmdArg)
      .then(r => {
        if (r.ok) {
          glog("recovery", "apply.ok", { action: diagnosis.action, outputLen: (r.output || "").length });
          setApplyOut(r.output || "");
          setPhase("recovered");
        } else {
          glog("recovery", "apply.fail", { action: diagnosis.action, error: r.error });
          setApplyErr(r.error || "Recovery failed.");
          setPhase("failed");
        }
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        glog("recovery", "apply.throw", { error: msg });
        setApplyErr(msg);
        setPhase("failed");
      });
  };

  const cliLabel = (diagnosis?.cli || tool || "agent").toString();

  return (
    <div
      onClick={onClose}
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
        aria-modal="true"
        aria-label="Recovery"
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
            {context || "Create PR"} failed
          </div>
          {diagnosis && phase !== "diagnosing" && <RiskBadge risk={diagnosis.risk} />}
          <button
            onClick={onClose}
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
          flex: 1, minHeight: 180,
          padding: "12px 16px",
          overflowY: "auto",
          fontSize: 13, lineHeight: 1.55,
          color: "var(--c-high)",
        }}>
          {/* Original error block (always visible) */}
          <div style={{
            marginBottom: 12,
            padding: "8px 10px",
            background: "rgba(248,113,113,0.06)",
            border: "1px solid rgba(248,113,113,0.18)",
            borderRadius: 6,
            color: "var(--c-med)", fontSize: 12,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            maxHeight: 110, overflow: "auto",
          }}>
            {errorMessage}
          </div>

          {phase === "diagnosing" && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--c-low)" }}>
              <Loader2 size={13} style={{ animation: "spin 1.2s linear infinite" }} />
              Asking {cliLabel} for a diagnosis…
            </div>
          )}

          {phase === "ready" && diagnosis && (
            <>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "var(--c-dim)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>
                  Diagnosis · {cliLabel}
                </div>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>{diagnosis.summary}</ReactMarkdown>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "var(--c-dim)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>
                  Suggested action
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600,
                    color: "var(--c-high)",
                    padding: "2px 7px", borderRadius: 4,
                    background: "rgba(var(--fg-rgb), 0.06)",
                  }}>
                    {ACTION_LABEL[diagnosis.action]}
                  </span>
                </div>
                {diagnosis.command && (
                  <div style={{
                    padding: "6px 9px",
                    background: "rgba(var(--fg-rgb), 0.04)",
                    border: "1px solid rgba(var(--fg-rgb), 0.08)",
                    borderRadius: 5,
                    fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--c-med)",
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}>
                    {diagnosis.command}
                  </div>
                )}
                {diagnosis.rationale && (
                  <div style={{ marginTop: 8, color: "var(--c-med)", fontSize: 12.5 }}>
                    {diagnosis.rationale}
                  </div>
                )}
              </div>
            </>
          )}

          {phase === "applying" && diagnosis && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--c-low)" }}>
              <Loader2 size={13} style={{ animation: "spin 1.2s linear infinite" }} />
              Running {ACTION_LABEL[diagnosis.action].toLowerCase()}…
            </div>
          )}

          {phase === "recovered" && diagnosis && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 9, color: "#4ade80", marginBottom: 8 }}>
                <CheckCircle2 size={14} strokeWidth={2} />
                <span style={{ fontWeight: 600 }}>{ACTION_LABEL[diagnosis.action]} applied.</span>
              </div>
              {applyOut && (
                <pre style={{
                  margin: 0, padding: "8px 10px",
                  background: "rgba(var(--fg-rgb), 0.04)",
                  border: "1px solid rgba(var(--fg-rgb), 0.06)",
                  borderRadius: 5,
                  fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--c-med)",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  maxHeight: 160, overflow: "auto",
                }}>{applyOut}</pre>
              )}
            </>
          )}

          {phase === "failed" && (
            <div style={{ color: "var(--c-med)", fontSize: 13 }}>
              {applyErr || diagError || "Something went wrong."}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8,
          padding: "10px 14px",
          borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.07))",
        }}>
          {phase === "ready" && diagnosis && diagnosis.action !== "manual" && (
            <button
              onClick={apply}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px",
                background: "rgba(var(--fg-rgb), 0.08)",
                border: "1px solid rgba(var(--fg-rgb), 0.12)",
                borderRadius: 6,
                color: "var(--c-high)", fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              <ChevronRight size={11} strokeWidth={2} />
              Apply: {ACTION_LABEL[diagnosis.action]}
            </button>
          )}
          {phase === "recovered" && (
            <button
              onClick={() => { glog("recovery", "retry-create-pr", {}); onClose(); onRetry(); }}
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
              <RefreshCw size={11} strokeWidth={2} />
              Retry Create PR
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              padding: "6px 12px",
              background: "transparent",
              border: "1px solid rgba(var(--fg-rgb), 0.10)",
              borderRadius: 6,
              color: "var(--c-med)", fontSize: 12, fontWeight: 500,
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
