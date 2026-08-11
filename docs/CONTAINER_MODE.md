# Container mode

Run a session's agent inside a Docker container instead of on your machine.

Container mode is an **execution target**, not a source. It composes with
whichever source the session uses: a Git worktree can be executed inside a
container that mounts it, and host `git` keeps working on the same checkout.

---

## The two modes

| | **Attach** | **Run** |
|---|---|---|
| What it does | `docker exec` into a container you already started | Fleetify starts one from an image and bind-mounts your project |
| Where the files live | Inside your container | On your machine, mounted at `/workspace` |
| Git / worktrees | Not available — the host cannot see those files | Work normally |
| Lifecycle | Yours. Deleting the session never stops it | Fleetify's. Deleting the session removes it |
| Fleet MCP tools | Unavailable (see [Known gaps](#known-gaps)) | Unavailable (see [Known gaps](#known-gaps)) |

Pick one in the source picker's **Container** tab (Local / Git / Remote /
Container). Once a session runs in a container, a status chip appears in the
toolbar — the container's name and a live/dead dot — and clicking it jumps
back to the tab.

`ssh://` targets cannot be combined with either mode; remote execution is
not implemented.

### Run recipes

Run mode provisions from one of three recipes, all operating around the
**host** folder you pick right there in the tab:

- **Image** — a named image (`node:22`). Pulled with live progress, then run
  with your folder mounted at `/workspace`.
- **Dockerfile** — the project's own Dockerfile, **chosen with the OS file
  dialog** (stored relative to the project when it lives inside it; nothing
  chosen means `./Dockerfile`), built with the project as
  context (BuildKit step headers stream into the session), then run exactly
  like an image. Rebuilt when the container is re-provisioned, so Dockerfile
  edits take effect; layer caching keeps unchanged builds fast. The built
  image is session-scoped and removed when the session is deleted.
- **Compose** — pick the compose file with the OS dialog; **its directory
  becomes the project folder** (that is docker compose's own default), so
  there is no separate folder control to contradict it. Then
  `docker compose up -d`, and the agent runs inside the service you name (a
  single-service file picks itself).
  **The stack is yours**: Fleetify starts it idempotently, never tears it
  down — deleting the session leaves it running — and cannot mount
  credentials into it (your compose file owns the service's mounts), so use
  an API key or sign in inside the service.

### Agent auto-install

If the agent's CLI is missing from a container Fleetify started (image,
Dockerfile build, or a compose service it brought up), Fleetify installs it
automatically using the provider's own documented command — the same one the
error message would have told you to run — and streams the step into the
session. If the image lacks the tooling (`npm`, `curl`, `pip`), the step
reports the real blocker and the turn is refused with the standard
not-installed message; add the tool to your image instead.

Attached containers are **never** auto-installed into — they belong to you.
The picker's probe just tells you the CLI is missing there.

### When the container starts

For **Run** mode, on the **first turn** — not when you pick the image.
Choosing an image records the intent; the container is created when you
actually send a message, the same moment a worktree gets carved. That way
configuring a session you then abandon never leaves a container behind.

You see it happen: while the image downloads and the container starts, the
session shows an inline status — which step is running, and how far the image
pull has got. A cold pull can take minutes, so reporting nothing would be
indistinguishable from a hang.

Afterwards the same container is reused across turns. If it has stopped,
Fleetify restarts it rather than creating a second one; only a genuinely
missing container is recreated. If provisioning fails, the turn fails with
the reason — Fleetify never quietly falls back to running on the host while
you believe the work is contained.

---

## Provider support

Every value below is from the vendor's own documentation. None of it is
guessable from Fleetify's host code, which is why the same table lives in
`crates/fleetify-backend/src/services/container/providers.rs` with the reasons
inline.

| Agent | Binary inside the container | Non-interactive credential | Notes |
|---|---|---|---|
| Claude Code | `claude` | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), else `ANTHROPIC_API_KEY` | `--dangerously-skip-permissions` is added only when the container does **not** run as root — the CLI refuses it as root |
| Codex CLI | `codex` | `OPENAI_API_KEY` | Forced to the `danger-full-access` sandbox tier — see below |
| Kimi Code | `kimi` | `MOONSHOT_API_KEY` | |
| Cursor CLI | `agent` | `CURSOR_API_KEY` | The binary is `agent` inside, not the host's `cursor-agent` |
| Grok Build | `grok` | `XAI_API_KEY` | `GROK_API_KEY` is a non-standard name and is never emitted |
| OpenCode | `opencode` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Credentials live in `~/.local/share/opencode/auth.json` — the XDG **data** dir, not the config home |
| GitHub Copilot | `copilot` | `COPILOT_GITHUB_TOKEN`, else `GH_TOKEN` / `GITHUB_TOKEN` | Must be a user-scoped fine-grained PAT with the "Copilot Requests" permission. An Actions installation token (`ghs_…`) is refused with an explanation rather than forwarded |
| Hermes | `hermes` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Official image `nousresearch/hermes-agent`, state dir at `/opt/data` |
| Antigravity CLI | — | — | **Not supported yet** |
| Antigravity SDK | — | — | **Not supported** |

### Why Codex is forced to `danger-full-access`

Codex builds its own sandbox from Landlock + seccomp on Linux and Seatbelt on
macOS. An ordinary container exposes neither, so `read-only` and
`workspace-write` do not degrade — they **fail to start**. Inside a container
the container *is* the boundary, which is the arrangement Codex's own
documentation recommends for its bypass modes.

The tier rides the app-server protocol (`thread/start`), not the command line;
a `--sandbox` flag on `codex app-server` is silently ignored.

### Why the two Antigravity agents are refused

- **Antigravity CLI** drives `agy` through a terminal, writes its
  workspace-trust entry and MCP config next to the agent before every turn
  (without the trust entry `agy` silently refuses — exit 0, empty output), and
  reads the turn back out of a transcript file. All three are host-side, and
  `agy` documents no environment-variable login, so there is nothing to inject
  either.
- **Antigravity SDK** runs a host Python SDK that provisions its own remote
  Google-managed sandbox. Nesting that inside your container is meaningless.

Both are refused in the picker with the reason, before any turn runs.

---

## Credentials

Three tiers, tried in order.

**Tier A — environment injection (always on).** Fleetify forwards the
provider's own documented key or token, and nothing else. Loopback base URLs
are rewritten to `host.docker.internal`, because inside a container
`127.0.0.1` is *the container* — without the rewrite a proxy-backed session
silently reaches nothing and the agent runs unauthenticated.

**Tier B — mount my credentials (opt-in, per session).** Mounts **only** that
agent's own credential directory (`~/.claude`, `~/.codex`,
`~/.local/share/opencode`, …) into the container.

