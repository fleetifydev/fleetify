/**
 * PR creation dialog.
 *
 * On open the title + body are drafted by whichever CLI the active
 * session uses (claude / codex / gemini) so the user lands on a
 * realistic first draft instead of a blank form. Falls back to
 * branch-name + diff-summary heuristics when the CLI is unavailable.
 *
 * Submit pushes the branch and runs `gh pr create`. Done view shows
 * the new PR URL with an "Open in GitHub" affordance.
 */
import { useEffect, useRef, useState } from "react";
import { X, GitPullRequest, Loader2, ExternalLink, Check, Sparkles } from "lucide-react";
import { git, defaultPRTitle } from "@/lib/git-api";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { github, type GitHubLinkPayload } from "@/lib/github-link-api";

type Phase = "compose" | "creating" | "done" | "error";

export function PRDialog({
  folder, branch, baseBranch, tool, featureBranch, initialDraft, onClose, onCreated,
}: {
  folder: string;
  branch: string;
  baseBranch: string;
  /** Active session's provider — drives which CLI we ask for the draft. */
  tool?: string | null;
  /** Branch the backend must CARVE before committing, for a session whose
   *  HEAD is still the default branch (its `fleet/…` branch is only planned
   *  until the first PR). Without it `create_pr_via_gh` commits onto the
   *  current branch and pushes `HEAD -> main` — i.e. the dialog lands the
   *  agent's work straight on the user's default branch. Undefined on a
   *  session already sitting on its feature branch. */
  featureBranch?: string;
  /** Pre-tick the "Open as draft" checkbox (used when opened from
   *  the "Create draft PR" menu item). */
  initialDraft?: boolean;
  onClose: () => void;
  onCreated?: (pr: { number: number | null; url: string }) => void;
}) {
  const [title,   setTitle]   = useState("");
  const [body,    setBody]    = useState("");
  const [draft,   setDraft]   = useState(!!initialDraft);
  const [phase,   setPhase]   = useState<Phase>("compose");
  const [error,   setError]   = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [result,  setResult]  = useState<{ number: number | null; url: string } | null>(null);
  const [genField, setGenField] = useState<"title" | "body" | null>(null);
  const [genErr, setGenErr] = useState<{ title?: string; body?: string }>({});
  const [aiTitleUsed, setAiTitleUsed] = useState(false);
  const [aiBodyUsed, setAiBodyUsed] = useState(false);
  // Probe gh availability AND any stored GitHub link at open time so
  // we know which auth path to dispatch through at submit. authReady
  // gates the submit button while both probes are in flight.
  const [ghAuthed,    setGhAuthed]    = useState<boolean | null>(null);
  const [ghLogin,     setGhLogin]     = useState<string | null>(null);
  const [link,        setLink]        = useState<GitHubLinkPayload | null>(null);
  const [authReady,   setAuthReady]   = useState(false);
  const [connecting,  setConnecting]  = useState(false);
  const [browserFallbackUrl, setBrowserFallbackUrl] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // Liveness guard for async setters that resolve after the dialog may
  // have unmounted — mirrors the `cancelled` flag the mount effect uses.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([git.hasGhCli(), github.getLink()])
      .then(([gh, lk]) => {
        if (cancelled) return;
        setGhAuthed(!!gh.authed);
        setGhLogin(gh.ghLogin ?? null);
        setLink(lk.link);
        setAuthReady(true);

        // Auto-redirect to the GitHub App OAuth flow when neither auth
        // path is available. Without `gh` installed, the App is the only
        // way through — making the user discover the "Connect GitHub"
        // button is friction we can skip. The existing ConnectGitHubBlock
        // stays mounted in its `connecting` state so the user sees that
        // a browser tab was opened on their behalf and can retry if they
        // dismiss it.
        if (!gh.authed && !lk.link) {
          setConnecting(true);
          github.beginOAuth()
            .then(r => {
              if (cancelled) return;
              setConnecting(false);
              if (r.ok) {
                setLink(r.link);
              } else {
                setError(`Couldn't connect: ${r.error || r.code}`);
              }
            })
            .catch(() => {
              if (cancelled) return;
              setConnecting(false);
            });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setGhAuthed(false); setGhLogin(null);
        setLink(null); setAuthReady(true);
      });

    const off = github.onLinkChanged(({ link: next }) => {
      if (!cancelled) setLink(next);
    });
    const offFallback = github.onBrowserFallback(({ url }) => {
      if (!cancelled) setBrowserFallbackUrl(url);
    });
    return () => { cancelled = true; off(); offFallback(); };
  }, []);

  const authMethod: "gh" | "link" | "none" =
    ghAuthed ? "gh" :
    link     ? "link" :
               "none";

  // ── Initial seed on mount ──
  // Title from the branch name (cheap local heuristic — NOT the AI).
  // Body stays empty. AI generation is strictly on-demand per field
  // via the GenerateHint buttons below.
  useEffect(() => {
    setTitle(defaultPRTitle(branch));
    setTimeout(() => titleRef.current?.focus(), 50);
  }, [branch]);

  // One generation at a time. Both fields share the same backend call
  // (generatePRSummary returns {title, body}); we apply only the half
  // the user asked for — no backend change needed.
  const generateField = async (field: "title" | "body") => {
    if (genField) return;
    setGenField(field);
    setGenErr(e => ({ ...e, [field]: undefined }));
    const ai = await git.generatePRSummary(folder, baseBranch, tool ?? undefined);
    if (!aliveRef.current) return;
    if (ai.ok) {
      if (field === "title") { setTitle(ai.title); setAiTitleUsed(true); }
      else { setBody(ai.body); setAiBodyUsed(true); }
    } else {
      setGenErr(e => ({ ...e, [field]: ai.error || "Generation failed" }));
    }
    setGenField(null);
  };

  // Esc closes; ⌘↵ submits — both no-op while a network call is in flight.
  // genField !== null means a per-field AI generation is running; ⌘↵ must
  // not slip past the disabled Create button while it's in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "creating") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && phase === "compose") {
        e.preventDefault();
        if (title.trim() && authReady && authMethod !== "none" && !genField) submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, onClose, title, authReady, authMethod, genField]);

  // GitHub's documented PR body cap is ~65,536 chars. We pre-truncate
  // at 65,000 with a "[…body truncated]" marker so the user sees what
  // landed instead of getting a 422 VALIDATION from GitHub.
  const PR_BODY_MAX = 65_000;
  const bodyTooLong = body.length > PR_BODY_MAX;

  const submit = async () => {
    if (!title.trim() || phase === "creating") return;
    // Belt-and-braces: never submit mid-generation even if a caller
    // (e.g. a stale keydown handler) slips past the guards above.
    if (genField) return;
    setPhase("creating"); setError(null); setErrorCode(null);
    const trimmedBody = body.length > PR_BODY_MAX
      ? `${body.slice(0, PR_BODY_MAX)}\n\n[…body truncated — GitHub's limit is ~65k chars]`
      : body;
    const r = await git.createPR(folder, {
      title: title.trim(), body: trimmedBody, base: baseBranch, draft,
      // Only sent for a bootstrap-shape session; omitted otherwise so a
      // session already on its feature branch keeps committing there.
      ...(featureBranch ? { featureBranch } : {}),
    });
    if (!r.ok) {
      setError(r.error);
      setErrorCode(r.code ?? null);
      setPhase("error");
      return;
    }
    const out = { number: r.prNumber, url: r.prUrl };
    setResult(out);
    setPhase("done");
    onCreated?.(out);
  };

  const open = () => { if (result?.url) git.openPR(folder, result.number ?? undefined); };

  const creating   = phase === "creating";
  const generating = genField !== null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
        animation: "fade-in 0.12s ease-out both",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 600, maxWidth: "100%", maxHeight: "88vh",
          display: "flex", flexDirection: "column",
          // Theme-aware surface — was hardcoded #141414, which
          // showed up as a black card over white chrome in light
          // mode. --popover already follows the active theme.
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(127,127,127,0.18))",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.50), 0 4px 12px rgba(0,0,0,0.28)",
        }}
      >
        {/* Header — flat: title + branch route, no icon chip. Matches the
            BranchStrip's quiet breadcrumb language instead of stacking a
            boxed glyph inside the boxed card. */}
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 12,
          padding: "18px 22px 14px",
          borderBottom: "1px solid var(--c-brd, rgba(127,127,127,0.15))",
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 14.5, fontWeight: 600, color: "var(--c-high)", letterSpacing: -0.1,
            }}>
              {phase === "done"
                ? <Check size={14} strokeWidth={2.5} style={{ color: "#4ade80", flexShrink: 0 }} />
                : <GitPullRequest size={14} strokeWidth={1.85} style={{ color: "var(--c-low)", flexShrink: 0 }} />}
              {phase === "done" ? "Pull request created" : "Create pull request"}
            </div>
            <div style={{
              display: "flex", alignItems: "center", gap: 7,
              marginTop: 7, flexWrap: "wrap",
            }}>
              <BranchPill name={branch} kind="head" />
              <span style={{ fontSize: 11, color: "var(--c-ghost)" }}>→</span>
              <BranchPill name={baseBranch} kind="base" />
              {authMethod === "gh" && ghLogin && (
                <AuthChip avatar={null} label={`@${ghLogin}`} hint="via gh" />
              )}
              {authMethod === "link" && link && (
                <AuthChip
                  avatar={link.github_avatar_url}
                  label={`@${link.github_login}`}
                  hint="via Fleetify"
                  onSwitch={async () => {
                    await github.disconnect();
                    setLink(null);
                    const r = await github.beginOAuth();
                    if (r.ok) setLink(r.link);
                  }}
                  onDisconnect={async () => {
                    await github.disconnect();
                    setLink(null);
                  }}
                />
              )}
            </div>
          </div>
          <button onClick={onClose} disabled={creating} title="Close" style={{
            background: "none", border: "none", cursor: creating ? "default" : "pointer",
            color: "var(--c-low)", padding: 6, borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: creating ? 0.4 : 1,
            transition: "color 0.12s, background 0.12s",
          }}
            onMouseEnter={e => { if (!creating) { e.currentTarget.style.color = "var(--c-fg)"; e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.06)"; } }}
            onMouseLeave={e => { if (!creating) { e.currentTarget.style.color = "var(--c-low)"; e.currentTarget.style.background = "none"; } }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        {phase === "done" && result ? (
          <div style={{ padding: "32px 24px 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 999,
              background: "rgba(74,222,128,0.10)",
              border: "1px solid rgba(74,222,128,0.35)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#4ade80",
            }}>
              <Check size={20} strokeWidth={2.5} />
            </div>
            <div style={{ fontSize: 14, color: "var(--c-fg)", textAlign: "center", fontWeight: 500 }}>
              {result.number != null ? `#${result.number}` : "PR"} opened on the remote.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button onClick={open} style={btnPrimary}>
                <ExternalLink size={13} /> Open in GitHub
              </button>
              <button onClick={onClose} style={btnGhost}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{
              padding: "16px 22px 18px", display: "flex", flexDirection: "column", gap: 16,
              overflow: "auto", flex: 1,
            }}>
              <Field label="Title" hint={
                <GenerateHint
                  ariaLabel="Generate title with AI"
                  generating={genField === "title"}
                  used={aiTitleUsed}
                  disabled={creating || genField === "body"}
                  onClick={() => void generateField("title")}
                />
              }>
                <input
                  ref={titleRef}
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  disabled={creating || genField === "title"}
                  placeholder="Short summary…"
                  style={inputStyle}
                  onFocus={e => { e.currentTarget.style.borderColor = "var(--c-brd2, rgba(127,127,127,0.4))"; }}
                  onBlur={e => { e.currentTarget.style.borderColor = "var(--c-brd, rgba(127,127,127,0.22))"; }}
                />
                {genErr.title && (
                  <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 4 }}>{genErr.title}</div>
                )}
              </Field>

              <Field label="Description · Markdown" hint={
                <GenerateHint
                  ariaLabel="Generate description with AI"
                  generating={genField === "body"}
                  used={aiBodyUsed}
                  disabled={creating || genField === "title"}
                  onClick={() => void generateField("body")}
                />
              }>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  disabled={creating || genField === "body"}
                  placeholder="What changed and why?"
                  style={textareaStyle}
                  onFocus={e => { e.currentTarget.style.borderColor = "var(--c-brd2, rgba(127,127,127,0.4))"; }}
                  onBlur={e => { e.currentTarget.style.borderColor = "var(--c-brd, rgba(127,127,127,0.22))"; }}
                />
                {genErr.body && (
                  <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 4 }}>{genErr.body}</div>
                )}
                {bodyTooLong && (
                  <div style={{
                    fontSize: 11, color: "#fde68a",
                    background: "rgba(251,191,36,0.08)",
                    border: "1px solid rgba(251,191,36,0.25)",
                    borderRadius: 6, padding: "6px 9px",
                    marginTop: 6, lineHeight: 1.55,
                  }}>
                    Body is {body.length.toLocaleString()} chars; GitHub caps PR descriptions around 65,000.
                    The last {(body.length - PR_BODY_MAX).toLocaleString()} chars will be replaced by "[…body truncated]" when submitting.
                  </div>
                )}
              </Field>

              <DraftToggle
                value={draft}
                onChange={setDraft}
                disabled={creating}
              />

              {authReady && authMethod === "none" && (
                <ConnectGitHubBlock
                  connecting={connecting}
                  browserFallbackUrl={browserFallbackUrl}
                  onConnect={async () => {
                    setError(null); setErrorCode(null);
                    setBrowserFallbackUrl(null);
                    setConnecting(true);
                    const r = await github.beginOAuth();
                    setBrowserFallbackUrl(null);
                    setConnecting(false);
                    if (r.ok) {
                      setLink(r.link);
                    } else {
                      setError(`Couldn't connect: ${r.error || r.code}`);
                    }
                  }}
                />
              )}

              {errorCode === "REPO_NOT_INSTALLED" ? (
                <RepoNotInstalledBlock
                  onInstall={async () => { await github.openInstallation(); }}
                  onRetry={() => { setError(null); setErrorCode(null); submit(); }}
                />
              ) : errorCode === "REPO_CREATE_FORBIDDEN" ? (
                <RepoCreateForbiddenBlock
                  onOpenGitHubNew={() => {
                    const w = window as unknown as { electronAPI?: { openExternal?: (url: string) => Promise<unknown> } };
                    w.electronAPI?.openExternal?.("https://github.com/new");
                  }}
                  onRetry={() => { setError(null); setErrorCode(null); submit(); }}
                />
              ) : errorCode === "AUTH_EXPIRED" ? (
                <AuthExpiredBlock
                  onReconnect={async () => {
                    setError(null); setErrorCode(null);
                    const r = await github.beginOAuth();
                    if (r.ok) setLink(r.link);
                    else setError(`Couldn't reconnect: ${r.error || r.code}`);
                  }}
                />
              ) : errorCode === "RATE_LIMIT" ? (
                <RateLimitBlock
                  message={error ?? "GitHub rate limit hit."}
                  onRetry={() => { setError(null); setErrorCode(null); submit(); }}
                />
              ) : errorCode === "NETWORK" || errorCode === "GITHUB_DOWN" ? (
                <RetryableErrorBlock
                  title={errorCode === "NETWORK" ? "Bağlantı hatası" : "GitHub'a ulaşılamıyor"}
                  message={error ?? ""}
                  onRetry={() => { setError(null); setErrorCode(null); submit(); }}
                />
              ) : errorCode === "PR_EXISTS" ? (
                /* This branch hits only when github-rest couldn't
                   locate the existing PR (race / wrong head ref).
                   The happy path lands on Done with existed:true. */
                <PRExistsBlock
                  message={error ?? "Bu branch için zaten açık bir PR var ama URL bulunamadı."}
                  onOpenManually={() => git.openPR(folder)}
                />
              ) : errorCode ? (
                <TaggedErrorBlock
                  code={errorCode}
                  message={error ?? ""}
                />
              ) : error ? (
                <div style={{
                  fontSize: 11.5, color: "#fca5a5",
                  background: "rgba(248,113,113,0.10)",
                  border: "1px solid rgba(248,113,113,0.25)",
                  borderRadius: 6, padding: "7px 10px",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  lineHeight: 1.5,
                }}>
                  {error}
                </div>
              ) : null}
            </div>

            {/* Footer — flat: hairline divider only, no raised fill. One
                surface end-to-end keeps the card reading as a single
                quiet sheet instead of stacked zones. */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              padding: "12px 22px 16px",
              borderTop: "1px solid var(--c-brd, rgba(127,127,127,0.15))",
              flexShrink: 0,
            }}>
              <span style={{ fontSize: 11, color: "var(--c-dim)", fontFamily: "var(--font-mono)" }}>
                {formatShortcut(["Mod", "Enter"])} to submit
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={onClose} disabled={creating} style={btnGhost}>Cancel</button>
                <button
                  onClick={submit}
                  disabled={!title.trim() || creating || generating || !authReady || authMethod === "none"}
                  title={
                    !authReady ? "Checking auth…" :
                    authMethod === "none" ? "Connect GitHub first" :
                    undefined
                  }
                  style={!title.trim() || creating || generating || !authReady || authMethod === "none" ? btnPrimaryDisabled : btnPrimary}
                >
                  {creating
                    ? <><Loader2 size={13} style={{ animation: "spin 1.2s linear infinite" }} /> Creating…</>
                    : <>{draft ? "Create draft PR" : "Create PR"}</>
                  }
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Header chip showing which identity will own the PR. For the link
 *  path the chip is interactive: clicking opens a popover with Switch
 *  and Disconnect actions (spec §7.6). The gh-path chip stays read-
 *  only — switching gh accounts is outside Fleetify's scope. */
