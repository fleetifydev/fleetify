# Fleetify analytics — what we send, what we don't

Fleetify ships two completely independent telemetry channels. Both are
opt-in or opt-out from the same place: **Settings → General → Privacy**.

| Channel | Vendor | Default | Toggle |
|---|---|---|---|
| Anonymous usage analytics | Fleetify cloud (`fleetify.dev`) | **ON** | Privacy → "Anonymous usage analytics" |
| Crash reports | Fleetify cloud | **ON** | Privacy → "Crash reports" |
| Product analytics | PostHog Cloud (US: `us.i.posthog.com`) | **OFF** | Privacy → "Product analytics (PostHog)" |

PostHog is the topic of this document. The two cloud channels above are
described in their own subsections of the product help.

---

## What PostHog receives

Every event carries a stable per-machine `distinct_id` — the same UUID
v4 persisted in `~/.fleetify/device.json`. After OAuth sign-in,
Fleetify calls `posthog.identify(user_id)` so the anonymous person
merges into the authenticated one via `$anon_distinct_id`. From then
on, `distinct_id == user_id`.

### Backend events (Rust)

These flow from `crates/fleetify-backend/src/services/telemetry/emitters.rs`
through the `enqueue_payload` fan-out, get translated by
`posthog/mapper.rs`, queued in `~/.fleetify/posthog-outbox.sqlite`, and
POSTed in batches every 10s by the worker.

| Event | Trigger | Properties (kept) | What is **dropped** |
|---|---|---|---|
| `session_started` | New chat session created | `provider` (tool id), `model`, `status`, `project_id_hash` (SHA-256, 16 chars), `session_id_hash` | `session_title`, raw `project_path` |
| `session_ended` | Session closed | `provider`, `session_id_hash` | — |
| `tokens_used` | Cost event from a bridge | `model`, `input_tokens`, `output_tokens`, `cache_read`, `cache_write`, `cost_usd`, `session_id_hash` | `routing_decision_id` (internal) |
| `session_status_changed` | Bridge status transition | `status`, `session_id_hash` | — |
| `agent_activity` | Tool call observed | `activity_kind`, `session_id_hash` | `activity_summary` (may carry user content) |
| `provider_connected` | API key saved in Settings | `provider` | — |
| `provider_disconnected` | Provider tile "Disconnect" clicked | `provider` | — |
| `provider_tested` | "Test Connection" button result | `provider`, `ok`, `code`, `latency_ms` | — |
| `agent_detected` | `/api/agents/scan` observation | `agent`, `installed`, `authenticated` | — |
| `app_started` | Backend boot | `version`, `platform` (darwin/win32/linux) | — |

**Never** sent under any circumstance:
- Prompt content
- Assistant replies
- API keys (live in OS keychain, never read by telemetry code)
- Raw file paths or file contents
- Session titles
- Activity summaries
- WebSocket frame bodies

`device_heartbeat` (60 s cadence) is **explicitly dropped** by the PostHog
mapper — Fleetify cloud gets it; PostHog does not (would chew through the
free-tier quota for no analytical gain).

### Frontend events (TypeScript)

These fire from `src/lib/posthog.ts` callers in the renderer.

| Event | Trigger | Properties |
|---|---|---|
| `$pageview` | Screen transition (splash → welcome → setup → onboarding-chat → main) | `$current_url` (`/<screen>`), `title` |
| `onboarding_started` | OnboardingChat first mount | — |
| `onboarding_completed` | "Enter Fleet" reached via consent step | `telemetry_opt_in` |
| `message_sent` | Chat send button | `session_id_short` (first 8 chars), `text_length`, `has_attachments`, `attachment_count` |
| `message_error` | Send failed (network / auth) | `session_id_short`, `error_message` |
| `default_provider_set` | Settings → Providers default picker | `provider_id` |
| `frontend_error` | `window.onerror` or `unhandledrejection` | `source`, `message`, `filename?`, `line?`, `col?`, `stack?` |
| `$identify` | After OAuth sign-in | `is_new`, `name`, `email` (via `$set`), `$anon_distinct_id` = previous device_id |

**Autocapture is also on** — PostHog records click / pageleave events for
DOM elements in the renderer. We do NOT enable Session Replay (no
keystroke / DOM recording).

### Hashed vs raw IDs

Anything that could correlate Fleetify-internal state to a person —
`session_id`, `project_path` — is hashed with SHA-256 and truncated to 16
hex chars before crossing the wire. PostHog can group events into
sessions without learning Fleetify's internal IDs.

---

## How to opt out

- **At onboarding:** the consent step before "Enter Fleet" is opt-IN.
  Clicking "Not now" is the default — no events leave the machine.
- **Later:** **Settings → General → Privacy** has a third toggle,
  "Product analytics (PostHog)". Flipping it off:
  1. Calls `posthog.opt_out_capturing()` in the renderer — new
     autocapture events stop instantly.
  2. Invokes the `telemetry_set_posthog_enabled(false)` Tauri command,
     which (a) persists the flag in `fleet.config.json`, and (b) closes
     the backend's runtime gate so no new `session_started` /
     `tokens_used` / etc. events get queued.
- **At build time:** if `POSTHOG_API_KEY` was unset when the Fleetify
  binary was compiled, the entire backend module is a no-op. The
  frontend wrapper similarly stubs out when `VITE_POSTHOG_KEY` is unset.

Once disabled, queued events in `~/.fleetify/posthog-outbox.sqlite` stop
draining (the worker re-checks the gate each tick). You can also wipe
the file directly — the next launch will recreate an empty one.

---

## How to verify (for ops + curious users)

While the app is running with the gate open:

```bash
# Backend queue depth:
sqlite3 ~/.fleetify/posthog-outbox.sqlite \
  'SELECT count(*), MAX(attempt_count) FROM posthog_events'

# What the worker last sent (filter the renderer logs):
grep -F fleetify.posthog ~/.local/state/Fleetify/logs/fleetify.log.*
```

PostHog Cloud's **Live events** tab is the simplest end-to-end check —
events show up there within ~5 seconds of leaving the machine.
