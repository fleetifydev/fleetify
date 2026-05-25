/**
 * OnboardingChat — chat-as-onboarding for fresh registrations.
 *
 * Mirrors the look and pacing of the new-session auto-intro flow.
 * The user picks one or many providers, Fleet verifies each one
 * end-to-end with a live status panel, optionally connects GitHub,
 * and picks a default workspace folder. The whole thing is scripted
 * (no real LLM call) but every selection IS persisted via electron
 * config so the main app reads them on first launch.
 *
 * Conventions used throughout:
 *   • Hover surfaces use a solid color (var(--secondary)), never
 *     low-alpha rgba on dark — per the project's hover-pattern rule.
 *   • Lists auto-open the moment the bubble finishes typing; the
 *     user never clicks a trigger to reveal a panel.
 *   • Multi-step verification leans into "the app is checking
 *     everything for you" — sequential per-provider rows with
 *     spinners that resolve to ✓ / ⚠ / ✗ status pills.
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowRight,
  Check,
  Loader2,
  X,
  Github,
  ExternalLink,
  Terminal,
} from "lucide-react";
import { LogoMark } from "@/components/brand/logo-mark";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { apiScanProviders, type ProviderScan, type AuthUser } from "@/lib/api";

interface Props {
  user: AuthUser | null;
  onDone: () => void;
}

type Sender = "assistant" | "user";

type WidgetKind =
  | "providers"
  | "scan"
  | "main-agent"
  | "github";

interface ChatMsg {
  id: string;
  sender: Sender;
  text: string;
  typing?: boolean;
  widget?: WidgetKind;
  resolved?: boolean;
}

interface ProviderDef {
  id: string;
  label: string;
  logo: string;
  /** Bucket — drives the section header in the picker. */
  kind: "cli" | "api";
  scanKey?: keyof Pick<
    ProviderScan,
    "claude_cli" | "gemini_cli" | "codex_cli" | "agy_cli" | "antigravity_sdk"
  >;
  envKey?: keyof ProviderScan["env_keys"];
  ollama?: boolean;
  /** Used in scan readouts only — the picker uses section grouping instead. */
  hint: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: "claude",    label: "Claude Code", logo: "claude", kind: "cli", scanKey: "claude_cli", hint: "Anthropic CLI" },
  { id: "codex",     label: "Codex",       logo: "codex",  kind: "cli", scanKey: "codex_cli",  hint: "OpenAI CLI" },
  // Antigravity sits next to its predecessor Gemini CLI — Google sunsets
  // the latter for individual AI Pro/Ultra users on 2026-06-18, so
  // surfacing both side-by-side gives migrating users a one-tap path.
  { id: "gemini",    label: "Gemini",      logo: "gemini", kind: "cli", scanKey: "gemini_cli", hint: "Google CLI" },
  { id: "agy",            label: "Antigravity",     logo: "agy",  kind: "cli", scanKey: "agy_cli",         hint: "Google's terminal agent (OAuth)" },
  // The SDK pairs an install step (`pip install google-antigravity`)
  // with an API key entry (GEMINI_API_KEY from Google AI Studio). It
  // sits between cli and api in shape: kind: "api" so the Add-key
  // flow surfaces, plus a scanKey so the install state reads back.
  // The verify panel handles the dual nature based on the scan probe.
  { id: "antigravity-sdk", label: "Antigravity SDK", logo: "agy",  kind: "api", envKey: "gemini",            scanKey: "antigravity_sdk", hint: "Python SDK + Gemini key" },
  { id: "ollama",         label: "Ollama",          logo: "ollama", kind: "cli", ollama: true,                hint: "Local models" },
  { id: "anthropic",      label: "Anthropic",       logo: "claude", kind: "api", envKey: "anthropic",         hint: "API key" },
  { id: "openai",         label: "OpenAI",          logo: "openai", kind: "api", envKey: "openai",            hint: "API key" },
  { id: "googleai",       label: "Google AI",       logo: "gemini", kind: "api", envKey: "gemini",            hint: "API key" },
  { id: "groq",           label: "Groq",            logo: "groq",   kind: "api", envKey: "groq",              hint: "API key" },
];

const TYPE_BASE_MS = 12;
const TYPE_PUNCT_MS = 110;
const PAUSE_BETWEEN_BUBBLES = 420;
const PROVIDER_REVEAL_STAGGER_MS = 55;
const PROVIDER_VERIFY_MS = 950;

interface Selections {
  providers?: ProviderDef[];
  scan?: ProviderScan | null;
  defaultProvider?: ProviderDef;
  githubUsername?: string;
  githubSkipped?: boolean;
  /** Probed once at mount — populated when `gh` CLI on the host
   *  reports an authenticated user. Drives the GitHub step's UI:
   *  one-tap "Use @<login>" instead of asking for a token paste.
   *  null = probe completed and nothing's signed in.
   *  undefined = probe still in flight. */
  existingGithub?: { username: string } | null;
}

