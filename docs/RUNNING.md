# Running Fleetify from source

How to run, test and build Fleetify from a checkout, and how to configure a
development build. [CONTRIBUTING.md](../CONTRIBUTING.md) covers the setup and
the checks every pull request must pass; [INSTALL.md](INSTALL.md) covers
installing a release.

## Architecture in one paragraph

`crates/fleetify-backend` is a **library** crate (no `main.rs`). Its
`serve(addr, ServeOptions)` entry point binds an `axum` router on
`127.0.0.1:8765` and returns a `ServerHandle`. The Tauri binary
(`src-tauri/fleetify-app`) calls `fleetify_backend::serve(...)` from its
`setup` hook on a tokio task — same process, same address space. A
release build serves the UI from files embedded in the binary, on the
same origin and under a Content-Security-Policy, so there's no CORS in
prod and no port forwarding anywhere. A debug build loads the UI from the
Vite dev server.

```
fleetify-app (single Tauri binary)
  ├─ window (WebView) → http://127.0.0.1:8765/ → React UI (debug: the Vite dev server)
  ├─ embedded axum @ 127.0.0.1:8765 (background task)
  │   ├─ /api/*      ← every router
  │   ├─ /ws/*       ← chat WebSocket
  │   ├─ /events/*   ← SSE
  │   └─ /healthz
  ├─ Tauri IPC commands
  │   ├─ auth (sign-in / token / sign-out)
  │   ├─ fs / git / pty / dialog
  │   └─ AI git (commit msg / PR summary / review / diagnose / apply)
  └─ Telemetry pipeline (background tasks, see ANALYTICS.md)
      ├─ outbox (SQLite WAL at ~/.fleetify/telemetry-outbox.sqlite)
      ├─ heartbeat loop (every 60 s)
      └─ ws_client loop → wss://fleetify.dev/api/realtime/connect
```

## Dev loop

### Prereqs

