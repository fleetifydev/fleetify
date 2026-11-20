# Fleetify analytics — what we send, what we don't

Fleetify has two independent telemetry channels. Dashboard sync is on by
default, and you can turn it off at any time; product analytics is off
until you turn it on. Both are switched in **Settings → General →
Privacy**.

| Channel | Destination | Default | Settings |
|---|---|---|---|
| `Dashboard sync` | Fleetify cloud (`fleetify.dev`) | **ON** | Privacy → Dashboard sync |
| `Product analytics` | PostHog Cloud (EU, Frankfurt) | **OFF** | Privacy → Product analytics |

PostHog derives an approximate location, such as the country and city,
from the IP address each event comes from; Fleetify's PostHog project
then discards the address.

Onboarding ends with one step for each. The first tells you what
dashboard sync sends and that it is on, with two buttons: **Keep it on**
and **Turn it off**. The second asks about product analytics, and **Not
now** leaves it off. Dashboard sync starts once you answer the dashboard
step; after that it is on unless you turn it off. If you leave
onboarding before answering, both channels stay off. If you go through
onboarding again after turning dashboard sync off, that step says it is
off, with **Keep it off** and **Turn it on**. If you finished onboarding
before it had the dashboard step, Fleetify asks you that question one
time, once you're signed in, and sends nothing to the dashboard until you
answer.

---

## Dashboard sync

Shows your sessions on your fleetify.dev dashboard. It is linked to your
Fleetify account: while it is on, the app asks `fleetify.dev` for a ticket
with your sign-in token and this install's device id (a random UUID kept in
`~/.fleetify/device.json`), then keeps one WebSocket open to it.

### On by default, with a switch

Dashboard sync starts only once you answer. On a new
installation, that is when you answer the dashboard step during
onboarding; after that it is on unless you turn it off. That step tells
you what it sends, and either of its buttons saves your choice. An
installation that finished onboarding before that step existed has no
saved choice, so Fleetify asks it the same question, with the same two
buttons, one time, once you're signed in. Nothing is sent to the dashboard
until you answer. If your answer can't be saved, it holds until Fleetify
restarts, and the next launch asks again.
**Settings → General → Privacy → Dashboard sync** turns it off, or back
on, at any time. If you turned off the **Anonymous usage analytics**
switch in an earlier version, sync stays off, and you aren't asked.

A settings file (`fleet.config.json`) that exists but can't be read or
parsed keeps sync off until you turn it on again: sync stays off for that
launch, and Fleetify saves it as off. A file that couldn't be parsed is
first copied next to it as `fleet.config.json.corrupt-<hash>`; one that
couldn't be read is moved aside, whole, as
`fleet.config.json.unreadable-<timestamp>`.

### What dashboard sync sends

Six event kinds, built in
`crates/fleetify-backend/src/services/telemetry/emitters.rs`. Before an
event is queued, and again just before it is sent, `cloud_view` deletes
its `activity_summary` and cuts its `project_path` down to the folder
name (`~` for your home folder itself). What is left is everything that
leaves the machine:

| Event (`kind`) | When | Fields |
|---|---|---|
| `session_start` | A session is created | `local_session_id`, `tool`, `model`, `status`, `session_title`, `project_path`, `occurred_at` |
| `session_stop` | A session is deleted | `local_session_id`, `tool`, `status` (always `stopped`), `occurred_at` |
| `cost` | An agent turn reports its usage | `local_session_id`, `model`, `input_tokens`, `output_tokens`, `cache_read`, `cache_write`, `cost_usd`, `occurred_at`, and `routing_decision_id` when Fleet routed the turn |
| `status_change` | A session changes state | `local_session_id`, `status` (`running`, `idle`, `error` or `stopped`), `occurred_at` |
| `activity` | An agent finishes a tool call | `local_session_id`, `activity_kind`, `occurred_at` |
| `device_heartbeat` | Every 60 seconds | `occurred_at`, `catalog_commit`, `catalog_tag`, `catalog_bucket` |

Each event also carries its `kind`, and goes out as
`{ "v": 1, "type": "event", "id": "<random UUID>", "payload": { … } }`.

What the fields hold:

- **`session_title`**: the session's title when it is created, at most
  200 characters: the project folder's name, a name you typed (such as a
  routine's name), or a fixed label such as "Staff Agent" for the Fleet
  hub's own session. Renaming a session later, by hand or automatically,
  sends nothing. For a session in your home folder, a title equal to that
  folder's name is sent as `~`.
- **`project_path`**: the folder name only, such as `fleetify` for
  `/home/you/code/fleetify`, never the full path. Your home folder itself
  is sent as `~` (also when you reach it through a symlink), so the Fleet
  hub's own session, which runs there, does not send your OS user name.
- **`activity_kind`**: one of `file_edit`, `file_read`, `command`,
  `web_fetch`, `plan`, `todo`, `tool` or `error`. Activity summaries (the
  command, file path, URL, search query, prompt or to-do text behind an
  action) are never sent.