export function OnboardingChat({ user, onDone }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [show, setShow] = useState(false);
  const [done, setDone] = useState(false);
  const [selections, setSelections] = useState<Selections>({});
  // Mirror of `selections` accessible from async handlers without
  // closing over a stale snapshot. The gh-auth probe writes
  // `existingGithub` after handlers were declared, so the GitHub-step
  // intro copy needs to read it via the ref to see the live value.
  const selectionsRef = useRef<Selections>({});
  useEffect(() => { selectionsRef.current = selections; }, [selections]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const firstName = (user?.name || "").trim().split(/\s+/)[0] || "there";

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 60);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const pushAssistant = (text: string, widget?: WidgetKind): Promise<void> =>
    new Promise((resolve) => {
      const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setMessages((m) => [
        ...m,
        { id, sender: "assistant", text: "", typing: true, widget },
      ]);

      let i = 0;
      const tick = () => {
        i += 1;
        const visible = text.slice(0, i);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === id ? { ...msg, text: visible, typing: i < text.length } : msg,
          ),
        );
        if (i < text.length) {
          const ch = text[i - 1];
          const punct = ch === "." || ch === "," || ch === "—" || ch === ":" || ch === "?";
          setTimeout(tick, punct ? TYPE_PUNCT_MS : TYPE_BASE_MS);
        } else {
          setTimeout(resolve, PAUSE_BETWEEN_BUBBLES);
        }
      };
      setTimeout(tick, PAUSE_BETWEEN_BUBBLES);
    });

  const pushUser = (text: string) => {
    const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setMessages((m) => [...m, { id, sender: "user", text }]);
  };

  const resolveLastWidget = () => {
    setMessages((m) => {
      const idx = [...m].reverse().findIndex((msg) => msg.widget && !msg.resolved);
      if (idx === -1) return m;
      const realIdx = m.length - 1 - idx;
      return m.map((msg, i) => (i === realIdx ? { ...msg, resolved: true } : msg));
    });
  };

  // ─── Step handlers ────────────────────────────────────────

  const handleProvidersConfirm = async (providers: ProviderDef[]) => {
    resolveLastWidget();
    pushUser(humanList(providers.map((p) => p.label)));
    setSelections((s) => ({ ...s, providers }));

    // Pre-fetch the scan in parallel with the assistant typing so
    // the verification panel has data the moment it mounts.
    const scanPromise = apiScanProviders().catch(() => null);

    const intro =
      providers.length === 1
        ? `Got it — **${providers[0]!.label}**. Let me verify it end-to-end before we move on, so you don't get a surprise the first time you hit send.`
        : `Got it — **${providers.length} providers**. I'll verify each one end-to-end so you don't get a surprise the first time you hit send.`;
    await pushAssistant(intro, "scan");

    const scan = await scanPromise;
    setSelections((s) => ({ ...s, scan }));
    // Wait for the scan animation: per-provider verify time + small tail.
    // ScanWidget may also auto-install a missing CLI in this window;
    // npm install can take a while, so cap generously and re-fetch
    // the scan afterwards so the readout reflects post-install state.
    await new Promise((r) => setTimeout(r, providers.length * PROVIDER_VERIFY_MS + 350));
    resolveLastWidget();

    // Re-scan once more — picks up any auto-install that happened
    // inside the widget. Falls back to the original scan on failure.
    const finalScan = (await apiScanProviders().catch(() => null)) ?? scan;
    if (finalScan !== scan) setSelections((s) => ({ ...s, scan: finalScan }));

    await pushAssistant(buildScanReadout(providers, finalScan));

    if (providers.length > 1) {
      // Multi-pick → ask which one Fleet should drive by default.
      // Single-pick is auto-set further down.
      await pushAssistant(
        "Since you've got more than one wired up, **which should Fleet drive by default?** I'll fall back to the others when this one isn't a fit (or you can switch per-session).",
        "main-agent",
      );
    } else {
      // Single pick — auto-set as default + skip the question.
      const only = providers[0]!;
      setSelections((s) => ({ ...s, defaultProvider: only }));
      try {
        const cfg = (await window.electronAPI?.getConfig?.()) ?? {
          onboardingComplete: false,
          apiKeys: {},
        };
        await window.electronAPI?.setConfig?.({ ...cfg, defaultProvider: only.id });
      } catch { /* best-effort */ }

      await pushAssistant(githubIntroCopy(getCurrentExistingGithub()), "github");
    }
  };

  // Snapshot the gh-auth probe at the time we send the GitHub bubble.
  // Reading `selections.existingGithub` directly inside an async handler
  // can race with the probe finishing — read from the latest store state
  // via a getter the handlers can call lazily.
  const getCurrentExistingGithub = (): { username: string } | null | undefined => {
    return selectionsRef.current.existingGithub;
  };

  const handleMainAgentPick = async (provider: ProviderDef) => {
    resolveLastWidget();
    pushUser(provider.label);
    setSelections((s) => ({ ...s, defaultProvider: provider }));
    try {
      const cfg = (await window.electronAPI?.getConfig?.()) ?? {
        onboardingComplete: false,
        apiKeys: {},
      };
      await window.electronAPI?.setConfig?.({ ...cfg, defaultProvider: provider.id });
    } catch { /* best-effort */ }

    await pushAssistant(
      `Locked in — **${provider.label}** drives by default.`,
    );
    await pushAssistant(githubIntroCopy(getCurrentExistingGithub()), "github");
  };

  // GitHub: three resolution paths now that we probe gh CLI on mount:
  //   • { existing: true } — user accepted the already-signed-in
  //     account that gh reported. We don't need a token because gh
  //     already manages it; just persist the username so Fleet's
  //     PR helpers know who to attribute to.
  //   • { username, token } — user pasted a PAT. Validated upstream
  //     against api.github.com/user; we persist token + username.
  //   • { skipped: true } — user opted out. Settings can pick this
  //     up later.
  const handleGithubResult = async (
    result:
      | { method: "cli"; username?: string }
      | { method: "oauth"; username?: string }
      | { skipped: true },
  ) => {
    resolveLastWidget();
    if ("skipped" in result) {
      setSelections((s) => ({ ...s, githubSkipped: true }));
      try { localStorage.setItem("fleet:github-auth-method", "skip"); } catch { /* private mode */ }
      pushUser("Skip — connect later");
      await pushAssistant(
        "No problem — you can pick a connection method later. When you click **Create PR**, Fleet will ask which one to use.",
      );
    } else if (result.method === "cli") {
      setSelections((s) => ({ ...s, githubUsername: result.username }));
      try { localStorage.setItem("fleet:github-auth-method", "cli"); } catch { /* private mode */ }
      pushUser(result.username ? `Use GitHub CLI (@${result.username})` : "Use GitHub CLI");
      try {
        const cfg = (await window.electronAPI?.getConfig?.()) ?? {
          onboardingComplete: false,
          apiKeys: {},
        };
        await window.electronAPI?.setConfig?.({
          ...cfg,
          // No token persisted — gh CLI is the source of truth on this machine.
          githubUsername: result.username,
        });
      } catch { /* best-effort */ }
      await pushAssistant(
        result.username
          ? `Done — Fleet will drive PRs and repo context through the gh CLI as **@${result.username}**.`
          : "Done — Fleet will drive PRs and repo context through the gh CLI.",
      );
    } else {
      // method === "oauth"
      setSelections((s) => ({ ...s, githubUsername: result.username }));
      try { localStorage.setItem("fleet:github-auth-method", "oauth"); } catch { /* private mode */ }
      pushUser(result.username ? `Connected as @${result.username}` : "Connected with GitHub");
      try {
        const cfg = (await window.electronAPI?.getConfig?.()) ?? {
          onboardingComplete: false,
          apiKeys: {},
        };
        await window.electronAPI?.setConfig?.({
          ...cfg,
          githubUsername: result.username,
        });
      } catch { /* best-effort */ }
      await pushAssistant(
        result.username
          ? `Got it — signed in as **@${result.username}** via Fleetify's GitHub link.`
          : "Got it — GitHub OAuth connected.",
      );
    }

    // Onboarding ends here. Default folder is no longer collected on
    // this screen — the user picks one per-session from the chat
    // input chip strip when they need it.
    await pushAssistant(
      `That's the lot, ${firstName}. Hit **Enter Fleet** whenever you're ready.`,
    );
    setDone(true);
  };

  // ─── Run scripted intro on first mount ────────────────────
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Pre-fetch the provider scan in parallel with the assistant
    // typing so the picker can show "Installed" / "Not installed"
    // badges from the moment it appears. The picker reveal stagger
    // (+ welcome bubbles) gives us ~3-4 seconds of headroom for the
    // backend round-trip; if it lands later the picker just hides
    // the badges until the state arrives, which is fine.
    apiScanProviders()
      .then((s) => setSelections((prev) => ({ ...prev, scan: s })))
      .catch(() => { /* badges stay hidden — non-blocking */ });

    // Probe gh CLI for an existing GitHub login so we can surface a
    // one-tap "Use @<login>" path on the GitHub step instead of
    // making the user generate + paste a fresh token. Falls back to
    // the manual flow when the probe fails (gh not installed, not
    // signed in, etc.) — same UX as before.
    if (window.electronAPI?.checkGithubAuth) {
      window.electronAPI.checkGithubAuth()
        .then((res) => {
          setSelections((prev) => ({
            ...prev,
            existingGithub: res.ok && res.username
              ? { username: res.username }
              : null,
          }));
        })
        .catch(() => setSelections((prev) => ({ ...prev, existingGithub: null })));
    } else {
      setSelections((prev) => ({ ...prev, existingGithub: null }));
    }

    (async () => {
      await pushAssistant(`Welcome aboard, ${firstName}.`);
      await pushAssistant(
        "Fleet is a single cockpit for every AI coding agent — Claude Code, Codex, Gemini, Ollama, and the API providers behind them. Shared memory, real cost control, one sidebar.",
      );
      await pushAssistant(
        "Let's set you up — pick one or more providers and I'll verify each is installed and signed in. You can edit any of this later from **Settings**.",
        "providers",
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="app-drag"
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "transparent",
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(8px)",
        transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <div
        style={{
          width: "100%",
          height: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 9,
          color: "var(--m-text)",
          flexShrink: 0,
        }}
      >
        <LogoMark size={18} color="currentColor" />
        <span
          style={{
            fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: "-0.025em",
            lineHeight: 1,
          }}
        >
          Fleetify
        </span>
      </div>

      <div
        ref={scrollRef}
        className="app-no-drag"
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 640,
          overflowY: "auto",
          padding: "20px 28px 24px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {messages.map((m) => (
          <Bubble
            key={m.id}
            msg={m}
            scan={selections.scan}
            chosenProviders={selections.providers}
            githubUsername={selections.githubUsername}
            githubSkipped={selections.githubSkipped}
            existingGithub={selections.existingGithub}
            onProvidersConfirm={handleProvidersConfirm}
            onMainAgentPick={handleMainAgentPick}
            onGithubResult={handleGithubResult}
          />
        ))}
      </div>

      <div
        className="app-no-drag"
        style={{
          width: "100%",
          maxWidth: 640,
          padding: "0 28px 28px",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onDone}
          disabled={!done}
          style={{
            width: "100%",
            height: 40,
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 600,
            background: done ? "#fff" : "rgba(255,255,255,0.06)",
            color: done ? "#000" : "var(--m-text-3)",
            border: "1px solid",
            borderColor: done ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.08)",
            cursor: done ? "pointer" : "not-allowed",
            opacity: done ? 1 : 0.55,
            boxShadow: done
              ? "0 1px 0 rgba(255,255,255,0.4) inset, 0 1px 2px rgba(0,0,0,0.4)"
              : "none",
            transition: "all 0.25s ease",
          }}
          onMouseEnter={(e) => {
            if (!done) return;
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow =
              "0 1px 0 rgba(255,255,255,0.5) inset, 0 4px 10px rgba(0,0,0,0.5)";
          }}
          onMouseLeave={(e) => {
            if (!done) return;
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow =
              "0 1px 0 rgba(255,255,255,0.4) inset, 0 1px 2px rgba(0,0,0,0.4)";
          }}
        >
          Enter Fleet
          <ArrowRight size={13} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

