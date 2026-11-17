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
import { type CSSProperties, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownLinkComponents } from "@/components/markdown-link";
import {
  ArrowRight,
  Check,
  Download,
  KeyRound,
  Loader2,
  X,
  Github,
  ExternalLink,
  Terminal,
} from "lucide-react";
import { LogoMark } from "@/components/brand/logo-mark";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { apiScanProviders, checkPythonRuntime, type ProviderScan, type AuthUser } from "@/lib/api";
import { getPlatform } from "@/lib/utils";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { providers as providersApi } from "@/lib/providers-api";
import type { ProviderTile } from "@/lib/providers-api";
import { modelsForTile } from "@/lib/picker-groups";
import type { PickerModel } from "@/lib/picker-groups";
import { useDiscoveredModelsStore } from "@/stores/discovered-models-store";
import { buildSelectionPersist } from "@/components/onboarding/provider-selection";
import { isProviderInstalled, type ScanCliKey } from "@/components/onboarding/provider-install-state";
import { STUDIO_ENABLED } from "@/lib/feature-flags";
import { useThemeStore, type ThemeMode } from "@/stores/theme-store";
import { ThemeModeCards } from "@/components/theme/theme-mode-cards";
import { capture, optIn, optOut } from "@/lib/posthog";
import { sendPrivacyChoice, type PrivacyChoiceOutcome } from "@/lib/privacy-choice";

interface Props {
  user: AuthUser | null;
  onDone: () => void;
  /** Tests only: open at the theme step, skipping the welcome, provider
   *  setup and GitHub. */
  startAt?: "theme";
}

type Sender = "assistant" | "user";

type WidgetKind =
  | "providers"
  | "scan"
  | "main-agent"
  | "github"
  | "theme"
  | "cloud-sync-consent"
  | "telemetry-consent";

// Onboarding primary-button colors, theme-aware via globals.css: gray on white
// in light, white on dark in dark (see --onb-btn-bg / --onb-btn-fg). Was a fixed
// neutral gray that read as a disabled/secondary button on the dark theme.
const ONB_BTN_BG = "var(--onb-btn-bg)";
const ONB_BTN_FG = "var(--onb-btn-fg)";

/** Which provider bucket a `providers` / `scan` widget is bound to. The
 *  onboarding runs selection then setup for Workspace first, then Studio. */
type ProviderPhase = "workspace" | "studio";

interface ChatMsg {
  id: string;
  sender: Sender;
  text: string;
  typing?: boolean;
  widget?: WidgetKind;
  /** For `providers` / `scan` widgets — which bucket (Workspace/Studio)
   *  this step covers. Absent on plain assistant bubbles. */
  phase?: ProviderPhase;
  resolved?: boolean;
}

interface ProviderDef {
  id: string;
  label: string;
  logo: string;
  /** Bucket — drives the section header in the picker. */
  kind: "cli" | "api";
  /** Display category. "workspace" (default when absent) covers the
   *  backend `providers::CATALOG` entries (CLI agents + API providers).
   *  "studio" covers image/video generation tools (Higgsfield etc.)
   *  that live in the Studio registry rather than the providers catalog.
   *  The picker renders workspace providers first, then studio ones. */
  category?: "workspace" | "studio";
  scanKey?: ScanCliKey;
  /** Optional env-var bucket on `scan.env_keys`. Only set when the
   *  scan probe actually checks for this provider's key — the four
   *  legacy buckets (anthropic / openai / gemini / groq) plus the
   *  SDK's reuse of `gemini`. New catalog providers (DeepSeek, Grok,
   *  Kimi API, Perplexity, NVIDIA NIM) don't have probes; their
   *  presence is tracked via `keysAdded[id]` after an inline save. */
  envKey?: keyof ProviderScan["env_keys"];
  ollama?: boolean;
  /** When true, the verify loop fires `installProvider()` automatically
   *  for this row if it's detected as not installed. Reserved for the
   *  fast, idempotent, well-known `npm install -g <pkg>` flow used by
   *  Claude / Codex / Gemini. Antigravity CLI (`agy`) runs a remote
   *  shell installer (`iex (irm ...)` / `curl|bash`) and the
   *  Antigravity SDK row has its own dedicated Setup affordance — both
   *  must wait for the user's explicit click instead of firing
   *  silently behind the verify spinner. */
  autoInstall?: boolean;
  /** Used in scan readouts only — the picker uses section grouping instead. */
  hint: string;
}

// Workspace entries MUST match the backend `providers::CATALOG` (see
// crates/fleetify-backend/src/providers/catalog.rs). `providers.setKey`
// and `providers.setConnectedBulk` validate against the catalog and
// return `unknown provider <id>` for anything missing.
//
// Workspace section is EXHAUSTIVE against the catalog (21 entries): 9 CLI
// agents + the Antigravity SDK + Ollama + every API provider. A mount-time
// drift guard (see useEffect below) warns if the catalog ever gains an id
// this list lacks. The extra per-row fields (scanKey / envKey / autoInstall)
// are onboarding-only verify metadata; the remaining probe-less rows
// (anthropic, cloudflare-workers-ai — HTTP providers finished with an inline
// key) simply omit them.
//
// Studio entries (category: "studio") come AFTER the workspace block and
// are NOT in the provider catalog — they live in the Studio registry
// (crates/fleetify-backend/src/studio/registry.rs). They are not passed to
// setConnectedBulk and do not appear in the drift-guard check. Higgsfield
// has no scan probe so its row renders without an "Installed" badge and does
// not gate the "Continue" button — the user can finish Studio setup later.
const PROVIDERS: ProviderDef[] = [
  // No CLI row opts in to `autoInstall` — users found the unattended
  // `npm install -g …` mid-onboarding surprising, so every install
  // now waits for an explicit Install button click. The verify-loop
  // gate (`p.autoInstall === true`) is preserved in case a future
  // first-run experience wants to opt a tile back in.
  { id: "claude-code",         label: "Claude Code",       logo: "claude-code", kind: "cli", scanKey: "claude_code", hint: "Anthropic CLI" },
  { id: "codex-cli",          label: "Codex CLI",         logo: "codex-cli",  kind: "cli", scanKey: "codex_cli",  hint: "OpenAI CLI" },
  // Kimi Code ships as `@moonshot-ai/kimi-code` (npm). Auth state is
  // read from `~/.kimi/auth.json` or `KIMI_API_KEY`
  // (KIMI_CLI_INDICATORS in the catalog).
  { id: "kimi-code",           label: "Kimi Code",         logo: "kimi-code",   kind: "cli", scanKey: "kimi_code",   hint: "Moonshot CLI" },
  // Antigravity CLI installer runs a remote shell script
  // (`iex (irm https://antigravity.google/cli/install.ps1)` on Windows,
  // `curl … | bash` elsewhere). Same explicit-click contract as above.
  { id: "antigravity-cli",            label: "Antigravity CLI",   logo: "antigravity-cli",    kind: "cli", scanKey: "antigravity_cli",                       hint: "Google's terminal agent (OAuth)" },
  // OpenCode / Cursor / GitHub Copilot — detected via the scan probe like the
  // CLIs above. A not-installed row shows an Install button that runs the
  // OS-appropriate installer in the background (npm for OpenCode/Copilot, the
  // curl|bash / irm script for Cursor) and waits for the binary to land before
  // flipping to Sign-in / Ready.
  { id: "opencode",       label: "OpenCode",          logo: "opencode", kind: "cli", scanKey: "opencode",                 hint: "CLI agent" },
  { id: "cursor-cli",         label: "Cursor CLI",        logo: "cursor-cli", kind: "cli", scanKey: "cursor_cli",                     hint: "CLI agent" },
  // Grok Build — xAI's ACP agent (`grok`). Auth is out-of-band (the bridge
  // injects XAI_API_KEY); detected via the scan probe like the CLIs above.
  // Reuses the existing `grok` brand mark.
  { id: "grok-build",         label: "Grok Build",        logo: "grok",   kind: "cli", scanKey: "grok_build",                         hint: "CLI agent" },
  { id: "github-copilot", label: "GitHub Copilot",    logo: "github-copilot", kind: "cli", scanKey: "github_copilot",    hint: "CLI agent" },
  // Hermes Agent — one CLI that fans out across whichever providers the user's
  // `hermes model` config has authenticated (Copilot, Anthropic, ...). Installs
  // via the official curl|bash / irm script; detected via the scan probe.
  { id: "hermes-agent",         label: "Hermes Agent",      logo: "hermes-agent", kind: "cli", scanKey: "hermes_agent",                     hint: "CLI agent (multi-provider)" },
  // SDK pairs a pip install with a GEMINI_API_KEY entry. The renderer
  // handles the two-stage flow inline.
  { id: "antigravity-sdk",label: "Antigravity SDK",   logo: "antigravity-cli",    kind: "api", envKey: "gemini", scanKey: "antigravity_sdk", hint: "Python SDK + Gemini key" },
  { id: "ollama",         label: "Ollama",            logo: "ollama", kind: "cli", ollama: true,                              hint: "Local models" },
  // Ollama Cloud — the hosted sibling of the local daemon above. Pure HTTP
  // API (kind:"api", Bearer OLLAMA_API_KEY, base https://ollama.com), so it
  // takes a key inline via KeyEntryRow → providers.setKey (keychain write),
  // exactly like the other API rows. Reuses the `ollama` brand mark. No
  // `ollama` flag (that routes to OllamaUrlRow, the local-daemon URL card).
  { id: "ollama-cloud",   label: "Ollama Cloud",      logo: "ollama", kind: "api",                                            hint: "API key (ollama.com)" },
  { id: "openai",         label: "OpenAI",            logo: "openai", kind: "api", envKey: "openai",                          hint: "API key" },
  // Anthropic API (Claude over the HTTP API — distinct from the Claude
  // Code CLI row above). No env-var probe; key entered inline.
  { id: "anthropic",      label: "Anthropic",         logo: "claude-code", kind: "api",                                            hint: "API key (Claude API)" },
  // Backend catalog id is "gemini-api" (the OpenAI-compat endpoint
  // at /v1beta/openai); the label is just "Gemini" so the row
  // matches the brand the user knows it by.
  { id: "gemini-api",     label: "Gemini",            logo: "gemini-api", kind: "api", envKey: "gemini",                          hint: "API key (Gemini API)" },
  { id: "deepseek",       label: "DeepSeek",          logo: "deepseek", kind: "api",                                          hint: "API key" },
  { id: "grok",           label: "Grok (xAI)",        logo: "grok",   kind: "api",                                            hint: "API key" },
  { id: "kimi-api",       label: "Kimi (Moonshot)",   logo: "kimi-code",   kind: "api",                                            hint: "API key" },
  { id: "perplexity",     label: "Perplexity",        logo: "perplexity", kind: "api",                                        hint: "API key" },
  { id: "nvidia-nim",     label: "NVIDIA NIM",        logo: "nvidia-nim", kind: "api",                                        hint: "API key" },
  { id: "openrouter",     label: "OpenRouter",        logo: "openrouter", kind: "api",                                        hint: "API key — 100s of models" },
  // Cloudflare Workers AI — needs an account id too (finished in
  // Settings); onboarding takes the token inline like other API rows.
  { id: "cloudflare-workers-ai", label: "Cloudflare Workers AI", logo: "cloudflare-workers-ai", kind: "api",                  hint: "API key + account id" },

  // ── Studio providers ─────────────────────────────────────────────────
  // These are image/video generation tools from the Studio registry, NOT
  // the provider catalog. Detected via studioApi.getTools() rather than
  // the agent scan, so they carry no scanKey and appear without an
  // "Installed" badge. Rendered in a separate "Studio" section below the
  // workspace providers. Selecting them enables them in Settings → Studio
  // but does NOT block the "Continue" button.
  { id: "higgsfield", label: "Higgsfield", logo: "higgsfield", kind: "cli", category: "studio", hint: "Image & video generation" },
];

