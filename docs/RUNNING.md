# Running Fleetify (Rust + Tauri rebuild)

Faithful port of the original Electron / FastAPI / Vite Fleetify build,
running as a single Tauri v2 process with an embedded `axum` server.

## Architecture in one paragraph

`crates/fleetify-backend` is a **library** crate (no `main.rs`). Its
`serve(addr, static_dir)` entry point binds an `axum` router on
`127.0.0.1:8765` and returns a `ServerHandle`. The Tauri binary
(`src-tauri/fleetify-app`) calls `fleetify_backend::serve(...)` from its
`setup` hook on a tokio task — same process, same address space. The
embedded UI (built React app from `../dist`) is served from the same
origin, so there's no CORS in prod and no port forwarding anywhere.

```
fleetify-app.exe (single Tauri binary)
  ├─ window (WebView) → http://127.0.0.1:8765/ → React UI
  ├─ embedded axum @ 127.0.0.1:8765 (background task)
  │   ├─ /api/*      ← every router
  │   ├─ /ws/*       ← chat WebSocket
  │   ├─ /events/*   ← SSE
  │   └─ /healthz
  ├─ Tauri IPC commands (~52)
  │   ├─ auth (sign-in / token / sign-out)
  │   ├─ fs / git / pty / dialog
  │   └─ AI git (commit msg / PR summary / review / diagnose / apply)
  └─ Telemetry pipeline (background tasks)
      ├─ outbox (SQLite WAL at ~/.fleetify/telemetry-outbox.sqlite)
      ├─ heartbeat loop (every 60 s)
      └─ ws_client loop → wss://fleetify.dev/api/realtime/connect
```

## Dev loop

### Prereqs

- **Rust** stable (≥ 1.80). Install via [rustup](https://rustup.rs).
- **Node** 20+ and **npm** 10+ for the frontend.
- **MSVC** build tools on Windows (LLVM/Spectre-mitigated libs — see
  [`memory/windows_native_build.md`](../memory/windows_native_build.md)
  if you hit linker errors for `keyring` or `portable-pty`).
- Optional: **claude**, **codex**, **gemini**, **gh** CLIs on `PATH`
  for the bridges and PR pipeline.

### Run

```bash
# Backend + Tauri in dev mode. Vite picks 3000 for the frontend, the
# embedded backend picks 8765, and the webview is pointed at the
# frontend's devUrl with the IPC layer wired via preload.js.
npm install            # one-time, frontend deps
cargo tauri dev        # spawns Vite + the Tauri shell
```

The first launch creates `~/.fleetify/` with `device.json`,
`telemetry-outbox.sqlite`, and `fleet.db`. Sign in via the dialog and
your refresh token lands in the OS keychain (`Fleetify` service).

### Test

```bash
# Backend unit tests (sqlx + bridges + services).
cargo test -p fleetify-backend --lib

# Tauri shell unit tests (auth, config, git, ai_git, etc.).
cargo test -p fleetify-app --lib

# Both at once.
cargo test --workspace
```

The suite is in-memory sqlx + duplex-pipe mocks for the bridges, so it
runs without any external CLIs or network access. No fixtures to set
up.

### Build a release installer

```bash
# Per-OS installers via the Tauri bundler. `--release` is implicit.
cargo tauri build
# Windows: target/release/bundle/msi/Fleetify_<version>_x64_en-US.msi
# macOS:   target/release/bundle/dmg/Fleetify_<version>_aarch64.dmg
# Linux:   target/release/bundle/deb/fleetify_<version>_amd64.deb
```

The `[profile.release]` table in the workspace `Cargo.toml` enables
`lto = "thin"` + `codegen-units = 1` + `strip = "symbols"` so the
shipped binary is ~20% smaller than a default release build.

## Configuration

### Environment

| Variable                 | Default                       | Effect |
|--------------------------|-------------------------------|--------|
| `FLEETIFY_ISSUER`        | `https://fleetify.dev` (prod) | OAuth + telemetry cloud endpoint |
| `FLEETIFY_RESOURCE`      | `https://fleetify.dev/api`    | RFC 8707 resource indicator |
| `FLEETIFY_DASHBOARD_URL` | `https://app.fleetify.dev`    | "Open dashboard" link target |
| `FLEET_DB_URL`           | `sqlite://~/.fleetify/fleet.db?mode=rwc` | Override the local DB; tests set `sqlite::memory:` |
| `GEMINI_API_KEY`         | (none)                        | Bypass interactive Gemini OAuth |
| `GOOGLE_*`               | (none)                        | Vertex-AI auth (3 vars: API_KEY + PROJECT + LOCATION) |

### Where things live

| Path                                       | Contents |
|--------------------------------------------|----------|
| `~/.fleetify/device.json`                  | Stable per-machine UUID + name + platform |
| `~/.fleetify/telemetry-outbox.sqlite`      | Durable telemetry queue (WAL mode) |
| `~/.fleetify/fleet.db`                     | Main sqlite (sessions, messages, costs, …) |
| `~/.fleetify/plugins/<name>/`              | Installed plugin (parsed by `services::plugins::manifest`) |
| `~/.fleetify-worktrees/`                   | Session-scoped git worktrees |
| OS keychain `Fleetify` / `<sub>`           | OIDC refresh token |
| OS keychain `Fleetify-GitHub` / `<sub>`    | GitHub link tokens |

## Phase status

See `docs/superpowers/specs/2026-05-19-fleetify-rust-tauri-rebuild-design.md`
for the canonical phase plan. As of this commit:

- **Phase 0** scaffold: complete
- **Phase 1** runnable core (auth, sessions, chat WS): complete
- **Phase 2** bridges + git pipeline: real Claude / OpenAI / Gemini /
  Codex bridges, real workspace router, real AI-git surface
  (generate / review / diagnose / apply). SdkBridge equivalent
  (claude CLI control protocol + Fleet's 3 stdio MCP servers) is the
  remaining substantial Phase-2 deliverable.
- **Phase 3** orchestration: activity ledger, meta-cost tracker,
  haiku circuit breaker live; LLM-calling components
  (task_enricher / auto_planner / prompt_enhancer / compactor /
  session_summarizer) land alongside the SdkBridge port.
- **Phase 4** cloud integration: telemetry pipeline complete (device
  id + outbox + emitters + heartbeat + WS client), plugin manifest
  parser live, marketplace source CRUD live; installer +
  materializers + catalog walk are follow-ups.
- **Phase 5** hardening: release profile + bundler metadata live;
  per-OS smoke installers + docs parity are follow-ups.

## Troubleshooting

**npm install fails with `ERR_SSL_CIPHER_OPERATION_FAILED` on Windows**.
This is OpenSSL 3.x's AES-NI bug in certain VMs. Prefix:

```powershell
$env:OPENSSL_ia32cap = '~0x200000200000000'; npm install --maxsockets 1 --fetch-retries 5
```

**`tauri build` fails with `LNK1104 fleetify_backend-…exe`**. A previous
test run left a process holding the binary. Close it with
`Stop-Process -Name "fleetify_backend-*" -Force` and rebuild.

**WS client refuses to connect ("not signed in")**. Expected when no
Fleetify account is signed in. The loop pauses 30s between attempts
and picks up the token automatically once you sign in.