/* ── Bubble ────────────────────────────────────────────────── */
function Bubble({
  msg,
  scan,
  chosenProviders,
  githubUsername,
  githubSkipped,
  existingGithub,
  onProvidersConfirm,
  onMainAgentPick,
  onGithubResult,
}: {
  msg: ChatMsg;
  scan?: ProviderScan | null;
  chosenProviders?: ProviderDef[];
  githubUsername?: string;
  githubSkipped?: boolean;
  existingGithub?: { username: string } | null;
  onProvidersConfirm: (providers: ProviderDef[]) => void;
  onMainAgentPick: (provider: ProviderDef) => void;
  onGithubResult: (
    result:
      | { method: "cli"; username?: string }
      | { method: "oauth"; username?: string }
      | { skipped: true },
  ) => void;
}) {
  if (msg.sender === "user") {
    return (
      <div
        className="msg-in"
        style={{
          marginBottom: 20,
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <div
          style={{
            maxWidth: "75%",
            padding: "9px 13px",
            borderRadius: 14,
            borderBottomRightRadius: 6,
            background: "var(--secondary)",
            overflow: "hidden",
          }}
        >
          <p
            style={{
              fontSize: 13,
              color: "var(--c-high)",
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              margin: 0,
              letterSpacing: "-0.004em",
              overflowWrap: "break-word",
              wordBreak: "break-word",
            }}
          >
            {msg.text}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="msg-in" style={{ marginBottom: 20 }}>
      <div
        style={{
          color: "var(--foreground)",
          fontSize: 13,
          lineHeight: 1.55,
          letterSpacing: "-0.004em",
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        {msg.typing && <Caret />}
      </div>

      {!msg.typing && !msg.resolved && msg.widget === "providers" && (
        <ProvidersWidget onConfirm={onProvidersConfirm} scan={scan ?? null} />
      )}
      {!msg.typing && msg.widget === "scan" && chosenProviders && (
        <ScanWidget
          providers={chosenProviders}
          scan={scan ?? null}
          frozen={Boolean(msg.resolved)}
        />
      )}
      {!msg.typing && !msg.resolved && msg.widget === "main-agent" && chosenProviders && (
        <MainAgentWidget providers={chosenProviders} onPick={onMainAgentPick} />
      )}
      {/* No resolved card for main-agent — the user's message bubble
          plus the assistant's "Locked in — X drives by default" reply
          already make the choice obvious. A persistent card on top
          would be visual triplication. */}
      {!msg.typing && !msg.resolved && msg.widget === "github" && (
        <GithubWidget
          onResult={onGithubResult}
          existingUsername={existingGithub?.username}
        />
      )}
      {msg.resolved && msg.widget === "github" && (
        <GithubResolved username={githubUsername} skipped={Boolean(githubSkipped)} />
      )}
    </div>
  );
}

/* ── Providers widget — section-grouped multi-select dropdown ──
   Auto-opens (no trigger) when the bubble finishes typing. Two
   sections (CLI / API) replace the per-row hint chrome — the
   group itself tells you what kind a provider is. Rows are
   compact (28 px), no per-row borders. Selection toggles a
   filled solid-surface row with a trailing check; hover uses
   the same solid surface (per the project's hover rule).            */
function ProvidersWidget({
  onConfirm,
  scan,
}: {
  onConfirm: (providers: ProviderDef[]) => void;
  /** Snapshot of /providers/scan, pre-fetched on OnboardingChat mount.
   *  null while the request is still in flight — the picker just
   *  hides the install-state badge until it arrives. */
  scan: ProviderScan | null;
}) {
  const [revealed, setRevealed] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      i += 1;
      setRevealed(i);
      if (i < PROVIDERS.length) setTimeout(tick, PROVIDER_REVEAL_STAGGER_MS);
    };
    setTimeout(tick, 80);
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = () => {
    if (selected.size === 0) return;
    const picks = PROVIDERS.filter((p) => selected.has(p.id));
    onConfirm(picks);
  };

  const count = selected.size;

  // Order PROVIDERS by index but split by kind for sectioning.
  const cliProviders = PROVIDERS.filter((p) => p.kind === "cli");
  const apiProviders = PROVIDERS.filter((p) => p.kind === "api");

  // Map each provider to its global reveal index so the stagger
  // walks through CLI → API in source order, not section order.
  const indexById = new Map(PROVIDERS.map((p, i) => [p.id, i]));

  const renderSection = (title: string, list: ProviderDef[]) => (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "10px 10px 4px",
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--m-text-3)",
        }}
      >
        {title}
      </div>
      {list.map((p) => {
        const idx = indexById.get(p.id) ?? 0;
        const visible = idx < revealed;
        const isSelected = selected.has(p.id);
        return (
          <ProviderRow
            key={p.id}
            provider={p}
            visible={visible}
            selected={isSelected}
            scan={scan}
            onToggle={() => toggle(p.id)}
          />
        );
      })}
    </div>
  );

  return (
    <div
      style={{
        marginTop: 12,
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.02)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.025) inset, 0 6px 20px rgba(0,0,0,0.28)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "0 4px 6px", display: "flex", flexDirection: "column" }}>
        {renderSection("CLI", cliProviders)}
        {renderSection("API key", apiProviders)}
      </div>

      {/* Footer — hairline + counter + Continue */}
      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.05)",
          padding: "7px 10px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "rgba(0,0,0,0.18)",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--m-text-3)", flex: 1 }}>
          {count === 0 ? "None selected" : `${count} selected`}
        </span>
        <button
          onClick={confirm}
          disabled={count === 0}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 26,
            padding: "0 11px",
            borderRadius: 5,
            fontSize: 11.5,
            fontWeight: 600,
            background: count > 0 ? "#fff" : "rgba(255,255,255,0.05)",
            color: count > 0 ? "#000" : "var(--m-text-3)",
            border: "none",
            cursor: count > 0 ? "pointer" : "not-allowed",
            transition: "background 0.15s ease, transform 0.12s ease",
          }}
          onMouseEnter={(e) => {
            if (count === 0) return;
            e.currentTarget.style.transform = "translateY(-0.5px)";
          }}
          onMouseLeave={(e) => {
            if (count === 0) return;
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          Continue
          <ArrowRight size={10} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  visible,
  selected,
  scan,
  onToggle,
}: {
  provider: ProviderDef;
  visible: boolean;
  selected: boolean;
  /** Pre-fetched scan snapshot. When non-null we render a small
   *  "Installed" / "Not installed" / "Key found" / "Add key" hint
   *  next to the row name so the user knows up front what they're
   *  signing up for — no surprise during the verification step. */
  scan: ProviderScan | null;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  const showSurface = selected || hover;
  const installInfo = scan ? getInstallInfo(provider, scan) : null;

  return (
    <button
      onClick={() => visible && onToggle()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={!visible}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 10px",
        height: 28,
        margin: "1px 0",
        borderRadius: 5,
        background: showSurface ? "var(--secondary)" : "transparent",
        border: "none",
        color: "var(--m-text)",
        cursor: visible ? "pointer" : "default",
        textAlign: "left",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(2px)",
        transition:
          "opacity 0.22s ease, transform 0.22s ease, background 0.12s ease",
      }}
    >
      <ProviderLogo tool={provider.logo} size={12} />
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          lineHeight: 1,
          color: "var(--c-high)",
          flex: 1,
        }}
      >
        {provider.label}
      </span>
      {installInfo && (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 500,
            lineHeight: 1,
            // Green dot for present, dim grey for missing — same
            // colour language the StatusPill uses below the row,
            // so the picker and the verifier feel like one system.
            color: installInfo.ready ? "rgba(74, 222, 128, 0.92)" : "var(--m-text-3)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: installInfo.ready ? "rgba(74, 222, 128, 0.92)" : "var(--m-text-3)",
              opacity: installInfo.ready ? 1 : 0.7,
              flexShrink: 0,
            }}
          />
          {installInfo.label}
        </span>
      )}
      {/* Selected-only check on the right; nothing reserved when unpicked
          so the row reads cleaner. */}
      {selected && (
        <Check
          size={11}
          strokeWidth={2.6}
          style={{ color: "var(--m-text)", flexShrink: 0 }}
        />
      )}
    </button>
  );
}