const TYPE_BASE_MS = 12;
const TYPE_PUNCT_MS = 110;
const PAUSE_BETWEEN_BUBBLES = 420;
const PROVIDER_REVEAL_STAGGER_MS = 55;

interface Selections {
  providers?: ProviderDef[];
  /** Picks from the Workspace selection step (CLI agents + API providers). */
  workspacePicks?: ProviderDef[];
  /** Picks from the Studio selection step (image/video tools). */
  studioPicks?: ProviderDef[];
  scan?: ProviderScan | null;
  /** Subset of `providers` that reached a ready state during the verify
   *  step (CLI installed + signed in, Ollama running, API key saved +
   *  tested). Drives the main-agent picker filter so the user can't
   *  pick a not-yet-ready provider as the default. */
  readyProviders?: ProviderDef[];
  defaultProvider?: ProviderDef;
  githubUsername?: string;
  githubSkipped?: boolean;
  /** Probed once at mount — populated when `gh` CLI on the host
   *  reports an authenticated user. Drives the GitHub step's UI:
   *  one-tap "Use @<login>" instead of asking for a token paste.
   *  null = probe completed and nothing's signed in.
   *  undefined = probe still in flight. */
  existingGithub?: { username: string } | null;
  /** Python runtime probe result — fetched in parallel with the
   *  provider scan when the user confirms their provider selection.
   *  Passed into ScanWidget so the Antigravity SDK row can surface
   *  the same three-state Python required → Setup → Done affordance
   *  as Settings → Agents. null = probed, nothing found. */
  pythonRuntime?: PythonRuntimeResult | null;
  /** Backend catalog tiles, fetched once on mount. Drives the fleet-model
   *  step's model lists and the CLI-agent split for enabled_agents. */
  tiles?: ProviderTile[];
}