function AuthChip({ avatar, label, hint, onSwitch, onDisconnect }: {
  avatar: string | null;
  label: string;
  hint: string;
  onSwitch?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const interactive = !!(onSwitch || onDisconnect);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        title={`PR will open as ${label} (${hint})`}
        onClick={() => interactive && setOpen((v) => !v)}
        disabled={!interactive}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "2px 8px 2px 2px",
          fontSize: 11, fontWeight: 500,
          background: open ? "rgba(var(--fg-rgb), 0.08)" : "rgba(var(--fg-rgb), 0.04)",
          border: "1px solid var(--c-brd, rgba(127,127,127,0.20))",
          color: "var(--c-low)",
          borderRadius: 999,
          maxWidth: 220,
          fontFamily: "inherit",
          cursor: interactive ? "pointer" : "default",
        }}
      >
        {avatar ? (
          <img src={avatar} alt="" width={14} height={14}
            style={{ borderRadius: 999, display: "block" }} />
        ) : (
          <span style={{
            width: 14, height: 14, borderRadius: 999,
            background: "rgba(var(--fg-rgb), 0.10)",
            display: "inline-block",
          }} />
        )}
        <span style={{
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          fontFamily: "var(--font-mono)",
        }}>{label}</span>
      </button>
      {open && interactive && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            background: "var(--popover, #161616)",
            border: "1px solid var(--c-brd, rgba(127,127,127,0.18))",
            borderRadius: 8,
            padding: 4,
            minWidth: 140,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            zIndex: 10000,
            display: "flex", flexDirection: "column", gap: 2,
          }}
        >
          {onSwitch && (
            <button
              type="button"
              role="menuitem"
              onClick={async () => { setOpen(false); await onSwitch(); }}
              style={popoverItem}
            >Switch account</button>
          )}
          {onDisconnect && (
            <button
              type="button"
              role="menuitem"
              onClick={async () => { setOpen(false); await onDisconnect(); }}
              style={{ ...popoverItem, color: "#fca5a5" }}
            >Disconnect</button>
          )}
        </div>
      )}
    </span>
  );
}