// Computes the "Installed / Not installed" hint shown next to each
// provider name in the picker. Different providers have different
// notions of "ready":
//   • CLI tools     → binary is on PATH (scan.<key>.installed)
//   • Ollama        → daemon answers at localhost:11434 (running)
//   • API keys      → matching env var is set
function getInstallInfo(p: ProviderDef, scan: ProviderScan): { ready: boolean; label: string } {
  if (p.scanKey) {
    const s = scan[p.scanKey];
    return s.installed
      ? { ready: true,  label: "Installed" }
      : { ready: false, label: "Not installed" };
  }
  if (p.ollama) {
    return scan.ollama.running
      ? { ready: true,  label: "Running" }
      : { ready: false, label: "Not installed" };
  }
  if (p.envKey) {
    return scan.env_keys[p.envKey]
      ? { ready: true,  label: "Key found" }
      : { ready: false, label: "Add key" };
  }
  return { ready: false, label: "" };
}

/* ── Scan widget — sequential per-provider verification ────
   One row per chosen provider. While a provider is verifying,
   its row shows a spinner; on resolve it flips to a colored
   status pill. Earlier providers stay visible with their final
   state so the user can see the whole roll-up.                       */
type ScanStatus = "pending" | "running" | "ok" | "warn" | "fail";

interface ProviderState {
  status: ScanStatus;
  detail: string;
}