export function OnboardingChat({ user, onDone, startAt }: Props) {
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
  // Provider ids the user filled in inline (API key paste / Ollama
  // URL set) during the verify step. The scan probe checks env vars
  // and the running daemon — neither flips after a keychain write or
  // a config-file URL update — so we track the explicit saves here
  // and feed them into buildScanReadout so the summary doesn't tell
  // the user "Add key in Settings" for a key they just pasted.
  const inlineSavedRef = useRef<Set<string>>(new Set());
  // Resolver for the verify-step Continue button. handleProvidersConfirm
  // creates the promise and waits on it; ScanWidget's Continue click
  // (forwarded via Bubble → onScanContinue) resolves it. Replaces the
  // timer-based auto-progress so the user controls the pace and can
  // finish inline key entry before the summary message lands.
  const scanContinueResolverRef = useRef<(() => void) | null>(null);
  // Set while an assistant line is typing out — calling it reveals the full
  // text at once. Wired to right-click on the chat so the user can skip the
  // typewriter instead of waiting it out. Null when nothing is typing.
  const completeTypingRef = useRef<(() => void) | null>(null);
  const firstName = (user?.name || "").trim().split(/\s+/)[0] || "there";

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 60);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Pre-warm the discovered-model catalogs the moment the provider tiles land,
  // so the fleet-default picker (and the single-ready auto-default below) read
  // the SAME live `/agents/{id}/models` lineup as the in-app pickers instead of
  // the static CLI_MODELS fallback. `hydrate` is single-flight and spawns no
  // local CLI — it only covers remote-catalog agents + connected HTTP providers.
  useEffect(() => {
    if (selections.tiles && selections.tiles.length > 0) {
      void useDiscoveredModelsStore.getState().hydrate(selections.tiles);
    }
  }, [selections.tiles]);

  const pushAssistant = (
    text: string,
    widget?: WidgetKind,
    phase?: ProviderPhase,
  ): Promise<void> =>
    new Promise((resolve) => {
      const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setMessages((m) => [
        ...m,
        { id, sender: "assistant", text: "", typing: true, widget, phase },
      ]);

      let i = 0;
      let timer: ReturnType<typeof setTimeout>;
      // Reveal the whole line at once and unblock the queue. Shared by the
      // natural end-of-typing path and the right-click-to-skip affordance
      // (completeTypingRef) so the user never has to sit through the whole
      // animation.
      const finish = () => {
        clearTimeout(timer);
        if (completeTypingRef.current === finish) completeTypingRef.current = null;
        setMessages((m) =>
          m.map((msg) => (msg.id === id ? { ...msg, text, typing: false } : msg)),
        );
        setTimeout(resolve, PAUSE_BETWEEN_BUBBLES);
      };
      const tick = () => {
        i += 1;
        if (i >= text.length) { finish(); return; }
        const visible = text.slice(0, i);
        setMessages((m) =>
          m.map((msg) => (msg.id === id ? { ...msg, text: visible, typing: true } : msg)),
        );
        const ch = text[i - 1];
        const punct = ch === "." || ch === "," || ch === "—" || ch === ":" || ch === "?";
        timer = setTimeout(tick, punct ? TYPE_PUNCT_MS : TYPE_BASE_MS);
      };
      // Expose "finish now" so a right-click anywhere in the chat skips
      // straight to the end of this line.
      completeTypingRef.current = finish;
      timer = setTimeout(tick, PAUSE_BETWEEN_BUBBLES);
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

  // Selection + setup run in two phases — Workspace first, then Studio.
  // `phase` tells us which picker/verify step just resolved.
  const handleProvidersConfirm = async (
    providers: ProviderDef[],
    phase: ProviderPhase,
  ) => {
    resolveLastWidget();

    // ── Workspace selection done → advance to the Studio selection step
    //    (or straight to setup when Studio is gated off).
    if (phase === "workspace") {
      pushUser(
        providers.length
          ? humanList(providers.map((p) => p.label))
          : "No workspace providers",
      );
      setSelections((s) => ({ ...s, workspacePicks: providers }));
      if (STUDIO_ENABLED) {
        await pushAssistant(
          "Now your **Studio** tools — image and video generation (Higgsfield and friends). Pick any you'd like, or skip and add them later from **Settings**.",
          "providers",
          "studio",
        );
        return;
      }
      // Studio hidden — fall through to the shared setup sequence with an
      // empty studio bucket (workspace-only onboarding).
    }

    // ── Studio selection done (or skipped) → persist, then run the
    //    sequential setup steps (Workspace verify, then Studio verify).
    const fromStudioPhase = phase === "studio";
    if (fromStudioPhase) {
      pushUser(
        providers.length
          ? humanList(providers.map((p) => p.label))
          : "Skip — no Studio tools",
      );
    }
    const workspacePicks = fromStudioPhase
      ? (selectionsRef.current.workspacePicks ?? [])
      : providers;
    const studioPicks = fromStudioPhase ? providers : [];
    const allPicks = [...workspacePicks, ...studioPicks];
    setSelections((s) => ({ ...s, studioPicks, providers: allPicks }));

    // Persist the selection as the enabled set: selected → connected,
    // every other catalog provider → disabled (force-off). Also seed the
    // CLI-agent shortlist. One IPC call → one backend reload. Studio picks
    // are excluded — they live in the Studio registry, not the catalog, so
    // setConnectedBulk would reject their ids.
    try {
      let tiles = selectionsRef.current.tiles;
      if (!tiles) {
        const res = await providersApi.listCatalog();
        tiles = res.ok ? res.tiles : [];
        setSelections((s) => ({ ...s, tiles }));
      }
      const allIds = tiles.length > 0 ? tiles.map((t) => t.spec.id) : PROVIDERS.filter((p) => p.category !== "studio").map((p) => p.id);
      const cliAgentIds = tiles.filter((t) => t.spec.kind === "cli").map((t) => t.spec.id);
      const catalogProviders = workspacePicks.filter((p) => p.category !== "studio");
      const { connected, enabledAgents } = buildSelectionPersist(
        allIds,
        catalogProviders.map((p) => p.id),
        cliAgentIds,
      );
      await providersApi.setConnectedBulk(connected, enabledAgents);
    } catch {
      /* best-effort — the user can fix enablement in Settings */
    }

    // Pre-fetch the scan and Python runtime in parallel with the
    // assistant typing so the verification panel has data the moment
    // it mounts. Python runtime is needed by the Antigravity SDK row.
    const scanPromise   = apiScanProviders().catch(() => null);
    const pythonPromise = checkPythonRuntime().catch(() => null);

    // ── Step 3: Workspace setup/verify ──
    const wsIntro =
      workspacePicks.length === 1
        ? `Got it — let me verify **${workspacePicks[0]!.label}** end-to-end before we move on, so you don't get a surprise the first time you hit send.`
        : `Got it — I'll verify your **${workspacePicks.length} workspace providers** end-to-end so you don't get a surprise the first time you hit send.`;
    await pushAssistant(wsIntro, "scan", "workspace");

    const [scan, pythonRuntime] = await Promise.all([scanPromise, pythonPromise]);
    setSelections((s) => ({ ...s, scan, pythonRuntime }));

    // Wait for the user to click Continue inside the Workspace ScanWidget.
    // Its button is gated on "at least one provider ready" so we never
    // advance with a fully-empty roster.
    await new Promise<void>((resolve) => {
      scanContinueResolverRef.current = resolve;
    });
    scanContinueResolverRef.current = null;
    resolveLastWidget();

    // Re-scan once more — picks up any auto-install that happened
    // inside the widget. Falls back to the original scan on failure.
    const finalScan = (await apiScanProviders().catch(() => null)) ?? scan;
    if (finalScan !== scan) setSelections((s) => ({ ...s, scan: finalScan }));

    // ── Step 4: Studio setup/verify (skipped when nothing was picked) ──
    if (studioPicks.length > 0) {
      await pushAssistant(
        studioPicks.length === 1
          ? `And your Studio tool — let me check **${studioPicks[0]!.label}**.`
          : "And your Studio tools — let me check those too.",
        "scan",
        "studio",
      );
      // Studio verify is optional (tools finish setup in Settings → Studio),
      // so its Continue is never gated on readiness.
      await new Promise<void>((resolve) => {
        scanContinueResolverRef.current = resolve;
      });
      scanContinueResolverRef.current = null;
      resolveLastWidget();
    }

    // ── Tail: readout + main-agent picker, scoped to Workspace picks.
    //    Studio tools verify in their own step above and never drive a
    //    chat session, so the default-agent flow only considers workspace.
    await pushAssistant(buildScanReadout(workspacePicks, finalScan, inlineSavedRef.current));

    // Main-agent picker only renders the providers that actually
    // reached "ready" — picking a not-installed CLI as the default
    // would set the user up for an error on their first message.
    const readyProviders = workspacePicks.filter((p) =>
      isProviderReady(p, finalScan, inlineSavedRef.current),
    );
    setSelections((s) => ({ ...s, readyProviders }));

    if (readyProviders.length > 1) {
      await pushAssistant(
        "Since you've got more than one wired up, **which should Fleet drive by default?** I'll fall back to the others when this one isn't a fit (or you can switch per-session).",
        "main-agent",
      );
    } else if (readyProviders.length === 1) {
      // Exactly one ready provider — auto-set as default + skip the
      // question. `providers.setDefault` writes both `defaultProvider`
      // AND a matching `defaultModel` so the chat composer doesn't
      // open with a mismatched (provider, model) pair on first launch.
      const only = readyProviders[0]!;
      setSelections((s) => ({ ...s, defaultProvider: only }));
      const onlyTile = selectionsRef.current.tiles?.find((t) => t.spec.id === only.id);
      // Same live catalog the picker uses — resolve the default model from the
      // discovered lineup (the `hydrate` above has typically landed by now),
      // not the static CLI_MODELS fallback, so the persisted default isn't stale.
      const onlyDynamic = useDiscoveredModelsStore.getState().models[only.id];
      const onlyModel = onlyTile ? modelsForTile(onlyTile, onlyDynamic)[0]?.id : undefined;
      try {
        await providersApi.setDefault(only.id, onlyModel ?? null);
      } catch { /* best-effort */ }

      await pushAssistant(githubIntroCopy(getCurrentExistingGithub()), "github");
    } else {
      // No ready providers — skip the picker entirely and move on
      // to GitHub. The user can finish setup from Settings later.
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

  const handleMainAgentPick = async (provider: ProviderDef, modelId?: string, modelLabel?: string) => {
    resolveLastWidget();
    // Show the model's friendly label (e.g. "Opus 4.8"), not its raw id
    // ("claude-opus-4-8"); fall back to the id only when no label was passed.
    const modelText = modelLabel ?? modelId;
    pushUser(modelText ? `${provider.label} · ${modelText}` : provider.label);
    setSelections((s) => ({ ...s, defaultProvider: provider }));
    try {
      // Persist the explicit (provider, model) — modelId (the real id) is what
      // the backend stores. modelId is undefined only for providers with no
      // static model list (e.g. Ollama) — then the backend keeps its
      // catalog-first fallback.
      await providersApi.setDefault(provider.id, modelId ?? null);
    } catch { /* best-effort */ }

    await pushAssistant(
      modelText
        ? `Locked in — **${provider.label}** on **${modelText}** drives by default.`
        : `Locked in — **${provider.label}** drives by default.`,
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

    await askTheme();
  };

  // Theme picker next, then the privacy questions. The theme widget applies
  // the choice live, so the rest of onboarding previews it.
  const askTheme = () =>
    pushAssistant(
      `Almost there, ${firstName} — pick a look for Fleetify. You can change it any time in **Settings**.`,
      "theme",
    );

  // Theme picked (already applied live) → the two privacy steps, the last
  // ones before "Enter Fleet": dashboard sync, then product analytics.
  // Dashboard sync is on by default, so its step says what it sends and
  // offers to turn it off; either button saves the choice. Product analytics
  // stays off unless the user says yes. A choice that wasn't saved gets one
  // line saying so; it never blocks onboarding.
  const handleThemeConfirm = async (mode: ThemeMode) => {
    resolveLastWidget();
    pushUser(
      mode === "system" ? "System theme" : mode === "dark" ? "Dark theme" : "Light theme",
    );
    await pushAssistant(
      `One more thing, ${firstName}. Your sessions will show up on your fleetify.dev dashboard. To do that, Fleetify sends session titles (the folder name, or a name you typed), project folder names, which agent and model each session uses, the kind of each agent action, token usage and cost, and a heartbeat every minute while it's open, to your account. Never your code, file contents, commands or API keys. It's on by default — you can turn it off now or anytime in **Settings → Privacy**.`,
      "cloud-sync-consent",
    );
  };

  // One line when a privacy choice didn't take; onboarding carries on.
  const reportPrivacyChoice = async ({ applied, error }: PrivacyChoiceOutcome) => {
    if (!applied) {
      await pushAssistant(
        "I couldn't change that setting. You can try again in **Settings → Privacy**.",
      );
    } else if (error) {
      await pushAssistant(`I couldn't save that choice: ${error}`);
    }
  };

  const handleCloudSyncConsent = async (enabled: boolean) => {
    resolveLastWidget();
    pushUser(enabled ? "Keep it on" : "Turn it off");
    const outcome = await sendPrivacyChoice(
      () => window.electronAPI?.telemetrySetCloudEnabled?.(enabled),
    );
    await reportPrivacyChoice(outcome);
    // Only a choice the backend took is acknowledged: a call that never
    // reached it left sync as it was.
    if (outcome.applied) {
      await pushAssistant(
        enabled
          ? "Great — your sessions will appear on your dashboard."
          : "Dashboard sync is off. You can turn it on anytime in **Settings → Privacy**.",
      );
    }
    await pushAssistant(
      "Last thing — would you help us improve Fleetify? We'd send usage data (which screens, which providers, how long onboarding takes), linked to your account. Never message content, API keys or file paths. You can change this anytime in **Settings → Privacy**.",
      "telemetry-consent",
    );
  };

  // Product analytics → flips both the JS SDK opt state and the backend's
  // runtime gate via the Tauri command, then enables "Enter Fleet".
  const handleTelemetryConsent = async (enabled: boolean) => {
    resolveLastWidget();
    pushUser(enabled ? "Sure, help out" : "Not now");
    // Start or stop the renderer's analytics first, so a no takes effect
    // before the IPC lands.
    if (enabled) optIn(); else optOut();
    const outcome = await sendPrivacyChoice(
      () => window.electronAPI?.telemetrySetPosthogEnabled?.(enabled),
    );
    // The backend never got an opt-in: stop again, as Settings → Privacy
    // would show it off.
    const optedIn = enabled && outcome.applied;
    if (enabled && !outcome.applied) optOut();
    await reportPrivacyChoice(outcome);
    if (outcome.applied) {
      await pushAssistant(
        optedIn
          ? "Thanks — that helps us see what to improve. You can switch it off any time."
          : "No problem. You can opt in later from **Settings → Privacy** if you change your mind.",
      );
    }
    await pushAssistant(
      `That's the lot, ${firstName}. Hit **Enter Fleet** whenever you're ready.`,
    );
    capture("onboarding_completed", { telemetry_opt_in: optedIn });
    setDone(true);
  };

  // ─── Run scripted intro on first mount ────────────────────
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    capture("onboarding_started");

    // Pre-fetch the provider scan in parallel with the assistant
    // typing so the picker can show "Installed" / "Not installed"
    // badges from the moment it appears. The picker reveal stagger
    // (+ welcome bubbles) gives us ~3-4 seconds of headroom for the
    // backend round-trip; if it lands later the picker just hides
    // the badges until the state arrives, which is fine.
    apiScanProviders()
      .then((s) => setSelections((prev) => ({ ...prev, scan: s })))
      .catch(() => { /* badges stay hidden — non-blocking */ });

    // Drift guard: warn if the backend catalog has a provider this
    // hardcoded list is missing, so the "list every provider" contract
    // can't silently rot when the catalog grows.
    void providersApi.listCatalog().then((res) => {
      if (!res.ok) return;
      setSelections((prev) => ({ ...prev, tiles: res.tiles }));
      const known = new Set(PROVIDERS.map((p) => p.id));
      const missing = res.tiles.map((t) => t.spec.id).filter((id) => !known.has(id));
      if (missing.length > 0) {
        console.warn("[fleet] onboarding PROVIDERS missing catalog ids:", missing);
      }
    });

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
      if (startAt === "theme") {
        await askTheme();
        return;
      }
      await pushAssistant(`Welcome aboard, ${firstName}.`);
      await pushAssistant(
        "Fleet is a single cockpit for every AI coding agent — Claude Code, Codex, Gemini, Cursor, Kimi, OpenCode, GitHub Copilot, Antigravity, Ollama — plus 10+ API providers (OpenAI, Anthropic, Gemini, DeepSeek, Grok, and more). Shared memory, real cost control, one sidebar.",
      );
      await pushAssistant(
        "Let's set you up — start with your **workspace** agents and API providers. Pick one or more and I'll verify each is installed and signed in. You can edit any of this later from **Settings**.",
        "providers",
        "workspace",
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
        onContextMenu={(e) => {
          // Right-click anywhere in the chat skips the typewriter — reveal
          // the in-flight line's full text instead of waiting it out. When
          // nothing is typing this is a no-op and the native menu shows.
          if (completeTypingRef.current) {
            e.preventDefault();
            completeTypingRef.current();
          }
        }}
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
            readyProviders={selections.readyProviders}
            tiles={selections.tiles}
            githubUsername={selections.githubUsername}
            githubSkipped={selections.githubSkipped}
            existingGithub={selections.existingGithub}
            pythonRuntime={selections.pythonRuntime ?? null}
            onProvidersConfirm={handleProvidersConfirm}
            onMainAgentPick={handleMainAgentPick}
            onGithubResult={handleGithubResult}
            onThemeConfirm={handleThemeConfirm}
            onCloudSyncConsent={handleCloudSyncConsent}
            onTelemetryConsent={handleTelemetryConsent}
            onKeySaved={(id) => inlineSavedRef.current.add(id)}
            onScanContinue={() => scanContinueResolverRef.current?.()}
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
            background: done ? ONB_BTN_BG : "var(--secondary)",
            color: done ? ONB_BTN_FG : "var(--m-text-3)",
            border: "1px solid",
            borderColor: done ? ONB_BTN_BG : "var(--c-brd)",
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
export function Bubble({
  msg,
  scan,
  chosenProviders,
  readyProviders,
  tiles,
  githubUsername,
  githubSkipped,
  existingGithub,
  pythonRuntime,
  onProvidersConfirm,
  onMainAgentPick,
  onGithubResult,
  onThemeConfirm,
  onCloudSyncConsent,
  onTelemetryConsent,
  onKeySaved,
  onScanContinue,
}: {
  msg: ChatMsg;
  scan?: ProviderScan | null;
  chosenProviders?: ProviderDef[];
  /** Subset of `chosenProviders` that reached ready in the verify
   *  step. Filters the main-agent picker so the user can only pick
   *  something they can actually chat with. */
  readyProviders?: ProviderDef[];
  /** Catalog tiles — forwarded to MainAgentWidget to source per-provider model lists. */
  tiles?: ProviderTile[];
  githubUsername?: string;
  githubSkipped?: boolean;
  existingGithub?: { username: string } | null;
  /** Forwarded to ScanWidget for the Antigravity SDK row. */
  pythonRuntime?: PythonRuntimeResult | null;
  onProvidersConfirm: (providers: ProviderDef[], phase: ProviderPhase) => void;
  onMainAgentPick: (provider: ProviderDef, modelId?: string, modelLabel?: string) => void;
  onGithubResult: (
    result:
      | { method: "cli"; username?: string }
      | { method: "oauth"; username?: string }
      | { skipped: true },
  ) => void;
  onThemeConfirm: (mode: ThemeMode) => void;
  onCloudSyncConsent: (enabled: boolean) => void;
  onTelemetryConsent: (enabled: boolean) => void;
  /** Threaded through to ScanWidget so OnboardingChat can stash the
   *  ids the user saved inline and feed them into the readout
   *  builder (env probe lags a keychain write by definition). */
  onKeySaved?: (id: string) => void;
  /** ScanWidget's Continue button → resolves the parent's pending
   *  promise so the summary + main-agent picker can land. */
  onScanContinue?: () => void;
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
        {/* Links open in the system browser (MarkdownLink), never in place
            of the onboarding. */}
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>{msg.text}</ReactMarkdown>
        {msg.typing && <Caret />}
      </div>

      {!msg.typing && !msg.resolved && msg.widget === "providers" && (
        <ProvidersWidget
          phase={msg.phase ?? "workspace"}
          onConfirm={(picks) => onProvidersConfirm(picks, msg.phase ?? "workspace")}
          scan={scan ?? null}
        />
      )}
      {!msg.typing && msg.widget === "scan" && chosenProviders && (
        <ScanWidget
          providers={chosenProviders.filter((p) =>
            msg.phase === "studio" ? p.category === "studio" : p.category !== "studio",
          )}
          scan={scan ?? null}
          frozen={Boolean(msg.resolved)}
          pythonRuntime={pythonRuntime ?? null}
          onKeySaved={onKeySaved}
          onContinue={onScanContinue}
        />
      )}
      {!msg.typing && !msg.resolved && msg.widget === "main-agent" && chosenProviders && (
        <MainAgentWidget
          providers={readyProviders ?? chosenProviders}
          tiles={tiles}
          onPick={onMainAgentPick}
        />
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
      {!msg.typing && !msg.resolved && msg.widget === "theme" && (
        <ThemeWidget onConfirm={onThemeConfirm} />
      )}
      {!msg.typing && !msg.resolved && msg.widget === "cloud-sync-consent" && (
        <ConsentWidget yesLabel="Keep it on" noLabel="Turn it off" onChoice={onCloudSyncConsent} />
      )}
      {!msg.typing && !msg.resolved && msg.widget === "telemetry-consent" && (
        <ConsentWidget yesLabel="Sure, help out" noLabel="Not now" onChoice={onTelemetryConsent} />
      )}
    </div>
  );
}

/* ── ThemeWidget — System / Dark / Light picker for onboarding ──
   Wraps the shared <ThemeModeCards/> (applies the choice live so the rest of
   onboarding previews it) and adds the Continue button that advances to the
   privacy questions. */
function ThemeWidget({ onConfirm }: { onConfirm: (mode: ThemeMode) => void }) {
  const mode = useThemeStore((s) => s.mode);

  return (
    <div style={{ marginTop: 12 }}>
      <ThemeModeCards />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button
          onClick={() => onConfirm(mode)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 28,
            padding: "0 14px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            background: "var(--c-high)",
            color: "var(--background)",
            border: "none",
            cursor: "pointer",
          }}
        >
          Continue
          <ArrowRight size={12} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}

/* ── ConsentWidget — two-button choice for a privacy step ──
   Used for dashboard sync (on by default: keep it on or turn it off) and
   product analytics (off by default: opt in or not). Both buttons look
   the same, so neither choice is pushed. Either choice resolves the
   widget and advances onboarding — refusal is not a blocker.         */
function ConsentWidget({
  yesLabel,
  noLabel,
  onChoice,
}: {
  yesLabel: string;
  noLabel: string;
  onChoice: (enabled: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pick = (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    onChoice(enabled);
  };
  const buttonStyle: CSSProperties = {
    padding: "9px 16px",
    borderRadius: 8,
    background: "var(--secondary)",
    color: "var(--c-high)",
    border: "1px solid rgba(255,255,255,0.08)",
    cursor: busy ? "default" : "pointer",
    fontSize: 13,
    fontWeight: 500,
    opacity: busy ? 0.6 : 1,
    transition: "all 0.2s ease",
  };
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginTop: 10,
        flexWrap: "wrap",
      }}
    >
      <button onClick={() => pick(true)} disabled={busy} style={buttonStyle}>
        {yesLabel}
      </button>
      <button onClick={() => pick(false)} disabled={busy} style={buttonStyle}>
        {noLabel}
      </button>
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
  phase,
  onConfirm,
  scan,
}: {
  /** Which bucket this picker covers — Workspace (CLI agents + API) or
   *  Studio (image/video tools). Studio selection is optional (skippable). */
  phase: ProviderPhase;
  onConfirm: (providers: ProviderDef[]) => void;
  /** Snapshot of /providers/scan, pre-fetched on OnboardingChat mount.
   *  null while the request is still in flight — the picker just
   *  hides the install-state badge until it arrives. */
  scan: ProviderScan | null;
}) {
  const [revealed, setRevealed] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Only this phase's providers, split into "Providers" (CLI agents) and
  // "API" — mirroring Settings → Providers (Workspace/Studio × Providers/API).
  // An empty sub-section is hidden, so Studio shows just "Providers" until
  // studio API providers are added.
  const phaseProviders = PROVIDERS.filter((p) =>
    phase === "studio" ? p.category === "studio" : p.category !== "studio",
  );
  const providerKind = phaseProviders.filter((p) => p.kind === "cli");
  const apiKind = phaseProviders.filter((p) => p.kind === "api");

  // Studio is optional — the user can Continue (skip) with nothing picked.
  const optional = phase === "studio";

  useEffect(() => {
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      i += 1;
      setRevealed(i);
      if (i < phaseProviders.length) setTimeout(tick, PROVIDER_REVEAL_STAGGER_MS);
    };
    setTimeout(tick, 80);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!optional && selected.size === 0) return;
    const picks = phaseProviders.filter((p) => selected.has(p.id));
    onConfirm(picks);
  };

  const count = selected.size;
  const canContinue = optional || count > 0;

  // Reveal stagger walks this phase's providers (Providers → API) in order.
  const indexById = new Map(phaseProviders.map((p, i) => [p.id, i]));

  // Split the CLI agents into "installed on this device" vs "installable" so the
  // picker reads like a real setup screen (cards for what's ready, a list for
  // what you can add) instead of one flat roster.
  const isInstalled = (p: ProviderDef) => isProviderInstalled(p, scan);
  const installedCli = providerKind.filter(isInstalled);
  const installableCli = providerKind.filter((p) => !isInstalled(p));
  const selectAll = (list: ProviderDef[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      list.forEach((p) => next.add(p.id));
      return next;
    });

  const renderSection = (opts: {
    icon: typeof Check;
    title: string;
    list: ProviderDef[];
    variant: "card" | "row";
    actionFor?: (p: ProviderDef) => { label: string; kind: "install" | "key" } | null;
    showSelectAll?: boolean;
  }) => {
    if (opts.list.length === 0) return null;
    const { icon: Icon, title, list, variant, actionFor } = opts;
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "12px 8px 6px" }}>
          <Icon size={11} strokeWidth={2.4} style={{ color: "var(--m-text-3)", flexShrink: 0 }} />
          <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--m-text-3)" }}>
            {title}
          </span>
          <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--m-text-3)" }}>{list.length}</span>
          {opts.showSelectAll && (
            <button
              type="button"
              onClick={() => selectAll(list)}
              style={{ marginLeft: "auto", fontSize: 11, fontWeight: 500, color: "var(--m-text-2)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              Select all
            </button>
          )}
        </div>
        {list.map((p) => {
          const idx = indexById.get(p.id) ?? 0;
          return (
            <ProviderRow
              key={p.id}
              provider={p}
              visible={idx < revealed}
              selected={selected.has(p.id)}
              variant={variant}
              action={actionFor ? actionFor(p) : null}
              onToggle={() => toggle(p.id)}
            />
          );
        })}
      </div>
    );
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
      }}
    >
      <style>{`
        .onb-list { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .onb-list:hover { scrollbar-color: rgba(var(--fg-rgb),0.18) transparent; }
        .onb-list::-webkit-scrollbar { width: 6px; }
        .onb-list::-webkit-scrollbar-track { background: transparent; }
        .onb-list::-webkit-scrollbar-thumb { background: transparent; border-radius: 99px; }
        .onb-list:hover::-webkit-scrollbar-thumb { background: rgba(var(--fg-rgb),0.16); }
      `}</style>
      <div
        className="onb-list"
        style={{
          padding: "4px 8px 8px",
          display: "flex",
          flexDirection: "column",
          // Cap the list so a full catalog (~20 providers) scrolls INSIDE the
          // card instead of growing the whole screen; the footer + Continue
          // stay pinned and visible.
          maxHeight: "46vh",
          overflowY: "auto",
        }}
      >
        {renderSection({
          icon: Check,
          title: "Installed on this device",
          list: installedCli,
          variant: "card",
          showSelectAll: true,
        })}
        {renderSection({
          icon: Download,
          title: "Installable",
          list: installableCli,
          variant: "row",
          actionFor: () => ({ label: "Install", kind: "install" }),
        })}
        {renderSection({
          icon: KeyRound,
          title: "API",
          list: apiKind,
          variant: "row",
          actionFor: () => ({ label: "Add key", kind: "key" }),
        })}
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
          {count === 0
            ? optional
              ? "Optional — pick any or skip"
              : "None selected"
            : `${count} selected`}
        </span>
        <button
          onClick={confirm}
          disabled={!canContinue}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 26,
            padding: "0 11px",
            borderRadius: 5,
            fontSize: 11.5,
            fontWeight: 600,
            background: canContinue ? ONB_BTN_BG : "var(--secondary)",
            color: canContinue ? ONB_BTN_FG : "var(--m-text-3)",
            border: "none",
            cursor: canContinue ? "pointer" : "not-allowed",
            transition: "background 0.15s ease, transform 0.12s ease",
          }}
          onMouseEnter={(e) => {
            if (!canContinue) return;
            e.currentTarget.style.transform = "translateY(-0.5px)";
          }}
          onMouseLeave={(e) => {
            if (!canContinue) return;
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          {optional && count === 0 ? "Skip" : "Continue"}
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
  variant,
  action,
  onToggle,
}: {
  provider: ProviderDef;
  visible: boolean;
  selected: boolean;
  /** "card" = installed-on-device (bordered, elevated). "row" = installable /
   *  API (flatter, with a right-side action affordance). */
  variant: "card" | "row";
  /** Right-side affordance for non-installed rows: Install or Add key. */
  action?: { label: string; kind: "install" | "key" } | null;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  const isCard = variant === "card";

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
        width: "100%",
        padding: isCard ? "6px 9px" : "5px 9px",
        margin: isCard ? "2px 0" : "0",
        borderRadius: isCard ? 7 : 6,
        background: selected
          ? "rgba(var(--fg-rgb),0.06)"
          : isCard || hover ? "var(--secondary)" : "transparent",
        border: isCard
          ? `1px solid ${selected ? "var(--c-brd2)" : "var(--c-brd)"}`
          : `1px solid ${selected ? "var(--c-brd2)" : "transparent"}`,
        color: "var(--m-text)",
        cursor: visible ? "pointer" : "default",
        textAlign: "left",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(2px)",
        transition:
          "opacity 0.22s ease, transform 0.22s ease, background 0.12s ease, border-color 0.12s ease",
      }}
    >
      {/* Multi-select checkbox — empty rounded box → filled accent + check. */}
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          flexShrink: 0,
          borderRadius: 4,
          border: selected
            ? "1px solid var(--c-high)"
            : "1px solid rgba(var(--fg-rgb),0.18)",
          background: selected ? "var(--c-high)" : "transparent",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background 0.12s, border-color 0.12s",
        }}
      >
        {selected && (
          <Check size={9.5} strokeWidth={3.2} style={{ color: "var(--background)" }} />
        )}
      </span>
      {/* Bare logo — no tile, sits inline like a favicon next to the name. */}
      <span aria-hidden style={{ flexShrink: 0, display: "inline-flex", lineHeight: 0 }}>
        <ProviderLogo tool={provider.logo} size={16} />
      </span>
      {/* Name + one-line description */}
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.25, color: "var(--c-high)" }}>
          {provider.label}
        </span>
        <span
          style={{
            fontSize: 10.5,
            lineHeight: 1.2,
            color: "var(--m-text-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {provider.hint}
        </span>
      </span>
      {/* Right-side affordance — only for installable / API rows. Installed
          cards need nothing: the section + the card treatment already say it. */}
      {action && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
            fontSize: 10.5,
            fontWeight: 500,
            color: "var(--m-text-3)",
          }}
        >
          {action.kind === "key" ? (
            <KeyRound size={11} strokeWidth={2} />
          ) : (
            <Download size={11} strokeWidth={2} />
          )}
          {action.label}
        </span>
      )}
    </button>
  );
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
  pythonRuntime,
  onKeySaved,
  onContinue,
}: {
  providers: ProviderDef[];
  scan: ProviderScan | null;
  frozen?: boolean;
  /** Python runtime probe — forwarded to the Antigravity SDK row so
   *  it can swap between Setup / Add key / Ready states. null means
   *  the probe ran and found no Python installation. */
  pythonRuntime?: PythonRuntimeResult | null;
  /** Bubbled out so the parent's scan-readout summary knows the user
   *  finished a key entry inline (the on-disk env probe wouldn't
   *  pick up a keychain write). Called once per provider id when
   *  setKey / setOllamaBaseUrl succeeds inside this widget. */
  onKeySaved?: (id: string) => void;
  /** Continue button click handler. Resolves the parent's pending promise so
   *  the readout + main-agent picker can land. Always enabled — no provider is
   *  mandatory; the user can finish setup later from Settings → Providers. */
  onContinue?: () => void;
}) {
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  // Track which provider rows are currently signing in so concurrent
  // clicks don't double-spawn the auth PTY.
  const signingInRef = useRef<Set<string>>(new Set());
  // Same idea for install: prevents a double-click while npm install
  // is already in flight — that would queue two long-running spawns
  // back-to-back and confuse the row's state machine.
  const installingRef = useRef<Set<string>>(new Set());
  // Captured OAuth URLs, keyed by toolKey ("claude_code"
  // / "codex_cli"). Pushed from main.cjs's auth-pty as soon as it
  // spots the URL in the CLI's output. ScanRow surfaces a clickable
  // "re-open browser" icon while the URL is known, so the user can
  // recover if they accidentally close the auth tab.
  const [authUrls, setAuthUrls] = useState<Record<string, string>>({});
  // Provider ids the user has just saved a key/URL for in this
  // session. The scan probes env vars (PATH-bound) and Ollama's
  // running daemon — neither flips immediately after a
  // `providers.setKey` to the keychain or a `setOllamaBaseUrl` write
  // to the config. Tracking the save locally lets the row + the
  // summary readout reflect the user's action without round-tripping
  // a full scan.
  const [keysAdded, setKeysAdded] = useState<Record<string, boolean>>({});
  const markKeyAdded = (id: string) => {
    setKeysAdded((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
    onKeySaved?.(id);
  };

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
      // Flip every row to "running" up front so the spinners light up
      // in unison; previously rows verified sequentially with a 250 ms
      // stagger and the user watched a slow drip. Verification is
      // read-only (`apiScanProviders` for everything, `installProvider`
      // for autoInstall rows) so the concurrent fan-out is safe.
      setStates(() => {
        const running: Record<string, ProviderState> = {};
        providers.forEach((p) => {
          running[p.id] = { status: "running", detail: "Verifying…" };
        });
        return running;
      });

      // Tiny visual hold so the user sees the spinners light up before
      // any row resolves — without it, fast scans (already-installed
      // providers) flip ok before the running state ever paints and the
      // verify step feels like it didn't run.
      await new Promise((r) => setTimeout(r, 400));
      if (cancelled) return;

      const verifyOne = async (p: ProviderDef): Promise<void> => {
        let result = resolveProvider(p, scan);

        // ── Auto-install for missing npm CLIs ──
        // Gated on `p.autoInstall === true` so non-npm installers
        // (Antigravity CLI's remote shell installer, Antigravity SDK's
        // pip + Setup affordance) only install on an explicit click,
        // not silently behind the verify spinner.
        const isMissingCli =
          result.status === "fail" &&
          /not installed/i.test(result.detail) &&
          p.scanKey &&
          p.autoInstall === true;

        if (isMissingCli && window.electronAPI?.installProvider) {
          setStates((prev) => ({
            ...prev,
            [p.id]: { status: "running", detail: "Installing…" },
          }));
          try {
            // Backend `shell_install_provider` routes on the kebab id
            // ("claude-code", "codex-cli", "kimi-code"), not the snake-case
            // scanKey ("claude_code", …) used by the scan probe.
            const installRes = await window.electronAPI.installProvider(p.id);
            if (cancelled) return;
            if (installRes?.success) {
              const fresh = await apiScanProviders().catch(() => null);
              if (cancelled) return;
              if (fresh) result = resolveProvider(p, fresh);
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

        if (cancelled) return;
        setStates((prev) => ({ ...prev, [p.id]: result }));
      };

      await Promise.all(providers.map(verifyOne));
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
      // Quit shortcut is OS-specific: ⌘Q on macOS, Alt+F4 on Windows, Ctrl+Q elsewhere.
      const quitHint = getPlatform() === "windows" ? "Alt+F4" : formatShortcut(["Mod", "Q"]);
      flipFail(`Restart Fleet (${quitHint}) to enable Sign in`);
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
  //      The backend's shutil.which("codex-cli"|"claude") checks
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
      // Backend matches on the kebab provider id (see auto-install
      // branch above); scanKey is the renderer's own snake_case probe
      // bucket and the backend doesn't recognise it.
      console.log("[fleet] installProvider →", p.id);
      const result = await window.electronAPI.installProvider(p.id);
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

  // Each ScanWidget covers a single phase (the parent passes only the
  // workspace or only the studio picks), so the rows render as one flat
  // verify list — the phase separation lives in the chat flow, not here.
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
        // scanKey ("claude_code" / "codex_cli") so
        // simultaneous sign-ins for two providers each get their
        // own re-open icon pointing at the right URL.
        const authUrl = p.scanKey ? authUrls[p.scanKey] : undefined;

        // Antigravity SDK rolls up into the same single-row visual as
        // the CLI rows. Per-state mapping:
        //   • !sdkInstalled, !python.installed → "Get Python" → python.org
        //   • !sdkInstalled, installing        → "Installing…" pill
        //   • !sdkInstalled, python.installed  → "Setup" → pip install
        //                                        (also on install-failed —
        //                                        surfaces retry path
        //                                        without "Setup failed")
        //   • sdkInstalled, no key             → KeyEntryRow ("Add key")
        //   • sdkInstalled, key set            → "Ready" pill
        // While the row is still verifying, render the plain ScanRow
        // so the user sees a spinner and a "Verifying…" pill instead
        // of an interactive KeyEntryRow that hasn't determined its
        // initial state yet. Once the verify resolves, the dispatch
        // re-routes to the appropriate inline component.
        const verifying = st.status === "running" && st.detail === "Verifying…";
        if (verifying) {
          return <ScanRow key={p.id} provider={p} state={st} />;
        }

        if (p.id === "antigravity-sdk") {
          const fallbackPython: PythonRuntimeResult = { installed: false, version: null, path: null };
          const python = pythonRuntime ?? fallbackPython;
          const sdkInstalled = !!scan?.antigravity_sdk?.installed;
          const sdkAuthenticated = !!scan?.antigravity_sdk?.authenticated;
          const installing = st.status === "running" && st.detail !== "Verifying…";

          // Two-stage SDK flow:
          //   1. pip not done yet → Setup / Get Python / Installing
          //   2. pip done → KeyEntryRow (paste Gemini key)
          if (sdkInstalled) {
            const hasKey = sdkAuthenticated || !!keysAdded[p.id];
            return (
              <KeyEntryRow
                key={p.id}
                provider={p}
                initiallyHasKey={hasKey}
                frozen={frozen}
                onSaved={() => markKeyAdded(p.id)}
              />
            );
          }

          let pillState: ProviderState;
          let action: { label: string; onClick: () => void } | null = null;
          if (installing) {
            pillState = { status: "running", detail: "Installing…" };
          } else if (!python.installed) {
            pillState = { status: "fail", detail: "Python required" };
            action = {
              label: "Get Python",
              onClick: () => {
                window.electronAPI?.openExternal?.("https://www.python.org/downloads/").catch(() => {});
              },
            };
          } else {
            pillState = { status: "fail", detail: "Not installed" };
            action = { label: "Setup", onClick: () => handleInstall(p) };
          }

          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "0 10px",
                height: 34,
                borderRadius: 6,
              }}
            >
              <ProviderLogo tool={p.logo} size={13} />
              <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1, color: "var(--c-high)" }}>
                {p.label}
              </span>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                {action && !frozen && <ActionButton label={action.label} onClick={action.onClick} />}
                <StatusPill state={pillState} />
              </div>
            </div>
          );
        }

        // Ollama — local daemon, no API key. Settings → Models lets
        // the user repoint the base URL when the daemon listens on a
        // non-default host/port; mirror that here so the row offers
        // both the standard download (handleDownloadOllama) AND an
        // inline URL entry without bouncing the user into Settings.
        if (p.ollama) {
          const running = !!scan?.ollama?.running || !!keysAdded[p.id];
          return (
            <OllamaUrlRow
              key={p.id}
              provider={p}
              running={running}
              frozen={frozen}
              onDownload={() => handleDownloadOllama(p)}
              onSaved={() => markKeyAdded(p.id)}
            />
          );
        }

        // All pure-API providers (kind: "api", no scanKey, no ollama)
        // — OpenAI / Gemini API / DeepSeek / Grok / Kimi API /
        // Perplexity / NVIDIA NIM. The user enters the key inline;
        // the row tests it via providers.testConnection (Settings →
        // Models parity) and flips to a saved-state view with a
        // masked preview + Edit link.
        if (p.kind === "api" && !p.scanKey && !p.ollama) {
          const envKeyHasKey =
            p.envKey && scan ? !!scan.env_keys[p.envKey] : false;
          const hasKey = envKeyHasKey || !!keysAdded[p.id];
          return (
            <KeyEntryRow
              key={p.id}
              provider={p}
              initiallyHasKey={hasKey}
              frozen={frozen}
              onSaved={() => markKeyAdded(p.id)}
            />
          );
        }

        return (
          <ScanRow
            key={p.id}
            provider={p}
            state={st}
            authUrl={authUrl}
            onSignIn={!frozen && p.scanKey ? () => handleSignIn(p) : undefined}
            onInstall={!frozen && p.scanKey ? () => handleInstall(p) : undefined}
            onDownload={!frozen && p.ollama ? () => handleDownloadOllama(p) : undefined}
          />
        );
      })}
      {!frozen && onContinue && (
        <ContinueRow
          // No provider is mandatory — the user can finish setup any time from
          // Settings → Providers — so Continue is always available.
          enabled
          onContinue={onContinue}
        />
      )}
    </div>
  );
}