- **`tool`** and **`model`**: the agent or provider (`claude-code`,
  `openai`, …) and the model id.
- **Token and cost fields**: the counts the provider reported, and the
  cost in US dollars as a string with six decimals.
- **`local_session_id`**, **`routing_decision_id`**: random ids Fleetify
  generates, so the dashboard can group events.
- **`catalog_commit`**, **`catalog_tag`**, **`catalog_bucket`**: the
  version of the model catalog this install runs, and its rollout slice
  (0–99, derived from the device id).

### Never sent

- Code and file contents
- Shell commands that agents run, or their output
- Full paths
- Prompts or replies beyond the session title
- API keys (they stay in your OS keychain)

### Turning sync off

Switching **Dashboard sync** off closes the connection to `fleetify.dev`
at once and deletes everything still queued in
`~/.fleetify/telemetry-outbox.sqlite`, so nothing recorded earlier goes
out later. While sync is off, nothing is queued and no connection is
opened. Turning it off does not delete what was already sent.

If your choice can't be saved, the switch says so under the row; the
change still applies until Fleetify restarts.

---

## Product analytics (PostHog)

### What PostHog receives

Fleetify doesn't load posthog-js, the PostHog library in the renderer,
until you opt in. While product analytics is off, the renderer sends
PostHog nothing at all. At each launch while it is off, the renderer
also deletes `ph_<project key>_posthog`, the local-storage entry where
older versions kept posthog-js's state, including the name and email
they identified you with. posthog-js's consent flag,
`__ph_opt_in_out_<project key>`, stays: it records only whether you
opted in or out. Once product analytics is on, posthog-js never fetches
remote config or feature flags from PostHog and loads no scripts from
it. Turning it off again stops every further request, including events
posthog-js had queued or was retrying.

Every event carries a stable per-machine `distinct_id`: the same UUID
v4 persisted in `~/.fleetify/device.json`. When you sign in, and at each
launch while you're signed in, Fleetify calls `posthog.identify(user_id)`
with the id only, so PostHog links this device's events, earlier ones
included, to your Fleetify account (via `$anon_distinct_id`). While
product analytics is off that sends nothing; if you turn it on later, it
happens then. From then on the app's own events use your `user_id` as
their `distinct_id`; backend events keep the device id, which PostHog
has linked to you. Product analytics is linked to your account, not
anonymous.

When you sign out, Fleetify makes posthog-js forget your account: the
app's events carry a new random `distinct_id` until you sign in again or
Fleetify restarts. That random id is then the previous anonymous id: if
you sign in again before a restart, to this account or another, PostHog
links it, and the events sent with it, to the account that signed in.
Backend events still carry the device id, and so do the app's events
after a restart until you sign in; PostHog may keep that id linked to an
account that signed in on this device before.

The product analytics and dashboard sync choices and the device id belong
to your OS user profile, not to your Fleetify account: every account that
signs in to Fleetify as the same OS user shares them.

On its own, posthog-js would also attach person properties to some
events: `$set_once` with the first address and referrer it saw, such as
`$initial_current_url` and `$initial_referrer`. Fleetify removes `$set`
and `$set_once` from every event before posthog-js queues it, so the app
sends no name, email or other person property.

### Backend events (Rust)

These flow from `crates/fleetify-backend/src/services/telemetry/emitters.rs`
through the `enqueue_payload` fan-out, get translated by
`posthog/mapper.rs`, queued in `~/.fleetify/posthog-outbox.sqlite`, and
POSTed in batches every 10s by the worker.

| Event | Trigger | Properties (kept) | What is **dropped** |
|---|---|---|---|
| `session_started` | New chat session created | `provider` (tool id), `model`, `status`, `project_id_hash` (SHA-256, 16 chars), `session_id_hash` | `session_title`, raw `project_path` |
| `session_ended` | Session closed | `provider`, `status`, `session_id_hash` | — |
| `tokens_used` | Cost event from a bridge | `model`, `input_tokens`, `output_tokens`, `cache_read`, `cache_write`, `cost_usd`, `session_id_hash` | `routing_decision_id` (internal) |
| `session_status_changed` | Bridge status transition | `status`, `session_id_hash` | — |
| `agent_activity` | Tool call observed | `activity_kind`, `session_id_hash` | `activity_summary` (may carry user content) |
| `provider_connected` | API key saved in Settings | `provider` | — |
| `provider_disconnected` | Provider tile "Disconnect" clicked | `provider` | — |
| `provider_tested` | "Test Connection" button result | `provider`, `ok`, `code`, `latency_ms` | — |
| `agent_detected` | `/api/agents/scan` observation | `agent`, `installed`, `authenticated` | — |
| `app_started` | Backend boot | `version`, `platform` (darwin/win32/linux) | — |