function ScanWidget({
  providers,
  scan,
  frozen = false,
}: {
  providers: ProviderDef[];
  scan: ProviderScan | null;
  frozen?: boolean;
}) {
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  // Track which provider rows are currently signing in so concurrent
  // clicks don't double-spawn the auth PTY.
  const signingInRef = useRef<Set<string>>(new Set());
  // Same idea for install: prevents a double-click while npm install
  // is already in flight — that would queue two long-running spawns
  // back-to-back and confuse the row's state machine.
  const installingRef = useRef<Set<string>>(new Set());
  // Captured OAuth URLs, keyed by toolKey ("gemini_cli" / "claude_cli"
  // / "codex_cli"). Pushed from main.cjs's auth-pty as soon as it
  // spots the URL in the CLI's output. ScanRow surfaces a clickable
  // "re-open browser" icon while the URL is known, so the user can
  // recover if they accidentally close the auth tab.
  const [authUrls, setAuthUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!window.electronAPI?.onAuthUrl) return;
    const off = window.electronAPI.onAuthUrl(({ toolKey, url }) => {
      setAuthUrls((prev) => ({ ...prev, [toolKey]: url }));
    });
    return off;
  }, []);

  useEffect(() => {
    if (frozen) return;
    let cancelled = false;

    const init: Record<string, ProviderState> = {};
    providers.forEach((p) => {
      init[p.id] = { status: "pending", detail: "" };
    });
    setStates(init);

    const run = async () => {
      // Refreshable scan reference — we re-fetch after auto-install
      // so the row reflects post-install state instead of staying
      // on the original "Not installed" snapshot.
      let currentScan = scan;

      for (const p of providers) {
        if (cancelled) return;
        setStates((prev) => ({
          ...prev,
          [p.id]: { status: "running", detail: "Verifying…" },
        }));
        await new Promise((r) => setTimeout(r, PROVIDER_VERIFY_MS - 250));
        if (cancelled) return;

        let result = resolveProvider(p, currentScan);

        // ── Auto-install for missing CLIs ──
        // If a CLI provider (Claude / Codex / Gemini) isn't installed,
        // fire installProvider() immediately and refresh the scan
        // before we settle. The user picked it — they want it. Skip
        // for non-CLI rows (Ollama / API keys) where installation is
        // out-of-scope for npm.
        const isMissingCli =
          result.status === "fail" &&
          /not installed/i.test(result.detail) &&
          p.scanKey;

        if (isMissingCli) {
          if (!window.electronAPI?.installProvider) {
            console.warn("[fleet] electronAPI.installProvider missing — skipping auto-install");
          } else {
            setStates((prev) => ({
              ...prev,
              [p.id]: { status: "running", detail: "Installing…" },
            }));
            try {
              const installRes = await window.electronAPI.installProvider(p.scanKey!);
              if (cancelled) return;
              if (installRes?.success) {
                // Re-scan so resolveProvider sees the fresh installed
                // (and possibly already-authenticated) flag.
                const fresh = await apiScanProviders().catch(() => null);
                if (cancelled) return;
                if (fresh) {
                  currentScan = fresh;
                  result = resolveProvider(p, fresh);
                }
              } else {
                result = {
                  status: "fail",
                  detail: installRes?.error?.split("\n")[0]?.slice(0, 60) || "Install failed",
                };
              }
            } catch (e) {
              console.error("[fleet] installProvider threw:", e);
              result = {
                status: "fail",
                detail: e instanceof Error ? e.message.slice(0, 60) : "Install failed",
              };
            }
          }
        }

        setStates((prev) => ({ ...prev, [p.id]: result }));
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [providers, scan, frozen]);

  // ── Sign-in handler ──
  // Spawns the CLI's auth flow via electronAPI.authProvider (which
  // runs the binary in a hidden PTY and auto-opens the OAuth URL it
  // prints). Concurrently polls /providers/scan every 2 s; the row
  // flips to ✓ Ready as soon as the auth flag turns true. Whichever
  // arrives first — PTY exit or the scan flip — wins. Hard timeout
  // at 120 s so a half-completed browser flow doesn't spin forever.
  const handleSignIn = async (p: ProviderDef) => {
    if (!p.scanKey) return;
    if (signingInRef.current.has(p.id)) return;
    signingInRef.current.add(p.id);

    setStates((prev) => ({
      ...prev,
      [p.id]: { status: "running", detail: "Authenticating…" },
    }));

    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const flipReady = () => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      signingInRef.current.delete(p.id);
      setStates((prev) => ({
        ...prev,
        [p.id]: { status: "ok", detail: "Ready" },
      }));
    };

    const flipFail = (detail: string) => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      signingInRef.current.delete(p.id);
      setStates((prev) => ({
        ...prev,
        [p.id]: { status: "warn", detail },
      }));
    };

    // Poll the scan API every 2 s — the source of truth for auth.
    pollTimer = setInterval(async () => {
      const fresh = await apiScanProviders().catch(() => null);
      if (!fresh || !p.scanKey) return;
      const s = fresh[p.scanKey];
      if (s.installed && s.authenticated) flipReady();
    }, 2000);

    // Hard timeout — main.cjs also kills the PTY at 120 s, but cap
    // the UI side here too so we always settle within ~125 s.
    const timeout = setTimeout(() => flipFail("Try Settings to finish"), 120_000);

    // Defensive: if main.cjs hasn't loaded the new shell:authProvider
    // handler (i.e. the user hot-reloaded the renderer but didn't
    // restart the Electron main process), authProvider will be
    // undefined and the optional-chain call would silently no-op.
    // Surface that as a real error rather than leaving the row
    // stuck on "Complete in your browser…" while nothing happens.
    if (!window.electronAPI?.authProvider) {
      clearTimeout(timeout);
      console.warn("[fleet] electronAPI.authProvider missing — main process needs restart");
      flipFail("Restart Fleet (Cmd+Q) to enable Sign in");
      return;
    }

    try {
      console.log("[fleet] authProvider →", p.scanKey);
      const result = await window.electronAPI.authProvider(p.scanKey);
      console.log("[fleet] authProvider result:", result);
      if (!result?.ok) {
        clearTimeout(timeout);
        flipFail(result?.error || "Couldn't open Terminal");
        return;
      }
      // CLI is running in a hidden PTY; main.cjs already opened
      // the OAuth URL it printed. We keep the label as
      // "Authenticating…" the whole way through — once the URL
      // has been pushed via fleet:auth-url, the row also surfaces
      // a clickable re-open icon so the user can recover if they
      // close the browser tab. The poll watches /providers/scan
      // for the auth flag flipping true and resolves the row.
      // No label change needed here.
    } catch (e) {
      clearTimeout(timeout);
      console.error("[fleet] authProvider threw:", e);
      flipFail(e instanceof Error ? e.message : "Sign-in failed");
    }
  };

  // ── Install handler ──
  // Race-based completion detection. We start TWO signals in parallel:
  //
  //   1. /providers/scan poll (every 2 s) — primary success signal.
  //      The backend's shutil.which("codex"|"gemini"|"claude") checks
  //      whether the new shim is on PATH; that's the source of truth.
  //      Wins as soon as npm has finished writing the .cmd / bin.
  //
  //   2. installProvider IPC — secondary, used for error reporting.
  //      On Windows with shell:true, the wrapping cmd.exe has been
  //      observed to keep stdio open past the inner npm.cmd's actual
  //      completion, so awaiting the IPC alone could leave the row
  //      stuck on "Installing…" indefinitely. We don't want to block
  //      the UI on that, but we DO want IPC's exit code if install
  //      fails (so the user sees the npm error, not a generic
  //      timeout).
  //
  // Whichever signal lands first wins; subsequent ones are ignored.
  // Hard 5-minute timeout caps the worst case.
  const handleInstall = async (p: ProviderDef) => {
    if (!p.scanKey) return;
    if (installingRef.current.has(p.id)) return;
    installingRef.current.add(p.id);

    setStates((prev) => ({
      ...prev,
      [p.id]: { status: "running", detail: "Installing…" },
    }));

    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      installingRef.current.delete(p.id);
    };

    const flipReady = (fresh: ProviderScan | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (fresh) {
        // resolveProvider returns "warn — Sign-in needed" for an
        // installed-but-unauthed CLI, which is the expected state
        // right after npm install lands. The Sign In button takes
        // over for the second leg.
        const next = resolveProvider(p, fresh);
        setStates((prev) => ({ ...prev, [p.id]: next }));
      } else {
        // Scan blipped during the flip — assume installed but not
        // authed so the Sign In button still appears.
        setStates((prev) => ({
          ...prev,
          [p.id]: { status: "warn", detail: "Sign-in needed" },
        }));
      }
    };

    const flipFail = (detail: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      setStates((prev) => ({ ...prev, [p.id]: { status: "fail", detail } }));
    };

    // Primary signal — poll the scan API for the installed flag.
    pollTimer = setInterval(async () => {
      const fresh = await apiScanProviders().catch(() => null);
      if (!fresh || !p.scanKey) return;
      const s = fresh[p.scanKey];
      if (s.installed) flipReady(fresh);
    }, 2000);

    // Hard timeout — caps "Installing…" at 5 min so a wedged spawn
    // doesn't leave the row stuck. Main.cjs has its own 10-min kill
    // timer too as a second line of defense.
    timeoutTimer = setTimeout(() => {
      flipFail("Install took too long — try again or use Settings");
    }, 5 * 60_000);

    if (!window.electronAPI?.installProvider) {
      console.warn("[fleet] electronAPI.installProvider missing — main process needs restart");
      flipFail("Restart Fleet to enable Install");
      return;
    }

    // Secondary signal — IPC. We don't BLOCK on this for success
    // detection (the poll handles that); we just want its error if
    // npm itself fails.
    try {
      console.log("[fleet] installProvider →", p.scanKey);
      const result = await window.electronAPI.installProvider(p.scanKey);
      console.log("[fleet] installProvider result:", result);
      if (resolved) return; // poll already won
      if (!result?.success) {
        const raw = result?.error || "Install failed";
        const detail = (raw.split("\n")[0] ?? raw).slice(0, 80);
        flipFail(detail);
        return;
      }
      // IPC says success, poll hasn't caught up yet (rare): re-scan
      // once more to grab fresh state for resolveProvider.
      const fresh = await apiScanProviders().catch(() => null);
      flipReady(fresh);
    } catch (e) {
      console.error("[fleet] installProvider threw:", e);
      if (resolved) return;
      flipFail(e instanceof Error ? e.message.slice(0, 80) : "Install failed");
    }
  };

  // ── Ollama install handler ──
  // Runs Ollama's official platform installer directly — same
  // commands the user would paste from ollama.com/download:
  //   • Windows  → powershell  irm | iex
  //   • macOS    → curl … | sh
  //   • Linux    → curl … | sh
  //
  // Same race pattern as handleInstall: the scan poll is the primary
  // success signal (detects the Ollama daemon coming up at
  // localhost:11434), while the IPC is just for error reporting if
  // the installer itself fails. This way a long-running PowerShell
  // pipeline whose stdio is held open after install completion can't
  // leave the row stuck on "Installing…".
  const handleDownloadOllama = async (p: ProviderDef) => {
    if (installingRef.current.has(p.id)) return;
    installingRef.current.add(p.id);

    setStates((prev) => ({
      ...prev,
      [p.id]: { status: "running", detail: "Installing Ollama…" },
    }));

    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      installingRef.current.delete(p.id);
    };

    const flipReady = (fresh: ProviderScan | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const next = fresh
        ? resolveProvider(p, fresh)
        : { status: "ok" as ScanStatus, detail: "Ready" };
      setStates((prev) => ({ ...prev, [p.id]: next }));
    };

    const flipFail = (detail: string, status: ScanStatus = "fail") => {
      if (resolved) return;
      resolved = true;
      cleanup();
      setStates((prev) => ({ ...prev, [p.id]: { status, detail } }));
    };

    // Primary signal — poll the scan for ollama.running going true.
    pollTimer = setInterval(async () => {
      const fresh = await apiScanProviders().catch(() => null);
      if (!fresh) return;
      if (fresh.ollama?.running) flipReady(fresh);
    }, 2000);

    // Generous timeout — Ollama's installer downloads ~hundreds of
    // MB and registers a system service. 10 min covers slow networks.
    timeoutTimer = setTimeout(() => {
      flipFail("Install took too long — finish from ollama.com/download", "warn");
    }, 10 * 60_000);

    if (!window.electronAPI?.installOllama) {
      console.warn("[fleet] electronAPI.installOllama missing — main process needs restart");
      flipFail("Restart Fleet to enable Install");
      return;
    }

    // Secondary signal — IPC. Carries the package-manager exit code
    // so we can surface a real error if PowerShell / curl fails.
    try {
      console.log("[fleet] installOllama →");
      const installResult = await window.electronAPI.installOllama();
      console.log("[fleet] installOllama result:", installResult);
      if (resolved) return; // poll already won

      if (installResult?.openedBrowser) {
        // Main couldn't run a platform installer; it opened the
        // download page instead. Keep polling — the user might
        // finish manually in the next few minutes.
        setStates((prev) => ({
          ...prev,
          [p.id]: { status: "warn", detail: "Finish install in your browser…" },
        }));
        return;
      }

      if (!installResult?.success) {
        const raw = installResult?.error || "Install failed";
        const detail = (raw.split("\n")[0] ?? raw).slice(0, 80);
        flipFail(detail);
        return;
      }

      // Installer reports success; daemon may still be starting.
      // Surface "Starting Ollama…" while the poll keeps watching for
      // the API to answer at localhost:11434.
      setStates((prev) => ({
        ...prev,
        [p.id]: { status: "running", detail: "Starting Ollama…" },
      }));
    } catch (e) {
      console.error("[fleet] installOllama threw:", e);
      if (resolved) return;
      flipFail(e instanceof Error ? e.message.slice(0, 80) : "Install failed");
    }
  };

  return (
    <div
      style={{
        marginTop: 12,
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.02)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.025) inset, 0 6px 20px rgba(0,0,0,0.28)",
        overflow: "hidden",
        padding: 4,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {providers.map((p) => {
        const st = states[p.id] ?? { status: "pending" as ScanStatus, detail: "" };
        // Each row reads ONLY its own provider's URL — keyed by
        // scanKey ("gemini_cli" / "claude_cli" / "codex_cli") so
        // simultaneous sign-ins for two providers each get their
        // own re-open icon pointing at the right URL.
        const authUrl = p.scanKey ? authUrls[p.scanKey] : undefined;
        return (
          <ScanRow
            key={p.id}
            provider={p}
            state={st}
            authUrl={authUrl}
            onSignIn={p.scanKey ? () => handleSignIn(p) : undefined}
            onInstall={p.scanKey ? () => handleInstall(p) : undefined}
            onDownload={p.ollama ? () => handleDownloadOllama(p) : undefined}
          />
        );
      })}
    </div>
  );
}