/** Continue affordance at the bottom of the verify list. Disabled
 *  until at least one provider in the list is fully ready — gating
 *  the parent's main-agent picker / readout cascade on something the
 *  user can actually drive a chat with. */
function ContinueRow({
  enabled,
  onContinue,
}: {
  enabled: boolean;
  onContinue: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        padding: "10px 8px 4px",
      }}
    >
      <button
        type="button"
        onClick={onContinue}
        disabled={!enabled}
        title={enabled ? "" : "Set up at least one provider to continue"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 28,
          padding: "0 14px",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          background: enabled ? ONB_BTN_BG : "var(--secondary)",
          color: enabled ? ONB_BTN_FG : "var(--m-text-3)",
          border: "none",
          cursor: enabled ? "pointer" : "not-allowed",
          transition: "background 0.12s ease",
        }}
      >
        Continue
        <ArrowRight size={12} strokeWidth={2.4} />
      </button>
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
        gap: 9,
        padding: "0 9px",
        height: 30,
        borderRadius: 6,
        opacity: state.status === "pending" ? 0.4 : 1,
        transition: "opacity 0.3s ease",
      }}
    >
      <span aria-hidden style={{ flexShrink: 0, display: "inline-flex", lineHeight: 0 }}>
        <ProviderLogo tool={provider.logo} size={16} />
      </span>
      <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1, color: "var(--c-high)" }}>
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
        background: ONB_BTN_BG,
        color: ONB_BTN_FG,
        border: "none",
        cursor: "pointer",
        opacity: hover ? 0.88 : 1,
        transition: "opacity 0.12s ease, transform 0.12s ease",
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
      {/* Ready needs no words — the green check says it, matching the picker.
          Other states keep their explanatory detail. */}
      {status !== "ok" && <span>{label}</span>}
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
    // Same naked green check as the picker.
    return <Check size={15} strokeWidth={2.5} style={{ color: "#43c97f", flexShrink: 0 }} />;
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