Backend events never carry:
- Prompt content
- Assistant replies
- API keys (live in OS keychain, never read by telemetry code)
- Raw file paths or file contents
- Session titles
- Activity summaries
- WebSocket frame bodies

`device_heartbeat` (60 s cadence) is **explicitly dropped** by the PostHog
mapper — dashboard sync sends it (when it is on); PostHog does not (would
chew through the free-tier quota for no analytical gain).

### Frontend events (TypeScript)

These fire from `src/lib/posthog.ts` callers in the renderer.

| Event | Trigger | Properties |
|---|---|---|
| `$pageview` | Screen transition (splash → welcome → setup → onboarding-chat → main) | `$current_url` (`/<screen>`), `title` (the page title, `Fleetify — AI Agent Orchestrator`) |
| `onboarding_started` | OnboardingChat first mount | — |
| `onboarding_completed` | Onboarding's last question answered | `telemetry_opt_in` |
| `message_sent` | Chat send button | `session_id_short` (first 8 chars), `text_length`, `has_attachments`, `attachment_count` |
| `message_error` | Send failed (network / auth) | `session_id_short`, `error_type` (the error's class, never its message) |
| `session_default_set` | Settings → Providers → Sessions Default picker | `provider_id` |
| `frontend_error` | `window.onerror`, `unhandledrejection`, or a render error that brings up the recovery screen | `source` (`uncaught`, `unhandled-rejection` or `render`), `error_type` (the error's class, such as `TypeError`, or its JS type; never its message or stack) |
| `$identify` | At sign-in, at each launch while signed in, or at opt-in | `distinct_id` = your `user_id`, `$anon_distinct_id` = the previous anonymous id: the device id, or after a sign-out in the same session, the random id the sign-out gave the app's events |

posthog-js adds its standard properties to every event, such as `$os`,
`$os_version`, `$browser`, `$browser_version`, `$device_type`,
`$raw_user_agent` (the WebView's user agent), `$screen_height`,
`$screen_width`, `$viewport_height`, `$viewport_width`, `$timezone`,
`$timezone_offset`, `$browser_language`, `$current_url`, `$host` and
`$pathname` (the app window's local address, such as
`http://127.0.0.1:8765/`; `$pageview` sets its own `$current_url`),
`$referrer` and `$referring_domain` (`$direct` in the app), the same
address for the session's first screen (`$session_entry_url`,
`$session_entry_host`, …), `$device_id` (the device id above),
`$user_id` once you're identified, `$session_id`, `$window_id`, `$lib`
and `$lib_version` (posthog-js and its version), `$insert_id`, `$time`
and `token` (the project key). Fleetify adds `platform` (`win32`,
`darwin` or `linux`). PostHog's servers may copy some of these, such as
`$browser`, `$os` and `$current_url`, onto your person profile.

**Autocapture is off.** The renderer sends only the events in the table
above: no clicks, element text or attributes, no exception or dead-click
capture, and no Session Replay (no keystroke / DOM recording).

### Hashed vs raw IDs

Backend events hash `session_id` and `project_path` with SHA-256,
truncated to 16 hex chars, before they leave the machine. The renderer's
`message_sent` and `message_error` events send `session_id_short`, the
first 8 characters of the raw session id (a random UUID).

---

## How to opt out of product analytics

- **At onboarding:** the product analytics question, the last one before
  "Enter Fleet", is opt-IN. Clicking "Not now" keeps it off, and nothing
  is sent to PostHog.
- **Later:** **Settings → General → Privacy → Product analytics**.
  Flipping it off:
  1. Opts posthog-js out in the renderer and drops every request it
     would still make, including events it had queued or was retrying.
  2. Invokes the `telemetry_set_posthog_enabled(false)` Tauri command,
     which (a) persists the flag in `fleet.config.json`, and (b) closes
     the backend's runtime gate so no new `session_started` /
     `tokens_used` / etc. events get queued. If the flag can't be saved,
     the switch shows why, and the change lasts until Fleetify restarts.
- **Without a key:** if `POSTHOG_API_KEY` isn't set in the backend's
  environment, the entire backend module is a no-op. The frontend
  wrapper similarly stubs out when the build had no `VITE_POSTHOG_KEY`.

Once disabled, queued events in `~/.fleetify/posthog-outbox.sqlite` stop
draining (the worker re-checks the gate each tick). You can also wipe
the file directly — the next launch will recreate an empty one.

---

## How to verify product analytics (for ops + curious users)

While the app is running with the gate open:

```bash
# Backend queue depth:
sqlite3 ~/.fleetify/posthog-outbox.sqlite \
  'SELECT count(*), MAX(attempt_count) FROM posthog_events'

# What the worker last sent (filter the renderer logs):
grep -F fleetify.posthog ~/.local/state/fleetify/logs/fleetify.log.*
```

PostHog Cloud's **Live events** tab is the simplest end-to-end check —
events show up there within ~5 seconds of leaving the machine.
