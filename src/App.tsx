import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/app-shell";
import { SplashScreen } from "@/components/onboarding/splash-screen";
import { WelcomeScreen } from "@/components/onboarding/welcome-screen";
import { SetupScreen } from "@/components/onboarding/setup-screen";
import { useAppStore } from "@/stores/app-store";
import { clearToken, type AuthUser } from "@/lib/api";
import { identifyUser, initPostHog, pageview } from "@/lib/posthog";

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

    // Bootstrap PostHog as soon as we know the backend is wired —
    // before the auth gate so the anonymous funnel (welcome → sign-in)
    // is also captured under the same device_id. SDK is no-op while
    // opt-out: `posthog_enabled = false` (the default) → SDK loads but
    // suppresses sends; consent flips it via `telemetrySetPosthogEnabled`.
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

    window.fleetify.getState().then((state) => {
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
        // Returning users who haven't completed onboarding yet land
        // in the chat-style onboarding once.
        const setupDone = localStorage.getItem("fleet:setup-done") === "1";
        setScreen(setupDone ? "main" : "onboarding-chat");
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

    const off = window.fleetify.onAuthEvent((event) => {
      if (event.kind === "signed-out") {
        clearToken();
        setScreen("welcome");
      }
    });
    return off;
  }, []);

  const handleSplashDone = useCallback(() => setScreen("welcome"), []);

  const [authedUser, setAuthedUser] = useState<AuthUser | null>(null);

  const handleAuth = useCallback((user: AuthUser, _token: string, isNew: boolean) => {
    localStorage.setItem("fleet:onboarded", "1");
    localStorage.setItem("fleet:user", JSON.stringify(user));
    setAuthedUser(user);
    window.electronAPI?.setConfig({ onboardingComplete: true, apiKeys: {}, userName: user.name });
    // PostHog identity merge — frontend was emitting under the anonymous
    // device_id; calling identify(user_id) fires $identify with
    // $anon_distinct_id set, so PostHog server-side merges the two
    // persons. No-op when SDK isn't initialised (opt-out or no key).
    identifyUser(user.id, { is_new: isNew, name: user.name, email: user.email });
    // Fresh registrations land in the chat-style onboarding.
    // Returning users skip straight to main once they've completed it.
    if (isNew) {
      localStorage.removeItem("fleet:setup-done");
      setScreen("onboarding-chat");
    } else {
      const setupDone = localStorage.getItem("fleet:setup-done") === "1";
      setScreen(setupDone ? "main" : "onboarding-chat");
    }
  }, []);

  const handleOnboardingDone = useCallback(() => {
    localStorage.setItem("fleet:setup-done", "1");
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
  // surfaces. Pure dev surface; never renders in production paths.
  // Re-checks on hashchange so the gallery toggles without a refresh.
  const [showLogos, setShowLogos] = useState(
    typeof window !== "undefined" && window.location.hash === "#logos",
  );
  useEffect(() => {
    const onHash = () => setShowLogos(window.location.hash === "#logos");
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