/** Where users create an API key for each provider — surfaced as a link atop
 *  the inline key-entry body so they aren't left hunting for the dashboard. */
function apiKeyUrl(id: string): string | null {
  switch (id) {
    case "openai": return "https://platform.openai.com/api-keys";
    case "anthropic": return "https://console.anthropic.com/settings/keys";
    case "gemini-api":
    case "antigravity-sdk": return "https://aistudio.google.com/apikey";
    case "deepseek": return "https://platform.deepseek.com/api_keys";
    case "grok": return "https://console.x.ai/";
    case "kimi-api": return "https://platform.moonshot.ai/console/api-keys";
    case "perplexity": return "https://www.perplexity.ai/account/api/keys";
    case "nvidia-nim": return "https://build.nvidia.com/";
    case "openrouter": return "https://openrouter.ai/keys";
    case "ollama-cloud": return "https://ollama.com/settings/keys";
    case "cloudflare-workers-ai": return "https://dash.cloudflare.com/?to=/:account/ai/workers-ai";
    default: return null;
  }
}

function openKeyPage(url: string) {
  window.electronAPI?.openExternal?.(url)?.catch(() => {});
}

/* ── KeyEntryRow ──────────────────────────────────────────────────
   Inline API-key entry + saved-state preview in the onboarding
   verify list. Same row chrome as ScanRow (logo + label + action +
   status pill); the action and body swap between three modes:

     * entry    — input + Save; user hasn't pasted a key yet.
     * saving   — Save click in flight (setKey + testConnection).
     * saved    — masked preview ("sk-…abcd") + underlined Edit link;
                  click Edit → back to entry.

   On Save we run `providers.setKey` (keychain write) AND
   `providers.testConnection` (matches the Settings → Models pattern)
   so the Ready pill only lights up once the key actually answers a
   model-list call. `onSaved` bubbles the id to the parent so the
   readout / continue gating reflects the inline save. */