> Anything running in the container can read what you mount, including the
> repository's own code. Fleetify never mounts your whole home directory and
> never mounts `~/.ssh`. Use this with repositories you trust; prefer signing
> the agent in inside the container for anything else.

**Tier C — sign in inside the container.** Nothing crosses. If Tier A found no
credential and Tier B is off, Fleetify refuses the turn *before* spawning and
tells you which variable to set or which login command to run — rather than
letting the CLI fail mid-stream with its own error.

---

## What you need in the container

The agent's CLI has to be installed there. Fleetify probes for it when you
pick the container and again before each turn (cached for a minute), and names
the container if it is missing.

A minimal attach-mode setup:

```bash
docker run -d --name my-workspace -v "$PWD:/work" -w /work node:22 sleep infinity
docker exec my-workspace npm i -g @anthropic-ai/claude-code @openai/codex
```

Then pick `my-workspace` in **Run in container → Attach**.

---

## Known gaps

- **Fleet MCP tools do not work in a container.** The four sidecars
  (`fleet_memory`, `fleet_dispatch`, `fleet_reveng`, `fleet_browser`) resolve
  to host executables next to the running app, and their callback URL points
  at the host loopback. Fleetify drops them from the session rather than
  advertising tools that cannot answer — the agent will not offer them.
- **Antigravity CLI and SDK** are unsupported (see above).
- **Windows containers** are untested. Every in-container command assumes a
  POSIX `sh`.
- **`docker-attach` cannot gain mounts.** Mounts are fixed when a container
  starts, so the credential mount and any future sidecar mount only apply to
  `docker-run`.

---

## Troubleshooting

**"The … CLI is not installed in container 'x'"** — install the agent's CLI
inside that container, or switch the session to a local folder. Fleetify
re-probes each turn, so no restart is needed after installing.

**"No credential to pass into the container for this agent"** — set the
variable the message names on Fleetify's environment, turn on *Mount my
credentials*, or run the login command it suggests inside the container.

**The container chip shows a red dot** — the container has stopped, or the
Docker daemon is unreachable. Start it and the chip recovers within ~15s.

**A turn hangs immediately after starting** — usually a missing `-i` on the
exec, which would mean the agent's stdin was never connected. If you see this,
it is a bug: file it with the agent id, since the ACP agents all depend on
that channel.

---

## Where the code lives

| Concern | File |
|---|---|
| Where a turn runs (parser) | `services/exec_target.rs` |
| Per-provider container facts | `services/container/providers.rs` |
| The one spawn path | `services/container/spawn.rs` |
| Credential tiers + loopback rewriting | `services/container/credentials.rs` |
| Provisioning, probes, abort, teardown | `services/container/lifecycle.rs` |
| Docker CLI wrappers | `routers/docker.rs` |
| Persistence | migration `0014_session_exec_target.sql` |
| UI | `src/components/chat/docker-container-panel.tsx`, `session-toolbar.tsx` |