- **Git**, **Node 22** and **Rust** (stable, through [rustup](https://rustup.rs)),
  plus the system packages for your OS: [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup)
  lists them.
- Optional: agent CLIs such as **claude**, **codex** or **opencode** on `PATH`
  for the CLI agents, and **gh** for the pull-request flow.

### Run

```bash
npm ci                 # frontend deps, exactly as package-lock.json pins them
npm run dev:tauri:wt   # sidecars + Vite + the Tauri shell, in a debug build
```

`dev:tauri:wt` builds the MCP sidecars, starts the Vite dev server and opens
the app window. The build skips sign-in (`FLEETIFY_NOAUTH=1`) and keeps its
data in its own folder, `~/.fleetify-wt-<slot>`, rather than the `~/.fleetify`
of an installed Fleetify. In a git worktree it also picks its own ports; the
banner it prints shows the slot, the ports and the folder.
[CONTRIBUTING.md](../CONTRIBUTING.md#running-fleetify) explains the slots.

Three other scripts start a debug build:

| Script | What it runs |
|---|---|
| `npm run dev:noauth` | No sign-in, the default ports, and the shared `~/.fleetify`. |
| `npm run dev:tauri` | Real sign-in against an identity provider on `http://localhost:3001`, which it needs running. |
| `npm run prod` | Real sign-in against production (`https://fleetify.dev`), the default ports and the shared `~/.fleetify`. On Windows it also opens WebView2's remote debugging port, 9222. |

### Test

[CONTRIBUTING.md](../CONTRIBUTING.md#the-gates) lists the checks CI runs. To
run one part of the Rust suite:

```bash
npm run build:sidecars                 # once: Tauri's build script needs the staged sidecars
cargo test -p fleetify-backend --lib   # backend unit tests (sqlx + bridges + services)
cargo test -p fleetify-app --lib       # Tauri shell unit tests (auth, config, git, ai_git, …)
```

The suite is in-memory sqlx + duplex-pipe mocks for the bridges, so it
runs without any external CLIs or network access. No fixtures to set
up.

### Build a release installer

```bash
npm run tauri build
```

The Tauri bundler first builds the sidecars and the UI in release mode
(`beforeBuildCommand` in `src-tauri/tauri.conf.json`), then the installers for
your OS under `target/release/bundle/`: the NSIS installer on Windows, the
`.app` and `.dmg` on macOS, and the `.deb`, `.rpm` and AppImage on Linux. A
release build pins the production endpoints, ignores the debug-only
variables below, and asks for a Fleetify account. `npm run prod:build` runs
the same build; the production variables it sets are the ones a release build
pins anyway.

The `[profile.release]` table in the workspace `Cargo.toml` optimizes for
size: `opt-level = "s"`, fat LTO, one codegen unit, and stripped symbols.

## Configuration

### Environment

Variables marked *debug only* have no effect in a release build.

| Variable                 | Default                       | Effect |
|--------------------------|-------------------------------|--------|
| `FLEETIFY_NOAUTH`        | (unset)                       | *Debug only.* `=1` ⇒ skip OAuth, sign in as a stub "John Doe", disable cloud telemetry. `dev:tauri:wt` sets it unless you set it yourself. |
| `FLEETIFY_REQUIRE_API_TOKEN` | (unset)                   | *Debug only.* `=1` ⇒ the backend asks for the per-run API token even under `FLEETIFY_NOAUTH=1`. Release builds always ask for it. |
| `FLEETIFY_ISSUER`        | `http://localhost:3001`       | *Debug only.* Identity provider for sign-in and dashboard sync. Release builds use `https://fleetify.dev`. |
| `FLEETIFY_RESOURCE` (or `FLEETIFY_AUDIENCE`) | `http://127.0.0.1:8765` | *Debug only.* RFC 8707 resource indicator, the audience of the access token. Release builds use `https://fleetify.dev/api`. |
| `FLEETIFY_DASHBOARD_URL` | `http://localhost:5174`       | *Debug only.* "Open dashboard" link target. Release builds use `https://app.fleetify.dev`. |
| `FLEETIFY_HOME`          | `~/.fleetify`                 | Fleetify's data folder. |
| `FLEETIFY_BACKEND_PORT`  | `8765`                        | Port of the embedded backend. |
| `FLEET_DB_URL`           | (unset)                       | Override the sessions DB; tests set `sqlite::memory:`. Unset, it is `fleet.db` in `FLEETIFY_HOME`. A no-auth run that doesn't set `FLEETIFY_HOME` uses `fleet-noauth.db` there instead, which keeps the stub user's sessions out of the signed-in user's database. |
| `FLEETIFY_MODELS_API`, `FLEETIFY_MODELS_TAG` | `https://fleetify.dev/api`, `main` | The model catalog's serving API and CDN tag; see [REMOTE_MODEL_CATALOG.md](REMOTE_MODEL_CATALOG.md). |
| `GEMINI_API_KEY`         | (none)                        | Antigravity SDK: the API key to use when none is saved in Settings. |

Debug builds also load a `.env` file from the working directory or one of its
parents; release builds never read one. `CLAUDE.md` shows the PostHog keys a
`.env` can hold.

#### `FLEETIFY_NOAUTH=1` — offline dev mode

`npm run dev:tauri:wt` (or `npm run dev:noauth`) boots the desktop UI without
contacting the Fleetify identity provider. The Tauri shell stubs every
`window.fleetify.*` call to a synthetic "John Doe" identity
(`sub: noauth-john-doe`), the backend's `AuthUser` extractor and WS token
resolver short-circuit to the same user, and the cloud telemetry WebSocket +
heartbeat loop are skipped entirely. The "Sign in with Fleetify" screen is
bypassed; "Sign out" stays visible in Settings but is inert. Use this to work
on the app without a Fleetify account or a network round-trip — release
builds ignore the flag and pin the production endpoints.

The backend also stops asking API requests for the per-run token that the
shell hands the renderer over IPC, so scripts can call the API directly. The
UI itself still needs the app window: a plain browser tab has no Tauri bridge
and stops at sign-in. Add `FLEETIFY_REQUIRE_API_TOKEN=1` to keep the token
check on in a no-auth run.

### Where things live

| Path                                       | Contents |
|--------------------------------------------|----------|
| `~/.fleetify/` (or `$FLEETIFY_HOME`)       | `fleet.db` (the sessions database; a no-auth run on `~/.fleetify/` uses `fleet-noauth.db`), `device.json` (stable per-machine UUID + name + platform), the telemetry queues (`telemetry-outbox.sqlite`, `posthog-outbox.sqlite`), `mcp_servers.json`, `plugins/`, `library/`, `models-cache/`, … |
| `~/.fleetify-wt-<slot>/`                   | The same, for a `dev:tauri:wt` instance |
| `fleet.config.json`                        | Settings, in the OS's app data folder for `com.fleetify.app` |
| `<project>/.fleetify-worktrees/`           | Session-scoped git worktrees |
| OS keychain `Fleetify`                     | OIDC refresh token |
| OS keychain `Fleetify-GitHub` / `Fleetify-Voice` / `Fleetify-Provider-<id>` / `Fleetify-Router-<id>` | GitHub link tokens, the voice key, provider and router API keys |

[INSTALL.md](INSTALL.md#remove-your-data) gives the exact folders on each OS,
logs included.

## Troubleshooting

**`npm ci` fails with `ERR_SSL_CIPHER_OPERATION_FAILED` on Windows**.
This is OpenSSL 3.x's AES-NI bug in certain VMs. Prefix:

```powershell
$env:OPENSSL_ia32cap = '~0x200000200000000'; npm ci --maxsockets 1 --fetch-retries 5
```

**`tauri build` fails with `LNK1104 fleetify_backend-…exe`**. A previous
test run left a process holding the binary. Close it with
`Stop-Process -Name "fleetify_backend-*" -Force` and rebuild.

**WS client refuses to connect ("not signed in")**. Expected when no
Fleetify account is signed in. The loop pauses 30s between attempts
and picks up the token automatically once you sign in.

**Sessions from an older dev build are gone**. Dev builds made before the
sessions database moved to `~/.fleetify/` kept it in `src-tauri/fleet.db`.
No-auth runs (`npm run dev:noauth`) kept theirs in `~/.fleetify/fleet.db`
and now use `~/.fleetify/fleet-noauth.db`. To keep those sessions, follow
these steps in order. Before starting a dev build of this version, quit
Fleetify. If you used `npm run dev:noauth`, rename `~/.fleetify/fleet.db*`
to `fleet-noauth.db*`. Delete any other `~/.fleetify/fleet.db*` that a newer
build created. Then move `src-tauri/fleet.db*` (the `-wal` and `-shm` files
with it) to `~/.fleetify/`.