function KeyEntryRow({
  provider,
  initiallyHasKey,
  frozen,
  onSaved,
}: {
  provider: ProviderDef;
  initiallyHasKey: boolean;
  /** True once the parent's Continue button has fired. Hides the
   *  Edit / Save / Cancel chrome so the verify list reads as a
   *  static summary the user can't accidentally retype. */
  frozen?: boolean;
  onSaved: () => void;
}) {
  const isCloudflare = provider.id === "cloudflare-workers-ai";
  type Mode = "collapsed" | "entry" | "saving" | "saved";
  const [mode, setMode] = useState<Mode>(initiallyHasKey ? "saved" : "collapsed");
  const [value, setValue] = useState("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // True when `setKey` landed but `testConnection` couldn't actually
  // reach the provider's API (network / timeout / no `/models` endpoint).
  // We still let the user move on — they may be offline — but surface
  // the difference in the pill so they don't read it as "fully Ready".
  const [savedUnverified, setSavedUnverified] = useState(false);

  // Fetch the keychain-stored preview when we land in saved mode
  // (mount-with-existing-key OR transition from saving → saved).
  // getKeyPreview returns something like "sk-…abcd" (last 4 chars of
  // a redacted middle); falls back to a generic mask when absent.
  useEffect(() => {
    if (mode !== "saved") return;
    let cancelled = false;
    providersApi
      .getKeyPreview(provider.id)
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.preview) setPreview(r.preview);
        else setPreview("•••••••");
      })
      .catch(() => {
        if (cancelled) return;
        setPreview("•••••••");
      });
    return () => {
      cancelled = true;
    };
  }, [mode, provider.id]);

  const keyUrl = apiKeyUrl(provider.id);
  const actionLabel = isCloudflare ? "Set up" : "Add key";
  const canSave = isCloudflare ? !!value.trim() && !!accountId.trim() : !!value.trim();

  const save = async () => {
    if (!canSave) return;
    const trimmed = value.trim();
    setMode("saving");
    setError(null);
    try {
      const setResult = await providersApi.setKey(provider.id, trimmed);
      if (!setResult.ok) {
        setMode("entry");
        setError(setResult.error || "Save failed");
        return;
      }
      if (isCloudflare) {
        const acct = await providersApi.setCloudflareAccountId(accountId.trim());
        if (!acct.ok) {
          setMode("entry");
          setError(acct.error || "Couldn't save the account id");
          return;
        }
      }
      // Test the key against the provider's API — mirrors the test
      // Settings → Models runs after a paste. AUTH or zero-model
      // responses block the save (the key didn't actually
      // authenticate); NETWORK / TIMEOUT save but flag the row as
      // "Saved, untested" so the user knows we couldn't confirm.
      const test = await providersApi.testConnection(provider.id, trimmed);
      if (test.ok) {
        // A 200 with an empty model list usually means the endpoint
        // returned its public catalogue without ever checking auth
        // (Gemini's /v1beta/openai/models has been observed doing
        // this on bad keys). Don't trust ok=true unless the response
        // actually came back with models.
        if (test.model_count !== null && test.model_count > 0) {
          setMode("saved");
          setSavedUnverified(false);
          setValue("");
          setAccountId("");
          setPreview(null);
          onSaved();
          return;
        }
        setMode("entry");
        setError(
          "Saved, but the provider didn't list any models — usually a sign the key was rejected. Double-check and try again.",
        );
        return;
      }
      if (test.code === "AUTH") {
        setMode("entry");
        setError(test.error || "Key rejected by the provider");
        return;
      }
      // NETWORK / TIMEOUT / USE_PROBE / NOT_FOUND — key landed in
      // the keychain but we couldn't reach the host to confirm.
      // Save with the untested flag so the pill reads "Saved,
      // untested" instead of a misleading "Ready".
      setMode("saved");
      setSavedUnverified(true);
      setValue("");
      setAccountId("");
      setPreview(null);
      onSaved();
    } catch (e) {
      setMode("entry");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  const cancel = () => {
    setMode(initiallyHasKey ? "saved" : "collapsed");
    setValue("");
    setAccountId("");
    setError(null);
  };

  const pill: ProviderState =
    mode === "saved"
      ? savedUnverified
        ? { status: "warn", detail: "Saved, untested" }
        : { status: "ok", detail: "Ready" }
      : mode === "saving"
        ? { status: "running", detail: "Testing key…" }
        : value.length > 0
          ? { status: "running", detail: "Awaiting save" }
          : { status: "warn", detail: actionLabel };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 10px",
          height: 34,
          borderRadius: 6,
        }}
      >
        <ProviderLogo tool={provider.logo} size={13} />
        <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1, color: "var(--c-high)" }}>
          {provider.label}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {mode === "saved" && (
            <>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--m-text-3)",
                  fontFamily: "var(--font-mono, monospace)",
                  letterSpacing: "0.02em",
                }}
              >
                {preview ?? "•••••••"}
              </span>
              {!frozen && (
                <button
                  type="button"
                  onClick={() => setMode("entry")}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--m-text-2)",
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline",
                    fontFamily: "inherit",
                  }}
                >
                  Edit Key
                </button>
              )}
            </>
          )}
          {mode === "collapsed" && !frozen ? (
            <button
              type="button"
              onClick={() => setMode("entry")}
              style={{
                height: 22,
                padding: "0 9px",
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 600,
                background: ONB_BTN_BG,
                color: ONB_BTN_FG,
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {actionLabel}
            </button>
          ) : (
            <StatusPill state={pill} />
          )}
        </div>
      </div>
      {!frozen && mode === "entry" && (
        <div style={{ padding: "4px 10px 10px 33px", display: "flex", flexDirection: "column", gap: 7 }}>
          {keyUrl && (
            <button
              type="button"
              onClick={() => openKeyPage(keyUrl)}
              style={{
                alignSelf: "flex-start",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "transparent",
                border: "none",
                padding: 0,
                color: "var(--m-text-2)",
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
                textDecoration: "underline",
                fontFamily: "inherit",
              }}
            >
              {isCloudflare
                ? "Create a Workers AI API token"
                : `Get your ${provider.label} API key`}
              <ExternalLink size={10} />
            </button>
          )}
          {isCloudflare && (
            <input
              type="text"
              placeholder="Account ID"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") cancel();
              }}
              style={{
                width: "100%",
                boxSizing: "border-box",
                height: 26,
                padding: "0 8px",
                borderRadius: 5,
                background: "rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "var(--c-high)",
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
              }}
            />
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="password"
              autoFocus={!isCloudflare}
              placeholder={isCloudflare ? "API token" : `Paste your ${provider.label} API key`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") cancel();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                height: 26,
                padding: "0 8px",
                borderRadius: 5,
                background: "rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "var(--c-high)",
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              style={{
                height: 26,
                padding: "0 10px",
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 600,
                background: !canSave ? "var(--secondary)" : ONB_BTN_BG,
                color: !canSave ? "var(--m-text-3)" : ONB_BTN_FG,
                border: "none",
                cursor: !canSave ? "default" : "pointer",
              }}
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancel}
              style={{
                height: 26,
                padding: "0 10px",
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 500,
                background: "transparent",
                color: "var(--m-text-2)",
                border: "1px solid rgba(255,255,255,0.10)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
          </div>
          {error && (
            <div style={{ fontSize: 11, color: "rgb(248,113,113)" }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── OllamaUrlRow ─────────────────────────────────────────────────
   Mirrors Settings → Models' Ollama config card: the user can re-
   point the daemon base URL when it listens on a non-default
   host/port. Standard Download button stays available for users
   who haven't installed Ollama yet. */
function OllamaUrlRow({
  provider,
  running,
  frozen,
  onDownload,
  onSaved,
}: {
  provider: ProviderDef;
  running: boolean;
  /** True after Continue: collapse to a static header. */
  frozen?: boolean;
  onDownload: () => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("http://localhost:11434");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await providersApi.setOllamaBaseUrl(trimmed);
      if (r.ok) {
        // Probe immediately so we know if the daemon actually
        // answers at the new URL — saving the config without
        // confirming connectivity would leave the row in a
        // confusing "saved but still not running" middle state.
        const probe = await providersApi.ollamaProbe(trimmed);
        if (probe.ok && probe.running) {
          setOpen(false);
          setValue("");
          onSaved();
        } else {
          setError(
            probe.ok
              ? "Saved, but the daemon didn't answer at that URL"
              : probe.error || "Saved, but couldn't reach the daemon",
          );
        }
      } else {
        setError(r.error || "Save failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const pill: ProviderState = running
    ? { status: "ok", detail: "Running" }
    : open
      ? { status: "running", detail: "Awaiting URL…" }
      : { status: "fail", detail: "Not running" };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 10px",
          height: 34,
          borderRadius: 6,
        }}
      >
        <ProviderLogo tool={provider.logo} size={13} />
        <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1, color: "var(--c-high)" }}>
          {provider.label}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {!frozen && !running && !open && <ActionButton label="Download" onClick={onDownload} />}
          {!frozen && !running && (
            <ActionButton
              label={open ? "Cancel" : "Set URL"}
              onClick={() => {
                if (open) {
                  setOpen(false);
                  setError(null);
                } else {
                  setOpen(true);
                }
              }}
            />
          )}
          <StatusPill state={pill} />
        </div>
      </div>
      {!frozen && open && !running && (
        <div style={{ padding: "4px 10px 8px 33px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              autoFocus
              placeholder="http://localhost:11434"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") {
                  setOpen(false);
                  setError(null);
                }
              }}
              style={{
                flex: 1,
                height: 26,
                padding: "0 8px",
                borderRadius: 5,
                background: "rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "var(--c-high)",
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={save}
              disabled={saving || !value.trim()}
              style={{
                height: 26,
                padding: "0 10px",
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 600,
                background: !value.trim() || saving ? "var(--secondary)" : ONB_BTN_BG,
                color: !value.trim() || saving ? "var(--m-text-3)" : ONB_BTN_FG,
                border: "none",
                cursor: !value.trim() || saving ? "default" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {error && (
            <div style={{ fontSize: 11, color: "rgb(248,113,113)" }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Snapshot a provider's readiness for the Continue gate / main-agent
 *  filter. Matches the dispatch logic in ScanWidget: CLI rows need
 *  `installed + authenticated` from the scan probe; Ollama needs the
 *  daemon to answer; API rows are ready as soon as their key is in
 *  the keychain (either via env probe or an inline save). */
function isProviderReady(
  p: ProviderDef,
  scan: ProviderScan | null,
  inlineSaved: Set<string>,
): boolean {
  if (inlineSaved.has(p.id)) return true;
  if (!scan) return false;
  if (p.scanKey) {
    const s = scan[p.scanKey];
    // The SDK has both a scanKey + envKey; its `authenticated` flag
    // covers the Gemini key. Pure CLIs need both flags.
    return s.installed && s.authenticated;
  }
  if (p.ollama) return scan.ollama.running;
  if (p.envKey) return !!scan.env_keys[p.envKey];
  return false;
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
  // Probe-less rows (no scanKey / ollama / envKey): not verifiable here, but
  // selecting them still enabled them — point the user to Settings. API
  // providers finish by pasting a key, so say "Add key in Settings" for them.
  return {
    status: "warn",
    detail: p.kind === "api" ? "Add key in Settings" : "Set up in Settings",
  };
}

function buildScanReadout(
  providers: ProviderDef[],
  scan: ProviderScan | null,
  inlineSaved: Set<string> = new Set(),
): string {
  if (!scan) {
    return "Couldn't reach the backend to verify — but you can finish setup any time from **Settings → Providers**.";
  }
  // Inline saves (API-key paste / Ollama URL set in the verify
  // widget) override the scan probe — the env-var / running-daemon
  // checks the probe runs don't see a keychain write or a config
  // file update until the next reload.
  const states = providers.map((p) => {
    const base = resolveProvider(p, scan);
    return {
      p,
      st: inlineSaved.has(p.id)
        ? ({ status: "ok" as ScanStatus, detail: "Ready" } as ProviderState)
        : base,
    };
  });
  const ready = states.filter((s) => s.st.status === "ok");
  const needs = states.filter((s) => s.st.status !== "ok");

  if (needs.length === 0) {
    return providers.length === 1
      ? `**${providers[0]!.label}** is good to go — installed, signed in, and reachable.`
      : `All set — ${humanList(providers.map((p) => `**${p.label}**`))} are ready.`;
  }
  // Use markdown list markers (`- `) instead of the Unicode bullet
  // (`•`) so ReactMarkdown renders each entry on its own row. With the
  // bullet character CommonMark treats the consecutive lines as a
  // single soft-broken paragraph and they wrap together — the screen
  // looked like one giant run-on sentence.
  if (ready.length === 0) {
    const lines = groupedNeeds(needs);
    return `Looks like a couple of things still need a touch:\n\n${lines}\n\nYou can finish setup from **Settings → Providers** any time.`;
  }
  const readyLine = humanList(ready.map((s) => `**${s.p.label}**`));
  const needLines = groupedNeeds(needs);
  return `${readyLine} ${ready.length === 1 ? "is" : "are"} ready. A couple still need attention:\n\n${needLines}\n\nYou can finish those from **Settings → Providers** whenever.`;
}

function humanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Predicate for a group of providers that share the same status `detail`, so
 *  the readout reads "X, Y and Z are not installed." instead of one line per
 *  provider. */
function needPredicate(detail: string, plural: boolean): string {
  const be = plural ? "are" : "is";
  const need = plural ? "need" : "needs";
  switch (detail) {
    case "Not installed": return `${be} not installed`;
    case "Not running": return `${be} not running`;
    case "Sign-in needed": return `still ${need} to sign in`;
    case "Add key in Settings": return `${need} a key in Settings`;
    case "Set up in Settings": return `${need} setup in Settings`;
    case "Python required": return `${need} Python`;
    case "Scan unreachable": return `couldn't be verified`;
    default: return `${be} not ready (${detail.toLowerCase()})`;
  }
}

/** Group not-ready providers by their status detail → one line each
 *  ("**X**, **Y** and **Z** are not installed."), in first-seen order. */
function groupedNeeds(needs: { p: ProviderDef; st: ProviderState }[]): string {
  const byDetail = new Map<string, string[]>();
  for (const { p, st } of needs) {
    const labels = byDetail.get(st.detail) ?? [];
    labels.push(`**${p.label}**`);
    byDetail.set(st.detail, labels);
  }
  return [...byDetail.entries()]
    .map(([detail, labels]) => `- ${humanList(labels)} ${needPredicate(detail, labels.length > 1)}.`)
    .join("\n");
}

/* ── GitHub widget — same panel chrome as providers/scan ─── */
/* ── Main-agent widget — single-select radio list ────────── */
export function MainAgentWidget({
  providers,
  tiles,
  onPick,
}: {
  providers: ProviderDef[];
  /** Catalog tiles — source the per-provider model list (see modelsForTile). */
  tiles?: ProviderTile[];
  onPick: (p: ProviderDef, modelId?: string, modelLabel?: string) => void;
}) {
  // Two stages: pick a provider, then pick a model. A provider whose model
  // list is empty (e.g. Ollama, models fetched live) or has exactly one
  // entry skips straight to onPick — no needless second click.
  const [picked, setPicked] = useState<ProviderDef | null>(null);

  // Live model catalogs — the SAME app-wide store the in-app composer / Fleet /
  // Settings pickers read. Without it this picker fell back to the static
  // CLI_MODELS list (CLI agents ship empty catalog `default_models`), so it
  // showed stale models while every other picker showed the current lineup.
  // `hydrate` (fired from OnboardingChat once the tiles land) covers the
  // remote-catalog agents with no local CLI spawn; `discoverLive` here adds the
  // live-probe agents (opencode / cursor / hermes) when the picker mounts,
  // mirroring chat-input's discover-on-picker-open.
  const discovered = useDiscoveredModelsStore((s) => s.models);
  useEffect(() => {
    if (tiles && tiles.length > 0) {
      void useDiscoveredModelsStore.getState().discoverLive(tiles, "");
    }
  }, [tiles]);

  const modelsFor = (p: ProviderDef): PickerModel[] => {
    const tile = tiles?.find((t) => t.spec.id === p.id);
    return tile ? modelsForTile(tile, discovered[p.id]) : [];
  };

  const choose = (p: ProviderDef) => {
    const models = modelsFor(p);
    if (models.length <= 1) {
      onPick(p, models[0]?.id, models[0]?.label);
      return;
    }
    setPicked(p);
  };

  const panelStyle: CSSProperties = {
    marginTop: 12,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.02)",
    boxShadow: "0 1px 0 rgba(255,255,255,0.025) inset, 0 6px 20px rgba(0,0,0,0.28)",
    overflow: "hidden",
    padding: 4,
    display: "flex",
    flexDirection: "column",
  };

  if (picked) {
    const models = modelsFor(picked);
    return (
      <div style={panelStyle}>
        <button
          onClick={() => setPicked(null)}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "0 10px", height: 30,
            margin: "1px 0", borderRadius: 5, background: "transparent", border: "none",
            color: "var(--m-text-3)", cursor: "pointer", textAlign: "left", fontSize: 11.5,
          }}
        >
          <span aria-hidden>←</span>
          <ProviderLogo tool={picked.logo} size={13} />
          <span>{picked.label} · choose a model</span>
        </button>
        {models.map((m) => (
          <ModelRow key={m.id} label={m.label} sub={m.ctx} onPick={() => onPick(picked, m.id, m.label)} />
        ))}
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      {providers.map((p) => (
        <MainAgentRow key={p.id} provider={p} onPick={() => choose(p)} />
      ))}
    </div>
  );
}

function ModelRow({
  label,
  sub,
  onPick,
}: {
  label: string;
  sub?: string;
  onPick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "0 10px", height: 34,
        margin: "1px 0", borderRadius: 5, background: hover ? "var(--secondary)" : "transparent",
        border: "none", color: "var(--m-text)", cursor: "pointer", textAlign: "left",
        transition: "background 0.12s ease",
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1, color: "var(--c-high)", flex: 1 }}>
        {label}
      </span>
      {sub && (
        <span style={{ fontSize: 10.5, color: "var(--m-text-3)", flexShrink: 0 }}>{sub}</span>
      )}
    </button>
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
      // ABORTED = user pressed Cancel; not an error worth surfacing.
      if (r && !r.ok && r.code !== "ABORTED") {
        setError(r.error || "GitHub OAuth didn't complete.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub.");
    } finally {
      setPending(null);
    }
  };

  // Best-effort abort of the in-flight Fleetify OAuth attempt. Resolves
  // the awaiting `beginOAuth` with `code: "ABORTED"` → pickOAuth's
  // finally clause clears `pending` and the Connect button re-enables.
  const cancelOAuth = async () => {
    try { await window.electronAPI?.github?.cancelOAuth?.(); } catch { /* best effort */ }
  };

  // Choice-row button — single-line, icon-left, title centered. Two
  // variants: "white" (Connect with GitHub, raised) and "black" (Use GitHub
  // CLI — recessed: the fill drops to the page color so it reads as an inset
  // field against the slightly-lighter card, with a crisp --c-brd2 border and
  // a hover-lift to --secondary. Was var(--secondary) which sat ~3 levels off
  // the card in dark theme, so the row looked like flat, dead space.)
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
    // Recessed "black" variant: base fill = page color (darker than the card),
    // hover lifts to --secondary so the row has real interactive feedback.
    const baseBg = isWhite ? ONB_BTN_BG : isBlack ? "var(--background)" : "rgba(255,255,255,0.025)";
    const hoverBg = isWhite ? ONB_BTN_BG : isBlack ? "var(--secondary)" : "rgba(255,255,255,0.08)";
    const baseBorder = isWhite
      ? "transparent"
      : isBlack
        ? "var(--c-brd2)"
        : "rgba(255,255,255,0.08)";
    const hoverBorder = isWhite
      ? "transparent"
      : isBlack
        ? "var(--c-brd2)"
        : "rgba(255,255,255,0.18)";
    const textColor = isWhite ? ONB_BTN_FG : isBlack ? "var(--c-high)" : "var(--m-text)";
    const iconColor = isWhite ? ONB_BTN_FG : isBlack ? "var(--c-high)" : "var(--m-text-2)";
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

      {pending === "oauth" && (
        <div
          style={{
            margin: "0 12px 11px",
            padding: "11px 12px",
            borderRadius: 8,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Loader2
            size={13}
            style={{
              animation: "spin 1s linear infinite",
              color: "var(--m-text-2)",
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: "var(--c-high)", lineHeight: 1.3 }}>
              Waiting for GitHub authorization…
            </div>
            <div style={{ fontSize: 11, color: "var(--m-text-3)", marginTop: 2 }}>
              Complete the flow in your browser, or cancel to try again.
            </div>
          </div>
          <button
            onClick={cancelOAuth}
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
              fontFamily: "inherit",
              flexShrink: 0,
            }}
          >
            Cancel
          </button>
        </div>
      )}

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
            color: "var(--m-text-2)",
            textDecoration: "underline",
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
