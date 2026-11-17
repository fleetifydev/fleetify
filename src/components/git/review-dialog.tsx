/**
 * Review dialog.
 *
 * Mirrors Conductor's "Review action" — the user clicks Review on the
 * BranchStrip, the dialog opens, and the session's CLI (claude / codex
 * / gemini) is asked to inspect the current diff. The dialog displays
 * the resulting markdown review so the user can spot issues BEFORE
 * opening a pull request.
 *
 * Deliberately small surface area: read-only review output, with a
 * Retry button when generation fails and a Copy button when it
 * succeeds. Inline-comment threads + per-line discussion are deferred
 * to the Diff Viewer (future work).
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, RefreshCw, X, ScanEye, Copy, Check } from "lucide-react";
import { git } from "@/lib/git-api";
import { glog } from "@/lib/git-log";

type Phase = "loading" | "ready" | "error";

export function ReviewDialog({
  folder, baseBranch, tool, onClose,
}: {
  folder: string;
  baseBranch: string;
  /** Active session's CLI string — drives which binary we ask. */
  tool?: string | null;
  onClose: () => void;
}) {
  const [phase,   setPhase]   = useState<Phase>("loading");
  const [review,  setReview]  = useState<string>("");
  const [error,   setError]   = useState<string>("");
  const [cli,     setCli]     = useState<string | null>(null);
  const [copied,  setCopied]  = useState(false);

  // Kick off the review on mount. setState calls are inside the async
  // resolver, not the effect body, so `react-hooks/set-state-in-effect`
  // stays happy. The cleanup flag makes a re-mount during an in-flight
  // request a no-op rather than racing.
  useEffect(() => {
    let cancelled = false;
    glog("review", "mount", { folder, baseBranch, tool: tool || null });
    git.reviewDiff(folder, baseBranch, tool ?? undefined)
      .then(r => {
        if (cancelled) return;
        if (r.ok) {
          glog("review", "ready", { cli: r.cli, reviewLen: r.review.length });
          setReview(r.review);
          setCli(r.cli ?? null);
          setPhase("ready");
        } else {
          glog("review", "error", { error: r.error });
          setError(r.error || "Review failed.");
          setPhase("error");
        }
      })
      .catch(e => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        glog("review", "throw", { error: msg });
        setError(msg);
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, [folder, baseBranch, tool]);

  // Retry is an event handler (button click) so the inline setState
  // calls are fine here — the eslint rule only flags effect bodies.
  const retry = () => {
    glog("review", "retry", {});
    setPhase("loading");
    setError("");
    git.reviewDiff(folder, baseBranch, tool ?? undefined)
      .then(r => {
        if (r.ok) {
          glog("review", "ready", { cli: r.cli, reviewLen: r.review.length });
          setReview(r.review); setCli(r.cli ?? null); setPhase("ready");
        } else {
          glog("review", "error", { error: r.error });
          setError(r.error || "Review failed."); setPhase("error");
        }
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        glog("review", "throw", { error: msg });
        setError(msg); setPhase("error");
      });
  };

  // ESC closes the dialog. Matches the Create PR dialog's affordance.
  // preventDefault marks the key handled, so Escape-to-stop on the chat
  // underneath leaves it alone.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const copy = () => {
    navigator.clipboard.writeText(review).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const cliLabel = (cli || tool || "agent").toString();

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
        aria-label="Code review"
        style={{
          width: "min(720px, 92vw)",
          maxHeight: "82vh",
          display: "flex", flexDirection: "column",
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 10,
          boxShadow: "0 18px 48px rgba(0,0,0,0.50)",
          overflow: "hidden",
        }}
      >
        {/* Header — title + close. ScanEye reads as "agent inspecting"
            without being as loud as a Sparkles wand. */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "11px 14px",
          borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.07))",
        }}>
          <ScanEye size={14} strokeWidth={1.85} style={{ color: "var(--c-med)" }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)", flex: 1 }}>
            Code review
          </div>
          <div style={{ fontSize: 11, color: "var(--c-low)", fontFamily: "var(--font-mono)" }}>
            base: {baseBranch}
            {cli ? <> · {cliLabel}</> : null}
          </div>
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

        {/* Body — markdown review, scrollable. */}
        <div style={{
          flex: 1, minHeight: 200,
          padding: "12px 16px",
          overflowY: "auto",
          fontSize: 13.5, lineHeight: 1.55,
          color: "var(--c-high)",
        }}>
          {phase === "loading" && (
            <div style={{
              display: "flex", alignItems: "center", gap: 9,
              color: "var(--c-low)", fontSize: 13,
            }}>
              <Loader2 size={13} style={{ animation: "spin 1.2s linear infinite" }} />
              Reviewing with {cliLabel}…
            </div>
          )}
          {phase === "error" && (
            <div style={{ color: "var(--c-med)", fontSize: 13 }}>
              <div style={{ marginBottom: 8 }}>{error}</div>
              <button
                onClick={retry}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 10px",
                  background: "rgba(var(--fg-rgb), 0.06)",
                  border: "1px solid rgba(var(--fg-rgb), 0.10)",
                  borderRadius: 6,
                  color: "var(--c-high)", fontSize: 12, fontWeight: 500,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                <RefreshCw size={11} strokeWidth={1.85} />
                Retry
              </button>
            </div>
          )}
          {phase === "ready" && (
            <div className="review-md" style={{ fontFamily: "inherit" }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{review}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Footer — Copy + Close. Only shown in ready / error states
            so the loading view stays uncluttered. */}
        {phase !== "loading" && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.07))",
          }}>
            {phase === "ready" && (
              <button
                onClick={copy}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 10px",
                  background: "transparent",
                  border: "1px solid rgba(var(--fg-rgb), 0.10)",
                  borderRadius: 6,
                  color: "var(--c-med)", fontSize: 12, fontWeight: 500,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                {copied
                  ? <><Check size={11} strokeWidth={2.2} /> Copied</>
                  : <><Copy size={11} strokeWidth={1.85} /> Copy markdown</>}
              </button>
            )}
            <button
              onClick={retry}
              title="Re-run review"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 10px",
                background: "transparent",
                border: "1px solid rgba(var(--fg-rgb), 0.10)",
                borderRadius: 6,
                color: "var(--c-med)", fontSize: 12, fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              <RefreshCw size={11} strokeWidth={1.85} />
              Re-run
            </button>
            <button
              onClick={onClose}
              style={{
                padding: "5px 12px",
                background: "rgba(var(--fg-rgb), 0.08)",
                border: "1px solid rgba(var(--fg-rgb), 0.10)",
                borderRadius: 6,
                color: "var(--c-high)", fontSize: 12, fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