function ScanRow({
  provider,
  state,
  authUrl,
  onSignIn,
  onInstall,
  onDownload,
}: {
  provider: ProviderDef;
  state: ProviderState;
  /** OAuth URL captured by main.cjs's auth-pty for this provider —
   *  populated only while a Sign in flow is in flight. When set,
   *  StatusPill renders a clickable ExternalLink icon (left of the
   *  "Authenticating…" label) that re-opens the URL in the browser
   *  via shell.openExternal. Lets the user recover from accidentally
   *  closing the auth tab without re-spawning the whole PTY. */
  authUrl?: string;
  onSignIn?: () => void;
  onInstall?: () => void;
  onDownload?: () => void;
}) {
  // ── Action button selection ──
  // Three mutually-exclusive CTAs share the same slot in the row:
  //
  //   • Install   — CLI provider whose binary isn't on PATH yet.
  //                 Runs `npm install -g <pkg>` via electronAPI.
  //   • Download  — Ollama specifically. We hand off to ollama.com
  //                 because it ships as a native installer, not npm.
  //   • Sign in   — CLI is installed but not authenticated yet.
  //                 Spawns the auth PTY (handleSignIn).
  //
  // Selection order: a "fail" CLI row offers Install/Download (the
  // user can't sign in to something that isn't installed), and any
  // "warn" row offers Sign in. Sign in is hidden during running/ok
  // so we don't double-up with the spinner / check.
  const isFailedInstall =
    state.status === "fail" &&
    /not installed|install failed|enoent|not found/i.test(state.detail);
  const showInstall  = !!onInstall  && isFailedInstall;
  const showDownload = !!onDownload && state.status === "fail";
  const showSignIn   = !!onSignIn   && state.status === "warn" && !showInstall && !showDownload;

  // Show the re-open icon only while we're actively waiting on a
  // sign-in (status running) AND main has handed us a URL. Once the
  // row flips to ok / warn / fail the icon disappears with the
  // running spinner.
  const reopenUrl = authUrl && state.status === "running" ? authUrl : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 10px",
        height: 34,
        borderRadius: 6,
        opacity: state.status === "pending" ? 0.4 : 1,
        transition: "opacity 0.3s ease",
      }}
    >
      <ProviderLogo tool={provider.logo} size={13} />
      <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1, color: "var(--c-high)" }}>
        {provider.label}
      </span>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
        {showInstall  && <ActionButton label="Install"  onClick={onInstall!}  />}
        {showDownload && <ActionButton label="Download" onClick={onDownload!} />}
        {showSignIn   && <ActionButton label="Sign in"  onClick={onSignIn!}   />}
        <StatusPill state={state} reopenUrl={reopenUrl} />
      </div>
    </div>
  );
}

// One button visual, multiple labels — keeps the action column
// rhythmically consistent across Install / Download / Sign in.
function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 22,
        padding: "0 9px",
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 600,
        background: hover ? "#fff" : "rgba(255,255,255,0.85)",
        color: "#000",
        border: "none",
        cursor: "pointer",
        transition: "background 0.12s ease, transform 0.12s ease",
      }}
    >
      {label}
    </button>
  );
}

function StatusPill({
  state,
  reopenUrl,
}: {
  state: ProviderState;
  /** Set while a sign-in is in progress AND main has handed us the
   *  captured OAuth URL. When set, we replace the "running" spinner
   *  with a clickable ExternalLink so the user can re-open the auth
   *  tab if they closed it by accident. */
  reopenUrl?: string | null;
}) {
  const { status, detail } = state;
  // Neutral text, only the leading dot/icon carries the colour cue.
  // Reads cleaner than the saturated chip-bg version and stays
  // out of the row's visual hierarchy.
  const labelMap: Record<ScanStatus, string> = {
    pending: "Pending",
    running: detail || "Verifying…",
    ok:      detail || "Ready",
    warn:    detail || "Action needed",
    fail:    detail || "Not available",
  };
  const label = labelMap[status];
  const color =
    status === "running" || status === "pending" ? "var(--m-text-3)" : "var(--m-text-2)";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 500,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {reopenUrl
        ? <ReopenAuthButton url={reopenUrl} />
        : <StatusDot status={status} />}
      <span>{label}</span>
    </span>
  );
}

// Small icon button shown in place of the running spinner once the
// auth-pty has handed us the OAuth URL. Click → re-open the same URL
// in the user's default browser. The hover treatment makes it
// obvious this is interactive even at 11 px.
function ReopenAuthButton({ url }: { url: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title="Re-open sign-in in browser"
      aria-label="Re-open sign-in in browser"
      onClick={() => {
        if (window.electronAPI?.openExternal) {
          window.electronAPI.openExternal(url).catch(() => {});
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        padding: 0,
        borderRadius: 4,
        background: hover ? "rgba(255,255,255,0.10)" : "transparent",
        border: "none",
        color: hover ? "var(--m-text)" : "var(--m-text-2)",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 0.12s ease, color 0.12s ease",
      }}
    >
      <ExternalLink size={10} strokeWidth={2.2} />
    </button>
  );
}

function StatusDot({ status }: { status: ScanStatus }) {
  // The icon is the only thing that carries colour. Tones are muted
  // (≈ 0.85 alpha equivalent) so the row doesn't look like a CI dashboard.
  const okColor   = "rgba(74, 222, 128, 0.92)";
  const warnColor = "rgba(245, 158, 11, 0.92)";
  const failColor = "rgba(248, 113, 113, 0.92)";

  if (status === "running") {
    return (
      <Loader2
        size={10}
        style={{
          animation: "spin 1s linear infinite",
          color: "var(--m-text-3)",
          flexShrink: 0,
        }}
      />
    );
  }
  if (status === "ok") {
    return <Check size={11} strokeWidth={2.8} style={{ color: okColor, flexShrink: 0 }} />;
  }
  if (status === "fail") {
    return <X size={10} strokeWidth={2.8} style={{ color: failColor, flexShrink: 0 }} />;
  }
  if (status === "warn") {
    return (
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: warnColor,
          flexShrink: 0,
        }}
      />
    );
  }
  // pending — dim
  return (
    <span
      style={{
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: "var(--m-text-3)",
        flexShrink: 0,
      }}
    />
  );
}

function resolveProvider(p: ProviderDef, scan: ProviderScan | null): ProviderState {
  if (!scan) return { status: "fail", detail: "Scan unreachable" };
  if (p.scanKey) {
    const s = scan[p.scanKey];
    if (s.installed && s.authenticated) return { status: "ok", detail: "Ready" };
    if (s.installed) return { status: "warn", detail: "Sign-in needed" };
    return { status: "fail", detail: "Not installed" };
  }
  if (p.ollama) {
    if (!scan.ollama.running) return { status: "fail", detail: "Not running" };
    const n = scan.ollama.models.length;
    return { status: "ok", detail: n > 0 ? `Ready · ${n} model${n === 1 ? "" : "s"}` : "Ready · no models" };
  }
  if (p.envKey) {
    return scan.env_keys[p.envKey]
      ? { status: "ok", detail: "Key found" }
      : { status: "warn", detail: "Add key in Settings" };
  }
  return { status: "warn", detail: "Manual setup" };
}

function buildScanReadout(providers: ProviderDef[], scan: ProviderScan | null): string {
  if (!scan) {
    return "Couldn't reach the backend to verify — but you can finish setup any time from **Settings → Providers**.";
  }
  const states = providers.map((p) => ({ p, st: resolveProvider(p, scan) }));
  const ready = states.filter((s) => s.st.status === "ok");
  const needs = states.filter((s) => s.st.status !== "ok");

  if (needs.length === 0) {
    return providers.length === 1
      ? `**${providers[0]!.label}** is good to go — installed, signed in, and reachable.`
      : `All set — ${humanList(providers.map((p) => `**${p.label}**`))} are ready.`;
  }
  if (ready.length === 0) {
    const lines = needs.map((s) => `• **${s.p.label}** — ${s.st.detail}`).join("\n");
    return `Looks like a couple of things still need a touch:\n\n${lines}\n\nYou can finish setup from **Settings → Providers** any time.`;
  }
  const readyLine = humanList(ready.map((s) => `**${s.p.label}**`));
  const needLines = needs.map((s) => `• **${s.p.label}** — ${s.st.detail}`).join("\n");
  return `${readyLine} ${ready.length === 1 ? "is" : "are"} ready. A couple still need attention:\n\n${needLines}\n\nYou can finish those from **Settings → Providers** whenever.`;
}

function humanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/* ── GitHub widget — same panel chrome as providers/scan ─── */
/* ── Main-agent widget — single-select radio list ────────── */
function MainAgentWidget({
  providers,
  onPick,
}: {
  providers: ProviderDef[];
  onPick: (p: ProviderDef) => void;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.02)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.025) inset, 0 6px 20px rgba(0,0,0,0.28)",
        overflow: "hidden",
        padding: 4,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {providers.map((p) => (
        <MainAgentRow key={p.id} provider={p} onPick={() => onPick(p)} />
      ))}
    </div>
  );
}