const popoverItem: React.CSSProperties = {
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: "7px 10px",
  borderRadius: 6,
  fontSize: 12, fontFamily: "inherit",
  color: "var(--c-fg)",
  cursor: "pointer",
};

function ConnectGitHubBlock({ connecting, browserFallbackUrl, onConnect }: {
  connecting: boolean;
  browserFallbackUrl: string | null;
  onConnect: () => void;
}) {
  return (
    <div style={{
      fontSize: 12, color: "var(--c-med)",
      background: "rgba(var(--fg-rgb), 0.03)",
      border: "1px dashed var(--c-brd2, rgba(127,127,127,0.3))",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      {/* Heading + subtext flip based on `connecting`: while OAuth is
          in flight we already opened a browser tab on the user's behalf
          (PRDialog auto-triggers on mount when no auth is available),
          so the copy explains that. After it resolves or fails the
          original "no connection" prompt comes back so a manual retry
          still reads naturally. */}
      <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--c-high)" }}>
        {connecting ? "GitHub yetkilendirmesi açıldı" : "GitHub bağlantısı yok"}
      </div>
      <div style={{ color: "var(--c-low, #9a9a9a)", marginBottom: 10 }}>
        {connecting
          ? "Tarayıcıda Fleetify GitHub App'ini onayla, sonra buraya dön."
          : "Fleetify üzerinden PR atmak için GitHub hesabını bağla."}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={onConnect}
          disabled={connecting}
          style={{
            padding: "7px 14px", borderRadius: 7,
            background: "var(--c-fg)", border: "1px solid var(--c-fg)",
            color: "var(--card, #0d0d0d)",
            cursor: connecting ? "default" : "pointer",
            fontSize: 12.5, fontFamily: "inherit", fontWeight: 600,
            display: "inline-flex", alignItems: "center", gap: 6,
            opacity: connecting ? 0.6 : 1,
          }}
        >
          {connecting ? <><Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /> Tarayıcı bekleniyor…</> : "Connect GitHub"}
        </button>
        <a
          href="https://cli.github.com/manual/installation"
          target="_blank" rel="noreferrer"
          style={{ fontSize: 11.5, color: "var(--c-dim)", textDecoration: "none" }}
        >
          or install gh CLI →
        </a>
      </div>
      {browserFallbackUrl && (
        <div style={{
          marginTop: 10,
          fontSize: 11.5, color: "#fde68a",
          background: "rgba(251,191,36,0.08)",
          border: "1px solid rgba(251,191,36,0.25)",
          borderRadius: 6, padding: "8px 10px",
          lineHeight: 1.55,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>Browser couldn't open</div>
          <div style={{ color: "#e8d4a0" }}>
            The authorization URL is on your clipboard — paste it into a browser to continue.
          </div>
        </div>
      )}
    </div>
  );
}

function RepoNotInstalledBlock({ onInstall, onRetry }: {
  onInstall: () => void;
  onRetry: () => void;
}) {
  return (
    <div style={{
      fontSize: 12, color: "#dcdcdc",
      background: "rgba(251,191,36,0.08)",
      border: "1px solid rgba(251,191,36,0.25)",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#fde68a" }}>
        Bu repo'ya Fleetify install edilmemiş
      </div>
      <div style={{ color: "#e8d4a0", marginBottom: 10 }}>
        PR atmak için Fleetify GitHub App'ini bu repo'ya install et,
        sonra Retry'a bas.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onInstall} style={btnAmberPrimary}>Install on this repo →</button>
        <button onClick={onRetry}   style={btnAmberGhost}>Retry</button>
      </div>
    </div>
  );
}

function RepoCreateForbiddenBlock({ onOpenGitHubNew, onRetry }: {
  onOpenGitHubNew: () => void;
  onRetry: () => void;
}) {
  return (
    <div style={{
      fontSize: 12, color: "#dcdcdc",
      background: "rgba(251,191,36,0.08)",
      border: "1px solid rgba(251,191,36,0.25)",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#fde68a" }}>
        Repo auto-create isn't available
      </div>
      <div style={{ color: "#e8d4a0", marginBottom: 10 }}>
        Fleetify's GitHub App can't create new repos under your account.
        Install <code>gh</code> CLI (it does), or create the repo on
        github.com first and click Create PR again.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onOpenGitHubNew} style={btnAmberPrimary}>Open github.com/new →</button>
        <button onClick={onRetry} style={btnAmberGhost}>Retry</button>
      </div>
    </div>
  );
}

function AuthExpiredBlock({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div style={{
      fontSize: 12, color: "#dcdcdc",
      background: "rgba(248,113,113,0.08)",
      border: "1px solid rgba(248,113,113,0.25)",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#fca5a5" }}>
        GitHub bağlantın sona ermiş
      </div>
      <div style={{ color: "var(--c-low, #9a9a9a)", marginBottom: 10 }}>
        Token yenilenemedi. Tekrar bağlanman gerekiyor.
      </div>
      <button onClick={onReconnect} style={{
        padding: "7px 14px", borderRadius: 7,
        background: "var(--c-fg)", border: "1px solid var(--c-fg)",
        color: "var(--card, #0d0d0d)",
        cursor: "pointer", fontSize: 12.5,
        fontFamily: "inherit", fontWeight: 600,
      }}>Reconnect GitHub</button>
    </div>
  );
}

const btnAmberPrimary: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  background: "rgba(251,191,36,0.20)",
  border: "1px solid rgba(251,191,36,0.40)",
  color: "#fde68a", cursor: "pointer", fontSize: 12,
  fontFamily: "inherit", fontWeight: 500,
};

const btnAmberGhost: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  background: "transparent",
  border: "1px solid rgba(251,191,36,0.30)",
  color: "#fde68a", cursor: "pointer", fontSize: 12,
  fontFamily: "inherit",
};

const btnRedPrimary: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  background: "rgba(248,113,113,0.15)",
  border: "1px solid rgba(248,113,113,0.35)",
  color: "#fca5a5", cursor: "pointer", fontSize: 12,
  fontFamily: "inherit", fontWeight: 500,
};

/** Banner for transient network / GitHub-side failures — same shape
 *  every "just try again" code shares. */
function RetryableErrorBlock({ title, message, onRetry }: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div style={{
      fontSize: 12, color: "#dcdcdc",
      background: "rgba(248,113,113,0.08)",
      border: "1px solid rgba(248,113,113,0.25)",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#fca5a5" }}>{title}</div>
      {message && (
        <div style={{
          color: "var(--c-low, #9a9a9a)",
          marginBottom: 10,
          fontFamily: "var(--font-mono)", fontSize: 11,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{message}</div>
      )}
      <button onClick={onRetry} style={btnRedPrimary}>Retry</button>
    </div>
  );
}

/** Rate-limit banner with a live countdown. Parses the wait seconds
 *  out of the message we built in github-rest.cjs ("Retry in 60s.").
 *  Submit re-enables once the timer hits zero. */
function RateLimitBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  const parsed = /Retry in (\d+)s/.exec(message);
  const initial = parsed ? parseInt(parsed[1]!, 10) : 60;
  const [seconds, setSeconds] = useState(initial);
  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  const ready = seconds <= 0;
  return (
    <div style={{
      fontSize: 12, color: "#dcdcdc",
      background: "rgba(251,191,36,0.08)",
      border: "1px solid rgba(251,191,36,0.25)",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#fde68a" }}>
        GitHub rate limit
      </div>
      <div style={{ color: "#e8d4a0", marginBottom: 10 }}>
        {ready ? "Ready to retry." : `Bekle: ${seconds}s`}
      </div>
      <button
        onClick={onRetry}
        disabled={!ready}
        style={ready ? btnAmberPrimary : { ...btnAmberPrimary, opacity: 0.5, cursor: "default" }}
      >
        Retry
      </button>
    </div>
  );
}

/** Shown when GitHub says a PR already exists. Manual "Open in GitHub"
 *  fallback for now — the auto-fetched `#N` URL drops in alongside via
 *  Task 12. */
function PRExistsBlock({ message, onOpenManually }: {
  message: string;
  onOpenManually: () => void;
}) {
  return (
    <div style={{
      fontSize: 12, color: "#dcdcdc",
      background: "rgba(96,165,250,0.08)",
      border: "1px solid rgba(96,165,250,0.25)",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#93c5fd" }}>
        Bu branch için PR zaten açık
      </div>
      {message && (
        <div style={{ color: "var(--c-low, #9a9a9a)", marginBottom: 10, fontSize: 11.5 }}>{message}</div>
      )}
      <button
        onClick={onOpenManually}
        style={{
          padding: "6px 12px", borderRadius: 6,
          background: "rgba(96,165,250,0.20)",
          border: "1px solid rgba(96,165,250,0.40)",
          color: "#93c5fd", cursor: "pointer", fontSize: 12,
          fontFamily: "inherit", fontWeight: 500,
        }}
      >
        Open in GitHub →
      </button>
    </div>
  );
}

/** Localised messages for codes that don't need their own interactive
 *  recovery — just a clearer title than the raw GitHub/git string. */
const TAGGED_ERROR_TITLES: Record<string, string> = {
  NO_COMMITS:        "Base ile head arasında commit yok",
  NO_ORIGIN:         "Repo'da origin remote yok",
  UNSUPPORTED_HOST:  "Sadece github.com destekleniyor",
  PUSH_REJECTED:     "Push reddedildi",
  PUSH_FORBIDDEN:    "Push reddedildi (permission)",
  ORIGIN_PARSE_FAILED: "Origin URL'i çözümlenemedi",
  NO_BRANCH:         "Branch okunamadı",
  DETACHED_HEAD:     "HEAD detached — branch'e geç",
  VALIDATION:        "GitHub validation hatası",
  GH_FAILED:         "gh CLI komutu başarısız oldu",
  GH_STEP_FAILED:    "gh akışında bir adım başarısız oldu",
  NO_AUTH:           "GitHub kimliği yok",
};

function TaggedErrorBlock({ code, message }: { code: string; message: string }) {
  const title = TAGGED_ERROR_TITLES[code] ?? `Hata: ${code}`;
  return (
    <div style={{
      fontSize: 12, color: "#dcdcdc",
      background: "rgba(248,113,113,0.08)",
      border: "1px solid rgba(248,113,113,0.25)",
      borderRadius: 8, padding: "12px 14px",
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#fca5a5" }}>{title}</div>
      {message && (
        <div style={{
          color: "var(--c-low, #9a9a9a)",
          fontFamily: "var(--font-mono)", fontSize: 11,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{message}</div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 18 }}>
        {/* Sentence-case label — the SCREAMING uppercase + tracking read
            as heavy chrome against the app's quiet text hierarchy. */}
        <span style={{ fontSize: 11.5, color: "var(--c-dim)", fontWeight: 500 }}>{label}</span>
        {hint}
      </div>
      {children}
    </div>
  );
}

/** Per-field "✦ Generate with AI" hint button. aria-label carries the
 *  field so tests/screen-readers can tell the two apart. */
function GenerateHint({ ariaLabel, generating, used, disabled, onClick }: {
  ariaLabel: string;
  generating: boolean;
  used: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled || generating}
      style={{
        background: "none", border: "none",
        cursor: disabled || generating ? "default" : "pointer",
        color: used ? "var(--c-fg)" : "var(--c-dim)",
        fontSize: 11, padding: "1px 4px", borderRadius: 3,
        display: "inline-flex", alignItems: "center", gap: 4,
        fontFamily: "inherit",
        opacity: disabled && !generating ? 0.5 : 1,
      }}
    >
      {generating
        ? <><Loader2 size={10} style={{ animation: "spin 1.2s linear infinite" }} /> Generating…</>
        : <><Sparkles size={10} /> {used ? "Regenerate" : "Generate with AI"}</>}
    </button>
  );
}

/* Flat mono branch label — same language as the BranchStrip pills.
   The old purple/bordered pills fought the app's monochrome theme
   (and the purple head pill broke entirely on light chrome). Head
   reads brighter than base; the full name lives in the title attr. */
function BranchPill({ name, kind }: { name: string; kind: "head" | "base" }) {
  const isBase = kind === "base";
  return (
    <span title={name} style={{
      fontSize: 11.5, fontWeight: 500,
      fontFamily: "var(--font-mono)", letterSpacing: -0.15,
      color: isBase ? "var(--c-med)" : "var(--c-high)",
      maxWidth: 240,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>{name}</span>
  );
}

/* Switch-style draft toggle. The previous checkbox felt unstyled
   against the rest of the dialog; this matches the chat-header
   toggles aesthetic. */
function DraftToggle({ value, onChange, disabled }: {
  value: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      style={{
        display: "flex", alignItems: "center", gap: 11,
        background: "none", border: "none", outline: "none",
        cursor: disabled ? "default" : "pointer",
        padding: "4px 0",
        textAlign: "left",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{
        position: "relative",
        width: 30, height: 17, borderRadius: 999,
        // Neutral on/off — ON state used to be purple to match the
        // old AI accent. Now it tracks the foreground colour so it
        // works in both themes and stays brand-neutral.
        background: value ? "var(--c-fg)" : "rgba(var(--fg-rgb), 0.10)",
        border: value ? "1px solid var(--c-fg)" : "1px solid var(--c-brd, rgba(127,127,127,0.18))",
        transition: "background 0.16s, border 0.16s",
        flexShrink: 0,
      }}>
        <span style={{
          position: "absolute",
          top: 1, left: value ? 14 : 1,
          width: 13, height: 13, borderRadius: 999,
          // ON: dark thumb so it pops against the white track.
          // OFF: light thumb against the dim track.
          background: value ? "var(--card, #0d0d0d)" : "var(--c-low)",
          transition: "left 0.16s, background 0.16s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        }} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 12.5, color: "var(--c-fg)", fontWeight: 500 }}>Open as draft</span>
        <span style={{ fontSize: 11, color: "var(--c-dim)" }}>
          Reviewers won't be requested until you mark it ready.
        </span>
      </span>
    </button>
  );
}

/* Shared input style — strictly theme-token driven so the dialog
   renders correctly on both dark and light chrome. */
const focusableField: React.CSSProperties = {
  width: "100%",
  background: "var(--card, #0d0d0d)",
  border: "1px solid var(--c-brd, rgba(127,127,127,0.22))",
  color: "var(--c-fg, #f0f0f0)",
  outline: "none",
  transition: "border-color 0.12s, box-shadow 0.12s, background 0.12s",
};

const inputStyle: React.CSSProperties = {
  ...focusableField,
  padding: "10px 12px", borderRadius: 8,
  fontSize: 13.5, fontFamily: "inherit", fontWeight: 500,
};

const textareaStyle: React.CSSProperties = {
  ...focusableField,
  minHeight: 160, maxHeight: 320,
  padding: "11px 13px", borderRadius: 8,
  fontSize: 12.5, fontFamily: "var(--font-mono)",
  resize: "vertical", lineHeight: 1.6,
};

// Quiet text button — borderless, like the BranchStrip's inline action
// verbs. The bordered ghost made Cancel compete with the primary.
const btnGhost: React.CSSProperties = {
  padding: "7px 12px", borderRadius: 7,
  background: "transparent",
  border: "none",
  color: "var(--c-low)", cursor: "pointer", fontSize: 12.5,
  fontFamily: "inherit", fontWeight: 500,
  outline: "none",
  transition: "color 0.12s",
};

const btnPrimary: React.CSSProperties = {
  padding: "7px 16px", borderRadius: 7,
  background: "var(--c-fg)",
  border: "1px solid var(--c-fg)",
  color: "var(--card, #0d0d0d)",
  cursor: "pointer", fontSize: 12.5,
  fontFamily: "inherit", fontWeight: 600,
  display: "inline-flex", alignItems: "center", gap: 6,
  outline: "none",
  transition: "transform 0.08s, opacity 0.12s",
};

const btnPrimaryDisabled: React.CSSProperties = {
  ...btnPrimary,
  background: "rgba(var(--fg-rgb), 0.08)",
  border: "1px solid var(--c-brd, rgba(127,127,127,0.20))",
  color: "var(--c-dim, #7a7a7a)",
  cursor: "default",
  boxShadow: "none",
};
