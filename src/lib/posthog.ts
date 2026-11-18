/**
 * PostHog product analytics — thin wrapper around posthog-js.
 *
 * posthog-js is not loaded until the user opts in (Settings → Privacy →
 * Product analytics, or the last onboarding question). While product
 * analytics is off nothing here imports or starts it, so the renderer makes
 * no request to PostHog: no events, no remote config, no feature flags.
 *
 * Once started, it sends only the events Fleetify captures itself
 * (`INIT_OPTIONS`). Everything posthog-js would otherwise do on its own is
 * off: autocapture, exception, dead-click, heatmap and web-vitals capture,
 * session replay, surveys, product tours and conversations. It also never
 * fetches remote config or flags from PostHog or loads scripts from it.
 *
 * Turning it off again in the same session opts posthog-js out and drops
 * every request it would still make (see `guardRequests`).
 *
 * `distinct_id` is the Rust backend's persisted `device_id` (from the
 * `telemetry_get_config` command), so renderer and backend events land on
 * one PostHog person. `identifyUser(user_id)` links that person to the
 * account, with the id only: no event carries person properties
 * (`dropPersonProperties`).
 *
 * `VITE_POSTHOG_KEY` unset at build → every function is a no-op.
 */

import type { CaptureResult, PostHog, PostHogConfig } from "posthog-js";

const projectKey = () => (import.meta.env.VITE_POSTHOG_KEY as string | undefined) || undefined;
/** `VITE_POSTHOG_HOST`, or PostHog Cloud's EU region (the backend's `posthog::DEFAULT_HOST`). */
const apiHost = () =>
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || "https://eu.i.posthog.com";

/**
 * Everything posthog-js would send or fetch beyond Fleetify's own events
 * is off. Each of these is checked against the posthog-js source:
 * remote config and `/flags` are skipped with `advanced_disable_flags`;
 * the explicit `capture_*` / `disable_*` values also beat server-side
 * settings that older builds may have stored locally; and no extension
 * script is fetched from PostHog's asset host.
 */
const INIT_OPTIONS = {
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_heatmaps: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_conversations: true,
  disable_product_tours: true,
  disable_web_experiments: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  persistence: "localStorage",
} satisfies Partial<PostHogConfig>;

/**
 * posthog-js adds person properties of its own: `$identify`, and the first
 * event after each launch once the user is identified, get `$set_once` with
 * the first address and referrer it saw on this device and in this session
 * (`$initial_current_url`, `$initial_referrer`, `$current_url`, …, and every
 * campaign key). Fleetify identifies with the id only, so `before_send`
 * strips `$set` and `$set_once` from every event before it is queued.
 */
function dropPersonProperties(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  const { $set: _set, $set_once: _setOnce, ...rest } = event;
  const { $set: _propsSet, $set_once: _propsSetOnce, ...properties } = event.properties;
  return { ...rest, properties };
}

/** The user's current choice. */
let enabled = false;
/** Set once the user chooses in this session; the launch read can't undo it. */
let chosen = false;
let distinctId: string | null = null;
/** An account to identify once posthog-js runs (sign-in before opt-in). */
let pendingUserId: string | null = null;
let loading: Promise<void> | null = null;
let phInstance: PostHog | null = null;