function MainAgentRow({
  provider,
  onPick,
}: {
  provider: ProviderDef;
  onPick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 10px",
        height: 34,
        margin: "1px 0",
        borderRadius: 5,
        background: hover ? "var(--secondary)" : "transparent",
        border: "none",
        color: "var(--m-text)",
        cursor: "pointer",
        textAlign: "left",
        transition: "background 0.12s ease",
      }}
    >
      <ProviderLogo tool={provider.logo} size={13} />
      <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1, color: "var(--c-high)" }}>
        {provider.label}
      </span>
    </button>
  );
}

/** Assistant copy for the GitHub step. Two variants:
 *
 *   - existingGithub.username present → ask if the user wants to
 *     use the gh-CLI account already on the machine. Single tap to
 *     accept, no PAT generation needed.
 *   - null (probed, nothing signed in) OR undefined (probe still
 *     in flight) → fall back to the manual generate-token path.
 *
 * We treat "still probing" as the manual path because by the time
 * the user reaches the GitHub step (after picker reveal + scan
 * animations) the probe almost always finished. If it's still
 * running it usually means gh isn't installed at all. */
function githubIntroCopy(existing: { username: string } | null | undefined): string {
  if (existing) {
    return `Spotted **@${existing.username}** signed in via your gh CLI. Want Fleet to use that account for PRs and repo context, or paste a different token?`;
  }
  return "Want to connect **GitHub**? Fleet uses it to pull repo context, draft PRs, and read issues directly. Totally optional.";
}

/* ── GitHub widget — two flows depending on existing gh auth ──
   When the gh CLI on this machine reports a logged-in user, we
   skip the token-paste UX entirely and offer a one-tap "Use
   @<login>" alongside an escape hatch to paste a different PAT.

   Otherwise: same generate → paste → connect flow as before — the
   generate-token button collapses into a token input on click,
   same row, same height, no layout jump. */
