/**
 * PostHog product analytics — thin wrapper around posthog-js.
 *
 * Three-tier gating mirrors the Rust backend:
 *   1. Compile-time: `VITE_POSTHOG_KEY` unset at build → every function
 *      is a no-op, `isReady()` returns false. The SDK isn't even loaded.
 *   2. Initial state: `opts.enabled === false` on `initPostHog()` → SDK
 *      starts opted-out, so autocapture is suppressed until `optIn()`.
 *   3. Live opt-out: `optOut()` flips the SDK off without re-initing.
 *
 * `distinct_id` comes from the Rust backend's persisted `device_id`
 * (via the `telemetry_get_config` Tauri command). After OAuth sign-in,
 * `identifyUser(user_id, props)` merges the anonymous person into the
 * authenticated person via PostHog's `$anon_distinct_id` link — that
 * way pre-signin events stay attached to the same user post-signin.
 *
 * The SDK is lazy-loaded via dynamic import so cold-start ships fewer
 * KB of JS when the user opts out (or builds without a key).
 */

import type { PostHog } from "posthog-js";

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
  "https://us.i.posthog.com";

let phPromise: Promise<PostHog | null> | null = null;
let phInstance: PostHog | null = null;

function platformHint(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "win32";
  if (ua.includes("mac")) return "darwin";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

export function isReady(): boolean {
  return phInstance !== null;
}

/**
 * Lazy-init posthog-js with the backend-supplied distinct_id and the
 * user's persisted opt-in state. Idempotent — second call returns the
 * same instance. No-op when `VITE_POSTHOG_KEY` was unset at build time.
 */
export async function initPostHog(opts: {
  distinctId: string;
  enabled: boolean;
}): Promise<void> {
  if (!KEY) return;
  if (phInstance) return;
  if (!phPromise) {
    phPromise = import("posthog-js")
      .then((mod) => {
        const posthog = mod.default;
        posthog.init(KEY, {
          api_host: HOST,
          autocapture: true,
          // No router — we emit $pageview manually on screen/mainView
          // changes from App.tsx (PR 3).
          capture_pageview: false,
          persistence: "localStorage",
          // Session replay is excluded in v1 (privacy surface + extra
          // PostHog quota). Considered for a separate later PR with
          // its own re-consent step.
          disable_session_recording: true,
          opt_out_capturing_by_default: !opts.enabled,
          bootstrap: { distinctID: opts.distinctId },
          loaded: (ph) => {
            ph.register({ platform: platformHint() });
          },
        });
        phInstance = posthog;
        return posthog;
      })
      .catch((e) => {
        // Don't tank the renderer if the SDK chunk fails to load —
        // capture/identify/pageview become no-ops, the rest of the app
        // continues normally.
        console.warn("[posthog] SDK load failed:", e);
        return null;
      });
  }
  await phPromise;
}

/**
 * Tell PostHog the current user is `userId` and set person properties.
 * Fires a `$identify` event whose payload includes the previous
 * `distinct_id` as `$anon_distinct_id` — PostHog merges the two
 * persons server-side so pre-signin events stay attached.
 */
export function identifyUser(
  userId: string,
  props?: Record<string, unknown>,
): void {
  if (!phInstance) return;
  phInstance.identify(userId, props ?? {});
}

export function capture(
  event: string,
  props?: Record<string, unknown>,
): void {
  if (!phInstance) return;
  phInstance.capture(event, props ?? {});
}

/**
 * Manual `$pageview`. Fleetify is a state-machine app with no router,
 * so screen / mainView subscribers call this directly (PR 3).
 */
export function pageview(path: string, title?: string): void {
  if (!phInstance) return;
  phInstance.capture("$pageview", {
    $current_url: path,
    ...(title ? { title } : {}),
  });
}

export function optIn(): void {
  if (!phInstance) return;
  phInstance.opt_in_capturing();
}

export function optOut(): void {
  if (!phInstance) return;
  phInstance.opt_out_capturing();
}
