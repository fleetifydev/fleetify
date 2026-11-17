import { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/app-shell";
import { SplashScreen } from "@/components/onboarding/splash-screen";
import { WelcomeScreen } from "@/components/onboarding/welcome-screen";
import { SetupScreen } from "@/components/onboarding/setup-screen";
import { useAppStore } from "@/stores/app-store";
import { usePluginStore } from "@/stores/plugin-store";
import { clearToken, type AuthUser } from "@/lib/api";
import { handleAuthEvent } from "@/lib/auth-events";
import { identifyUser, initPostHog, pageview } from "@/lib/posthog";
import { isIntroComplete } from "@/lib/onboarding-gate";
import { showsLogoGallery } from "@/lib/dev-gallery";

// Heavy routes that are rarely the first surface a user sees — pulled
// out of the initial bundle so cold-start ships fewer KB of JS and the
// chat surface paints sooner. Each chunk is fetched only when the user
// actually navigates to it.
//
//   • SettingsPage   — ~1.3k LOC + lucide-react/icons + MCP plumbing.
//                      Returning users may go an entire session without
//                      opening it.
//   • OnboardingChat — ~2.2k LOC + react-markdown + remark-gfm. Only
//                      ever rendered for new sign-ups or users who
//                      haven't completed setup yet. Returning users on
//                      the main screen never pay for it.
//   • CommandPalette — ~750 LOC + lucide icons. Gated behind ⌘K; the
//                      vast majority of cold-starts never open it, so
//                      keep the module out of the entry chunk and only
//                      fetch when it's first toggled open.
//   • LogoGallery    — dev-only surface behind the #logos hash. Should
//                      NEVER be part of a production cold start.
const SettingsPage = lazy(() =>
  import("@/components/settings-page").then(m => ({ default: m.SettingsPage })),
);
// LibraryPage — full-viewport "what's installed" route, mounted under
// the same hide-the-shell pattern Settings uses. Lazy-imported because
// the page hangs off plugin-store + lucide-react and most cold starts
// never open it.
const LibraryPage = lazy(() =>
  import("@/components/library-page").then(m => ({ default: m.LibraryPage })),
);
const OnboardingChat = lazy(() =>
  import("@/components/onboarding/onboarding-chat").then(m => ({ default: m.OnboardingChat })),
);
const CommandPalette = lazy(() =>
  import("@/components/command-palette").then(m => ({ default: m.CommandPalette })),
);
const LogoGallery = lazy(() =>
  import("@/components/brand/logo-gallery").then(m => ({ default: m.LogoGallery })),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

// Resolve whether the one-time onboarding intro has already been completed
// on THIS device. The authoritative signal is the durable, device-scoped
// backend config (`fleet.config.json::onboardingComplete`), which survives
// sign-out/sign-in, app restarts, and run-mode/port changes. The legacy
// `fleet:setup-done` localStorage marker is origin-scoped (keyed by port),
// so it's honoured only as a migration path — and when it's the sole signal
// we promote it into the durable config so the gate stays correct from then
// on. Reads/writes are best-effort: a slow/absent IPC bridge must never
// strand the user, so failures fall through to "not complete".
async function resolveIntroComplete(): Promise<boolean> {
  const legacySetupDone = localStorage.getItem("fleet:setup-done") === "1";
  let cfg: FleetConfig | null = null;
  try {
    cfg = (await window.electronAPI?.getConfig?.()) ?? null;
  } catch {
    cfg = null;
  }
  const onboardingComplete = cfg?.onboardingComplete === true;
  const complete = isIntroComplete({ onboardingComplete, legacySetupDone });
  if (complete && !onboardingComplete) {
    // Migration backfill — config_set is a full replace, so spread the
    // existing config to avoid wiping routing/providers/telemetry/etc.
    try {
      const base: FleetConfig = cfg ?? { onboardingComplete: false, apiKeys: {} };
      await window.electronAPI?.setConfig?.({ ...base, onboardingComplete: true });
    } catch {
      /* best-effort */
    }
  }
  return complete;
}

type Screen = "splash" | "welcome" | "setup" | "onboarding-chat" | "main";

// Window dimensions per screen mode. Onboarding screens fit the
// welcome/setup content snugly. The chat-style onboarding wants
// vertical breathing room for the conversation. Main expands to a
// full editor canvas.
const ONBOARDING_SIZE = { w: 760, h: 740 };
const ONBOARDING_CHAT_SIZE = { w: 760, h: 820 };
const MAIN_SIZE = { w: 1500, h: 960 };

export function App() {
  const [screen, setScreen] = useState<Screen>("splash");
  const [introReveal, setIntroReveal] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string>("General");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [cmdPalette, setCmdPalette] = useState(false);
  // Sticky once-opened flag — gates the CommandPalette lazy chunk fetch.
  // First ⌘K downloads and mounts the palette; from then on the open
  // prop alone drives visibility so toggling stays instant.
  const [cmdPaletteEverOpened, setCmdPaletteEverOpened] = useState(false);
  useEffect(() => { if (cmdPalette) setCmdPaletteEverOpened(true); }, [cmdPalette]);

  // Track screen transitions as $pageview. Fleetify is a state-machine
  // app with no router, so autocapture can't synthesise these on its
  // own — manual emit keeps PostHog's Persons + funnel timelines
  // coherent across splash → welcome → setup → onboarding-chat → main.
  useEffect(() => {
    pageview(`/${screen}`, screen);
  }, [screen]);

  // Auto-update sweep, once per launch, the first time we reach the
  // authenticated shell (`screen === "main"`). The sweep talks to the
  // installs + catalog endpoints, which are only meaningful post-auth —
  // firing it earlier (splash/welcome) would hit them before sign-in and
  // no-op or 401. Gating on "main" + a ref guard means it runs exactly
  // once even if the user logs out and back in within the same session.
  // `usePluginStore.getState()` (not a hook subscription) keeps this off
  // the store's selector graph so it never re-subscribes / re-fires.
  const launchSweepDone = useRef(false);
  useEffect(() => {
    if (screen !== "main" || launchSweepDone.current) return;
    launchSweepDone.current = true;
    void (async () => {
      const store = usePluginStore.getState();
      await Promise.all([store.refreshInstalls(), store.refreshCatalog({ refresh: true })]);
      void usePluginStore.getState().autoUpdateSweep();
    })();
  }, [screen]);

  // Size the window to match the active screen mode. Onboarding screens
  // share one small size; entering main grows + recenters once.
  useEffect(() => {
    const target =
      screen === "main"
        ? MAIN_SIZE
        : screen === "onboarding-chat"
          ? ONBOARDING_CHAT_SIZE
          : ONBOARDING_SIZE;
    // Always recenter on a screen change: each mode has its own size
    // (760×820 vs 1500×960 etc.) and without recentering, shrinking
    // from the larger main canvas to the onboarding panel leaves the
    // smaller window anchored to the previous top-left — the user
    // sees it pinned to the side of where main used to sit.
    window.electronAPI?.setWindowSize(target.w, target.h, { center: true, animate: true });
  }, [screen]);

  // System-theme-aware OS taskbar icon. Light system ⇒ light taskbar ⇒
  // dark logo (so it stays visible). Dark system ⇒ light logo.
  useEffect(() => {
    const setTaskbar = window.electronAPI?.setTaskbarIcon;
    if (!setTaskbar) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      void setTaskbar(mq.matches ? "light" : "dark");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

// Verify token on startup before deciding which screen to show
  useEffect(() => {
    if (!window.fleetify) { setScreen("splash"); return; }

    // Product analytics: hand the wrapper the backend's device id and the
    // live opt-in. posthog-js starts only when that is on (off by default);
    // otherwise it isn't loaded until the user opts in.
    void window.electronAPI?.telemetryGetConfig?.()
      .then((cfg) => initPostHog({
        distinctId: cfg.distinct_id,
        enabled: cfg.posthog_enabled,
      }))
      .catch((err) => {
        // Don't tip over the renderer if the IPC bridge is slow / down —
        // PostHog stays uninitialised and all `capture(…)` calls no-op.
        console.warn("[posthog] bootstrap failed:", err);
      });

    window.fleetify.getState().then(async (state) => {
      // FLEETIFY_NOAUTH=1: shell stubs a "John Doe" identity and tags
      // the payload with `noAuth: true`. Treat the welcome/sign-in
      // step as already complete so the user lands on onboarding-chat
      // (or main, if setup-done) without seeing the Fleetify CTA.
      if (state.noAuth && state.signedIn && state.user) {
        localStorage.setItem("fleet:onboarded", "1");
      }
      const onboarded = localStorage.getItem("fleet:onboarded") === "1";
      if (!onboarded) { setScreen("splash"); return; }

      if (state.signedIn && state.user) {
        const u = state.user;
        const user: AuthUser = {
          id: u.sub ?? u.id ?? "",
          name: u.name ?? u.email?.split("@")[0] ?? "",
          email: u.email ?? "",
        };
        localStorage.setItem("fleet:user", JSON.stringify(user));
        setAuthedUser(user);
        // Product analytics: link this launch to the account too, with the id
        // only. Sends nothing while product analytics is off; the id is used
        // if the user opts in later in this session.
        identifyUser(user.id);
        // Returning users who haven't completed the intro yet land in the
        // chat-style onboarding once; everyone who already finished it (on
        // any port / run mode) goes straight to main.
        const introComplete = await resolveIntroComplete();
        setScreen(introComplete ? "main" : "onboarding-chat");
      } else {
        clearToken();
        localStorage.removeItem("fleet:onboarded");
        setScreen("splash");
      }
    }).catch((err) => {
      // IPC channel down at cold-start (preload not yet wired, main
      // process slow to spawn). Don't strand the user on splash —
      // route to the auth screen so they can retry sign-in manually.
      console.error("[auth] getState() failed:", err);
      setScreen("splash");
    });

    const off = window.fleetify.onAuthEvent((event) =>
      handleAuthEvent(event, {
        onSignedOut: () => {
          clearToken();
          setScreen("welcome");
        },
      }),
    );
    return off;
  }, []);

  const handleSplashDone = useCallback(() => setScreen("welcome"), []);

  const [authedUser, setAuthedUser] = useState<AuthUser | null>(null);

  const handleAuth = useCallback(async (user: AuthUser, _token: string, isNew: boolean) => {
    localStorage.setItem("fleet:onboarded", "1");
    localStorage.setItem("fleet:user", JSON.stringify(user));
    setAuthedUser(user);
    // Product analytics: link the device's events to the account, with the
    // user id only. Sends nothing while product analytics is off; the id is
    // used if the user opts in later in this session.
    identifyUser(user.id);

    // Read the durable config once. We persist the display name with a
    // read-merge-write (config_set is a full replace), and crucially we do
    // NOT mark onboardingComplete on sign-in — that flag means "the user
    // finished the intro" and is set only in handleOnboardingDone.
    let cfg: FleetConfig | null = null;
    try {
      cfg = (await window.electronAPI?.getConfig?.()) ?? null;
    } catch {
      cfg = null;
    }
    const base: FleetConfig = cfg ?? { onboardingComplete: false, apiKeys: {} };

    if (isNew) {
      // Fresh registration: force the intro exactly once — clear both the
      // legacy marker and the durable flag.
      localStorage.removeItem("fleet:setup-done");
      try {
        await window.electronAPI?.setConfig?.({ ...base, userName: user.name, onboardingComplete: false });
      } catch {
        /* best-effort */
      }
      setScreen("onboarding-chat");
      return;
    }

    // Returning users skip straight to main once they've completed the intro
    // on any device/port. Persist the name AND backfill the durable flag from
    // the legacy localStorage marker in a single write.
    const complete = isIntroComplete({
      onboardingComplete: cfg?.onboardingComplete === true,
      legacySetupDone: localStorage.getItem("fleet:setup-done") === "1",
    });
    try {
      await window.electronAPI?.setConfig?.({ ...base, userName: user.name, onboardingComplete: complete });
    } catch {
      /* best-effort */
    }
    setScreen(complete ? "main" : "onboarding-chat");
  }, []);

  const handleOnboardingDone = useCallback(() => {
    // Legacy origin-scoped marker — kept for back-compat with any reader.
    localStorage.setItem("fleet:setup-done", "1");
    // Authoritative, device-scoped completion flag. This is what makes the
    // intro a true one-time-per-device event across sign-out/sign-in, app
    // restarts and run-mode/port changes. Read-merge-write because
    // config_set replaces the whole file.
    void (async () => {
      try {
        const cfg = (await window.electronAPI?.getConfig?.()) ?? null;
        const base: FleetConfig = cfg ?? { onboardingComplete: false, apiKeys: {} };
        await window.electronAPI?.setConfig?.({ ...base, onboardingComplete: true });
      } catch {
        /* best-effort */
      }
    })();
    setIntroReveal(true);
    setScreen("main");
  }, []);

  const beginDraft = useAppStore(s => s.beginDraft);
  const handleCmdAction = useCallback((action: string) => {
    if (action === "open") { setCmdPalette(true); return; }
    setCmdPalette(false);
    if (action === "settings") setSettingsOpen(true);
    else if (action === "new-agent") void beginDraft();
  }, [beginDraft]);

  // Global settings listener — supports optional tab via CustomEvent detail
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab) setSettingsTab(tab);
      else setSettingsTab("General");
      setSettingsOpen(true);
    };
    window.addEventListener("fleet:open-settings", handler);
    return () => window.removeEventListener("fleet:open-settings", handler);
  }, []);

  // Library listener — sibling of the settings listener. Sidebar's
  // "Library" row dispatches ``fleet:open-library`` and any caller
  // (command palette, keyboard shortcut later) can use the same event
  // without needing a prop drilled down to the sidebar.
  useEffect(() => {
    const handler = () => setLibraryOpen(true);
    window.addEventListener("fleet:open-library", handler);
    return () => window.removeEventListener("fleet:open-library", handler);
  }, []);

  // Logout listener
  useEffect(() => {
    const handler = async () => {
      // No-auth dev mode keeps the "Sign out" button visible but inert —
      // there's nothing to sign out of and the welcome screen would just
      // bounce back to onboarding-chat anyway.
      try {
        const state = await window.fleetify?.getState();
        if (state?.noAuth) return;
      } catch { /* fall through to normal logout on IPC failure */ }
      try { await window.fleetify?.signOut(); } catch { /* best-effort */ }
      clearToken();
      setSettingsOpen(false);
      setScreen("welcome");
    };
    window.addEventListener("fleet:logout", handler);
    return () => window.removeEventListener("fleet:logout", handler);
  }, []);

  // Command palette event bus — allows useCommandPalette() hook to work from
  // any depth without prop drilling.
  useEffect(() => {
    const handler = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (action === "open")   setCmdPalette(true);
      else if (action === "close")  setCmdPalette(false);
      else if (action === "toggle") setCmdPalette(v => !v);
    };
    window.addEventListener("fleet:cmd-palette", handler);
    return () => window.removeEventListener("fleet:cmd-palette", handler);
  }, []);


  // Dev-only logo gallery — navigate to <app>/#logos to compare every
  // brand-mark candidate side-by-side at four sizes against light + dark
  // surfaces. Dev builds only (showsLogoGallery): a release build never
  // shows it, whatever the hash says.
  // Re-checks on hashchange so the gallery toggles without a refresh.
  const [showLogos, setShowLogos] = useState(
    typeof window !== "undefined" && showsLogoGallery(window.location.hash),
  );
  useEffect(() => {
    const onHash = () => setShowLogos(showsLogoGallery(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (showLogos) {
    return (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "var(--background)" }} />}>
          <LogoGallery />
        </Suspense>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/* Settings and Library are full-viewport ROUTES — when either
          is open it replaces the main shell entirely. AppShell stays
          mounted underneath via `display: none` so per-session
          WebSocket / poll state isn't torn down every time the user
          dips into one of these surfaces. */}
      {screen === "main" && (
        <div style={{ display: (settingsOpen || libraryOpen) ? "none" : "contents" }}>
          <AppShell introReveal={introReveal} />
        </div>
      )}
      {screen === "main" && settingsOpen && (
        // Suspense fallback is a transparent placeholder — the page
        // background is already painted underneath, so we just need to
        // hold the layout for the ~50ms it takes to fetch the chunk.
        <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "var(--background)" }} />}>
          <SettingsPage
            initialTab={settingsTab}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}
      {screen === "main" && libraryOpen && !settingsOpen && (
        // Settings takes precedence when both are open — the user
        // explicitly navigated there last and we don't want to stack
        // two full-viewport routes on top of each other.
        <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "var(--background)" }} />}>
          <LibraryPage onClose={() => setLibraryOpen(false)} />
        </Suspense>
      )}

      {screen === "splash"          && <SplashScreen onDone={handleSplashDone} />}
      {screen === "welcome"         && <WelcomeScreen onAuth={handleAuth} />}
      {screen === "setup"           && <SetupScreen onDone={handleOnboardingDone} />}
      {screen === "onboarding-chat" && (
        <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "var(--background)" }} />}>
          <OnboardingChat user={authedUser} onDone={handleOnboardingDone} />
        </Suspense>
      )}

      {/* Only mount the palette once it has actually been opened.
          Without this guard the lazy import would resolve immediately
          on first render (since <CommandPalette /> would mount with
          open=false), defeating the chunk split. After the first open
          we keep it mounted so the open/close toggle stays instant. */}
      {cmdPaletteEverOpened && (
        <Suspense fallback={null}>
          <CommandPalette open={cmdPalette} onClose={() => setCmdPalette(false)} onAction={handleCmdAction} />
        </Suspense>
      )}
    </QueryClientProvider>
  );
}