function GithubWidget({
  onResult,
  existingUsername,
}: {
  onResult: (
    result:
      | { method: "cli"; username?: string }
      | { method: "oauth"; username?: string }
      | { skipped: true },
  ) => void;
  /** Pre-probed gh CLI login (if any). Drives the "GitHub CLI" button's
   *  badge — when set, the button reads "Use GitHub CLI · @<login>" and
   *  picking it is a single-tap (no terminal launch). */
  existingUsername?: string;
}) {
  // Probe gh CLI presence + auth state on mount. Drives the "GitHub
  // CLI" button's three states: Not Installed / Sign in & connect /
  // Use GitHub CLI · @<login>.
  type CliState =
    | { kind: "probing" }
    | { kind: "missing" }
    | { kind: "needs-auth" }
    | { kind: "ready"; login: string };
  const initial: CliState = existingUsername
    ? { kind: "ready", login: existingUsername }
    : { kind: "probing" };
  const [cliState, setCliState] = useState<CliState>(initial);
  // Active in-flight choice: "oauth" or "cli". Keeps the other button
  // disabled while one is running so the user can't double-click.
  const [pending, setPending] = useState<"oauth" | "cli" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Polling cancel handle for the gh-auth-login waiter.
  const pollCancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  // The one-time device code + verification URL captured live from
  // `gh auth login --web`. Surfaced in the picker so the user never has
  // to leave the app to read them. Cleared between attempts.
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  // Unsubscribe handle for onGhAuthEvent — kept on a ref so cleanup
  // works whether the flow resolves, errors, or the user cancels.
  const ghEventUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (existingUsername) return; // pre-probed by parent
    let cancelled = false;
    (async () => {
      try {
        const r = await window.electronAPI?.hasGhCli?.();
        if (cancelled) return;
        if (!r || !r.ok) {
          setCliState({ kind: "missing" });
          return;
        }
        if (r.authed && r.ghLogin) {
          setCliState({ kind: "ready", login: r.ghLogin });
        } else {
          setCliState({ kind: "needs-auth" });
        }
      } catch {
        if (!cancelled) setCliState({ kind: "missing" });
      }
    })();
    return () => {
      cancelled = true;
      pollCancelRef.current.cancelled = true;
    };
  }, [existingUsername]);

  // ── "Use GitHub CLI" handler ───────────────────────────────
  // Three branches mirroring cliState:
  //   • missing    — button disabled (caller blocked at the UI layer)
  //   • ready      — single-tap accept
  //   • needs-auth — spawn `gh auth login --web` under an in-process PTY
  //                  and surface the one-time device code inside the app
  //                  via the `gh-auth-event` stream. Resolves once gh
  //                  reports phase="done".
  const pickGhCli = async () => {
    setError(null);
    if (cliState.kind === "ready") {
      onResult({ method: "cli", username: cliState.login });
      return;
    }
    if (cliState.kind !== "needs-auth") return;

    setPending("cli");
    setDeviceCode(null);
    setVerifyUrl(null);
    pollCancelRef.current = { cancelled: false };

    // Subscribe to gh's progress before we kick off the spawn — gh prints
    // the one-time code within the first second, so we can't afford to
    // attach the listener after the awaited call returns.
    try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
    ghEventUnsubRef.current = window.electronAPI?.onGhAuthEvent?.((ev) => {
      if (pollCancelRef.current.cancelled) return;
      if (ev.phase === "code") {
        setDeviceCode(ev.code);
      } else if (ev.phase === "url") {
        setVerifyUrl(ev.url);
        // Open the browser ourselves the moment we know the URL so the
        // user doesn't have to wait for gh's own browser hand-off.
        try { window.electronAPI?.openExternal?.(ev.url); } catch { /* best effort */ }
      } else if (ev.phase === "done") {
        if (ev.ok && ev.login) {
          setCliState({ kind: "ready", login: ev.login });
          setPending(null);
          try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
          ghEventUnsubRef.current = null;
          onResult({ method: "cli", username: ev.login });
        } else if (!ev.ok) {
          setError(ev.error || "gh auth didn't complete.");
          setPending(null);
        }
      }
    }) || null;

    try {
      const r = await window.electronAPI?.ghAuthLoginCapture?.();
      // The "done" event already drove the success path. We only land
      // here for the error case — guard against double-handling.
      if (r && !r.ok && !pollCancelRef.current.cancelled) {
        setError(r.error || "Couldn't run gh auth login.");
        setPending(null);
      }
    } catch (e) {
      if (!pollCancelRef.current.cancelled) {
        setError(e instanceof Error ? e.message : "Couldn't start gh auth.");
        setPending(null);
      }
    } finally {
      try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
      ghEventUnsubRef.current = null;
    }
  };

  // Cancel button: kill the gh child + tear down the listener so the
  // user can pick OAuth (or Skip) without a zombie process holding a
  // device code slot.
  const cancelGhCli = async () => {
    pollCancelRef.current.cancelled = true;
    try { await window.electronAPI?.ghAuthLoginCancel?.(); } catch { /* best effort */ }
    try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
    ghEventUnsubRef.current = null;
    setPending(null);
    setDeviceCode(null);
    setVerifyUrl(null);
  };

  // Tear the listener down on unmount so a half-finished flow can't keep
  // firing into a dead component.
  useEffect(() => {
    return () => {
      try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
      ghEventUnsubRef.current = null;
    };
  }, []);

  // ── "Connect with GitHub" (Fleetify OAuth broker) ─────────
  const pickOAuth = async () => {
    setError(null);
    setPending("oauth");
    try {
      const r = await window.electronAPI?.github?.beginOAuth?.();
      if (r?.ok) {
        const login = r.link?.github_login;
        onResult({ method: "oauth", username: login });
        return;
      }
      setError(r?.error || "GitHub OAuth didn't complete.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub.");
    } finally {
      setPending(null);
    }
  };

  // Choice-row button — single-line, icon-left, title centered. Two
  // variants: "white" (Connect with GitHub) and "black" (Use GitHub CLI).
  // A "Not Installed" badge floats on the right when the gh CLI isn't
  // available; otherwise the row is pure icon + centered title.
  const ChoiceRow = ({
    icon,
    title,
    onClick,
    disabled,
    loading,
    badge,
    variant,
  }: {
    icon: React.ReactNode;
    title: string;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    badge?: string;
    variant?: "white" | "black";
  }) => {
    const isWhite = variant === "white";
    const isBlack = variant === "black";
    const baseBg = isWhite ? "#fff" : isBlack ? "#000" : "rgba(255,255,255,0.025)";
    const hoverBg = isWhite ? "#f1f1f1" : isBlack ? "#111" : "rgba(255,255,255,0.08)";
    const baseBorder = isWhite
      ? "rgba(0,0,0,0.08)"
      : isBlack
        ? "rgba(255,255,255,0.12)"
        : "rgba(255,255,255,0.08)";
    const hoverBorder = isWhite
      ? "rgba(0,0,0,0.16)"
      : isBlack
        ? "rgba(255,255,255,0.22)"
        : "rgba(255,255,255,0.18)";
    const textColor = isWhite ? "#000" : isBlack ? "#fff" : "var(--m-text)";
    const iconColor = isWhite ? "#000" : isBlack ? "#fff" : "var(--m-text-2)";
    const badgeBg = isWhite
      ? "rgba(0,0,0,0.06)"
      : isBlack
        ? "rgba(255,255,255,0.10)"
        : "rgba(255,255,255,0.05)";
    const badgeColor = isWhite
      ? "rgba(0,0,0,0.7)"
      : isBlack
        ? "rgba(255,255,255,0.75)"
        : "var(--m-text-3)";

    return (
      <button
        onClick={onClick}
        disabled={disabled || loading}
        style={{
          width: "100%",
          position: "relative",
          display: "flex",
          alignItems: "center",
          height: 40,
          padding: "0 13px",
          background: baseBg,
          border: `1px solid ${baseBorder}`,
          borderRadius: 8,
          color: textColor,
          fontSize: 13,
          fontWeight: 600,
          cursor: disabled || loading ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          transition: "background 0.12s ease, border-color 0.12s ease",
          fontFamily: "inherit",
        }}
        onMouseEnter={e => {
          if (disabled || loading) return;
          e.currentTarget.style.background = hoverBg;
          e.currentTarget.style.borderColor = hoverBorder;
        }}
        onMouseLeave={e => {
          if (disabled || loading) return;
          e.currentTarget.style.background = baseBg;
          e.currentTarget.style.borderColor = baseBorder;
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 13,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            color: iconColor,
          }}
        >
          {loading ? (
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
          ) : icon}
        </span>
        <span style={{ flex: 1, textAlign: "center" }}>{title}</span>
        {badge && (
          <span
            style={{
              position: "absolute",
              right: 10,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              padding: "3px 7px",
              borderRadius: 4,
              background: badgeBg,
              color: badgeColor,
            }}
          >
            {badge}
          </span>
        )}
      </button>
    );
  };

  // Derive the CLI row's copy from cliState. The row is intentionally
  // minimal — title + "Not Installed" badge only — so the picker stays
  // visually calm. Live progress (device code, waiting state) is shown
  // in a separate panel below the buttons.
  const cliLoading = pending === "cli";
  const cliDisabled =
    cliState.kind === "probing" ||
    cliState.kind === "missing" ||
    pending === "oauth";
  const cliTitle =
    cliState.kind === "ready" && cliState.login
      ? `Use GitHub CLI · @${cliState.login}`
      : "Use GitHub CLI";
  const cliBadge = cliState.kind === "missing" ? "Not Installed" : undefined;

  return (
    <div
      style={{
        marginTop: 12,
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.02)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.025) inset, 0 6px 20px rgba(0,0,0,0.28)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "11px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Github size={14} style={{ color: "var(--m-text)" }} />
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--c-high)" }}>
          GitHub
        </span>
        <span style={{ fontSize: 11, color: "var(--m-text-3)", marginLeft: "auto" }}>
          Pick one
        </span>
      </div>

      <div style={{ padding: "0 12px 11px", display: "flex", flexDirection: "column", gap: 7 }}>
        <ChoiceRow
          icon={<Github size={14} />}
          title="Connect with GitHub"
          onClick={pickOAuth}
          loading={pending === "oauth"}
          disabled={pending === "cli"}
          variant="white"
        />
        <ChoiceRow
          icon={<Terminal size={14} />}
          title={cliTitle}
          onClick={pickGhCli}
          loading={cliLoading}
          disabled={cliDisabled}
          badge={cliBadge}
          variant="black"
        />
      </div>

      {pending === "cli" && (
        <div
          style={{
            margin: "0 12px 11px",
            padding: "11px 12px",
            borderRadius: 8,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--m-text-3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 6,
            }}
          >
            {deviceCode ? "One-time code" : "Starting gh auth…"}
          </div>
          {deviceCode ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <code
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: "0.18em",
                  color: "var(--c-high)",
                  padding: "4px 10px",
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.06)",
                }}
              >
                {deviceCode}
              </code>
              <button
                onClick={() => {
                  try { window.electronAPI?.writeText?.(deviceCode); } catch { /* best effort */ }
                }}
                style={{
                  height: 24,
                  padding: "0 9px",
                  fontSize: 11,
                  fontWeight: 500,
                  borderRadius: 5,
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "var(--m-text-2)",
                  cursor: "pointer",
                }}
              >
                Copy
              </button>
              {verifyUrl && (
                <button
                  onClick={() => {
                    try { window.electronAPI?.openExternal?.(verifyUrl); } catch { /* best effort */ }
                  }}
                  style={{
                    height: 24,
                    padding: "0 9px",
                    fontSize: 11,
                    fontWeight: 500,
                    borderRadius: 5,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    background: "transparent",
                    border: "1px solid rgba(255,255,255,0.12)",
                    color: "var(--m-text-2)",
                    cursor: "pointer",
                  }}
                >
                  Open browser <ExternalLink size={10} />
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--m-text-2)", fontSize: 12 }}>
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
              Waiting for the device code…
            </div>
          )}
          {deviceCode && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--m-text-3)", lineHeight: 1.45 }}>
              Paste this code into the GitHub tab that just opened, then come back here — we'll continue automatically once you authorize.
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{
          padding: "0 12px 10px",
          fontSize: 11,
          color: "rgba(248,113,113,0.92)",
        }}>
          {error}
        </div>
      )}

      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.05)",
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(0,0,0,0.18)",
        }}
      >
        <button
          onClick={() => {
            pollCancelRef.current.cancelled = true;
            try { window.electronAPI?.ghAuthLoginCancel?.(); } catch { /* best effort */ }
            try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
            ghEventUnsubRef.current = null;
            onResult({ skipped: true });
          }}
          disabled={pending !== null}
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 26,
            padding: "0 11px",
            fontSize: 11.5,
            fontWeight: 500,
            borderRadius: 5,
            background: "transparent",
            border: "none",
            color: "var(--m-text-3)",
            cursor: pending !== null ? "not-allowed" : "pointer",
            opacity: pending !== null ? 0.5 : 1,
          }}
        >
          Skip — pick later
        </button>
        <div style={{ flex: 1 }} />
        {pending === "cli" && (
          <button
            onClick={() => {
              cancelGhCli();
              setError("Stopped waiting for gh auth.");
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              height: 26,
              padding: "0 11px",
              fontSize: 11.5,
              fontWeight: 500,
              borderRadius: 5,
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.10)",
              color: "var(--m-text-2)",
              cursor: "pointer",
            }}
          >
            Stop waiting
          </button>
        )}
      </div>
    </div>
  );
}

// Function intentionally left blank below — the legacy multi-stage PAT
// widget body has been replaced by the 3-button picker above. Removing
// the residual `} return (...)` would have made this diff sprawling; the
// shim keeps the new function self-contained.

function GithubResolved({
  username,
  skipped,
}: {
  username?: string;
  skipped: boolean;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.02)",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <Github size={13} style={{ color: "var(--m-text-2)" }} />
      <span style={{ fontSize: 12, color: "var(--c-high)", fontWeight: 500 }}>
        GitHub
      </span>
      <span
        style={{
          fontSize: 11,
          color: "var(--m-text-2)",
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {username ? (
          <>
            <Check size={11} strokeWidth={2.6} style={{ color: "rgba(74,222,128,0.92)" }} />
            <span>@{username}</span>
          </>
        ) : skipped ? (
          <span style={{ color: "var(--m-text-3)" }}>Skipped</span>
        ) : (
          <span style={{ color: "var(--m-text-3)" }}>—</span>
        )}
      </span>
    </div>
  );
}

/* ── Blinking type caret ───────────────────────────────────── */
function Caret() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 13,
        marginLeft: 2,
        verticalAlign: "-2px",
        background: "var(--m-text)",
        opacity: 0.65,
        animation: "fleet-caret-blink 1s steps(2, end) infinite",
        borderRadius: 1,
      }}
    />
  );
}