function platformHint(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "win32";
  if (ua.includes("mac")) return "darwin";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

/** True while posthog-js runs and the user has it on. */
export function isReady(): boolean {
  return phInstance !== null && enabled;
}

/**
 * Called once at launch with the backend's device id and the saved choice.
 * Starts posthog-js only when that choice is on; otherwise it isn't loaded,
 * and what an older build stored for it is removed.
 */
export async function initPostHog(opts: {
  distinctId: string;
  enabled: boolean;
}): Promise<void> {
  distinctId = opts.distinctId;
  if (!chosen) enabled = opts.enabled;
  if (enabled) {
    await start();
  } else if (!phInstance) {
    removeStoredState();
  }
}

/**
 * Older builds started posthog-js for everyone, and it kept its state in
 * localStorage, including the name and email they identified users with.
 * Remove that entry (named as posthog-js names it) and nothing else,
 * without loading posthog-js to do it.
 */
function removeStoredState(): void {
  const key = projectKey();
  if (!key) return;
  const token = key.replace(/\+/g, "PL").replace(/\//g, "SL").replace(/=/g, "EQ");
  try {
    localStorage.removeItem(`ph_${token}_posthog`);
  } catch {
    /* storage unavailable: nothing to remove */
  }
}

function start(): Promise<void> {
  const key = projectKey();
  if (phInstance || !key || !distinctId) return Promise.resolve();
  if (!loading) {
    const bootstrapId = distinctId;
    loading = import("posthog-js")
      .then(({ default: posthog }) => {
        // Turned off again while it was loading: don't start it.
        if (!enabled || phInstance) return;
        posthog.init(key, {
          ...INIT_OPTIONS,
          api_host: apiHost(),
          bootstrap: { distinctID: bootstrapId },
          loaded: (ph) => {
            ph.register({ platform: platformHint() });
          },
          before_send: dropPersonProperties,
        });
        guardRequests(posthog);
        // An older build may have stored an opt-out, which would keep
        // posthog-js silent despite this opt-in. No $opt_in event: it isn't
        // one of the events we document.
        if (posthog.has_opted_out_capturing()) {
          posthog.opt_in_capturing({ captureEventName: false });
        }
        // Older builds identified users with their name and email, which
        // posthog-js keeps for flag requests. Drop them.
        posthog.resetPersonPropertiesForFlags();
        phInstance = posthog;
        identifyPending();
      })
      .catch((e) => {
        // Don't tank the renderer if the SDK chunk fails to load —
        // capture/identify/pageview stay no-ops.
        console.warn("[posthog] SDK load failed:", e);
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/**
 * posthog-js's own opt-out stops new captures, but it still flushes the
 * events it has queued and retries failed sends. Every request it makes
 * goes through `_send_request` (posthog-js 1.376), so drop them there while
 * the user has product analytics off.
 */
function guardRequests(posthog: PostHog): void {
  const send = posthog._send_request.bind(posthog);
  posthog._send_request = (options) => {
    if (enabled) send(options);
  };
}

function identifyPending(): void {
  if (!phInstance || !enabled || !pendingUserId) return;
  phInstance.identify(pendingUserId);
  pendingUserId = null;
}

/**
 * Link product analytics to the signed-in account: the user id only, no
 * name, email or other person properties. While product analytics is off
 * nothing is sent; the id is kept in memory and used if the user opts in
 * later in this session.
 */
export function identifyUser(userId: string): void {
  pendingUserId = userId;
  identifyPending();
}

/**
 * The user signed out. Forget the account, so whoever signs in next on this
 * machine isn't linked to it: the id kept for a later opt-in goes, and a
 * running posthog-js resets to a new anonymous id. posthog-js isn't loaded
 * for this; when it isn't running, it holds no account to forget.
 */
export function resetIdentity(): void {
  pendingUserId = null;
  if (!phInstance) return;
  // Not reset(true): $device_id stays this install's id.
  phInstance.reset();
  // reset() clears every super property, Fleetify's own included…
  phInstance.register({ platform: platformHint() });
  // …and posthog-js's stored consent, so an opt-out made in this session
  // has to be stored again.
  if (!enabled) phInstance.opt_out_capturing();
}

export function capture(
  event: string,
  props?: Record<string, unknown>,
): void {
  if (!isReady()) return;
  phInstance?.capture(event, props ?? {});
}

/**
 * Manual `$pageview`. Fleetify is a state-machine app with no router,
 * so screen / mainView subscribers call this directly (PR 3).
 */
export function pageview(path: string, title?: string): void {
  if (!isReady()) return;
  phInstance?.capture("$pageview", {
    $current_url: path,
    ...(title ? { title } : {}),
  });
}

/** The user turned product analytics on: start posthog-js, or resume it. */
export function optIn(): void {
  enabled = true;
  chosen = true;
  if (!phInstance) {
    void start();
    return;
  }
  phInstance.opt_in_capturing({ captureEventName: false });
  identifyPending();
}

/** The user turned product analytics off: nothing more leaves the renderer. */
export function optOut(): void {
  enabled = false;
  chosen = true;
  phInstance?.opt_out_capturing();
}
