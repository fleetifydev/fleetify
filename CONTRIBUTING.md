# Contributing to Fleetify

Thanks for your interest in contributing to Fleetify. This guide covers the development setup, the checks every pull request must pass, and how changes get reviewed and merged.

- Have a question? Ask in [GitHub Discussions](https://github.com/fleetifydev/fleetify/discussions). [SUPPORT.md](SUPPORT.md) lists every channel.
- Found a security vulnerability? Don't open an issue: follow [SECURITY.md](SECURITY.md).
- Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Small fixes can go straight to a pull request. For a new feature or a bigger change, open an issue or start a discussion first, so that we can agree on the approach before you spend time on the code. New to the codebase? Start with the [good first issues](#good-first-issues).

## Development setup

You need:

- **Git.**
- **Node 22**, the version in [`.nvmrc`](.nvmrc) and the one CI uses. A version manager such as nvm or fnm can read that file. Newer majors are untested, and Node 25 or later breaks the renderer tests: its built-in `localStorage` gets in the way of the test environment.
- **Rust**, through [rustup](https://rustup.rs). [`rust-toolchain.toml`](rust-toolchain.toml) pins Rust 1.100.0 with rustfmt and clippy, and rustup installs it the first time you run `cargo` in the repository. CI uses the same version.
- **The system packages for your OS**, below. Besides what Tauri v2 needs, the default build compiles whisper.cpp for on-device voice dictation, which takes CMake, a C++ compiler and libclang.
- Optionally, **Python 3 with PyYAML**, which the script tests use to read YAML (see [the gates](#the-gates)).

### Linux

On Ubuntu 22.04 or newer, or Debian 12 or newer:

```bash
sudo apt update && sudo apt install build-essential curl wget file pkg-config cmake libclang-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev libdbus-1-dev patchelf
```

That is [Tauri's list of Linux prerequisites](https://v2.tauri.app/start/prerequisites/), without libssl-dev and libxdo-dev, which nothing here links, plus:

- CMake and libclang, to build whisper.cpp and generate its Rust bindings;
- the ALSA headers (libasound2-dev), for microphone capture;
- the D-Bus headers (libdbus-1-dev), to keep credentials in the Secret Service;
- pkg-config, which the Rust build uses to find these libraries;
- patchelf, which Tauri's GitHub Action also installs to build the Linux bundles.

On other distributions, install the equivalents. Tauri's page names them for Arch, Fedora, openSUSE and others.

### macOS

Install the Xcode Command Line Tools, which bring the C and C++ compilers and libclang. Then install CMake, for example with [Homebrew](https://brew.sh):

```bash
xcode-select --install
brew install cmake
```

### Windows

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), with the **Desktop development with C++** workload.
- WebView2, which Windows 10 (version 1803 and later) and Windows 11 already include.
- The MSVC Rust toolchain. If rustup didn't make it your default, run `rustup default stable-msvc`.
- CMake on your `PATH`, and LLVM for libclang:

  ```powershell
  winget install Kitware.CMake
  winget install LLVM.LLVM
  ```

  If the build can't find libclang, set `LIBCLANG_PATH` to the folder that holds `libclang.dll`, such as `C:\Program Files\LLVM\bin`.

## Running Fleetify

```bash
npm ci
npm run dev:tauri:wt
```

This starts a debug build: it builds the MCP sidecars, starts the Vite dev server and opens the app window. The first run compiles the whole Rust workspace, whisper.cpp included, so it takes a while. Later runs rebuild only what changed.

**You don't need an account.** The script sets `FLEETIFY_NOAUTH=1` unless you set it yourself, so the app skips sign-in and runs as a local stand-in user. Release builds ignore the variable and need a free Fleetify account.

**Ports and data folder.** The script picks a slot from 0 to 99, which sets the ports and `FLEETIFY_HOME`, the backend's data folder; the banner it prints shows all three. A clone's main checkout gets slot 0: the default ports (3000 for Vite, 8765 for the embedded backend) and `~/.fleetify-wt-00`, away from the `~/.fleetify` of an installed Fleetify. An installed Fleetify listens on 8765 as well, so quit it first or pick another slot: `npm run dev:tauri:wt -- 1`. Two separate clones both get slot 0 too; give one of them another slot. In a [git worktree](https://git-scm.com/docs/git-worktree), the script derives the slot from the worktree's name, which lets several worktrees run side by side. Some state is shared by every instance, an installed Fleetify included: the settings file in the OS's app data folder and the webview's storage, which both belong to the app identifier `com.fleetify.app`.

**Smoke tests.** In no-auth mode, the backend stops requiring the per-run API token, so scripts can call its API directly. The UI itself still needs the app window: a plain browser tab stops at sign-in. When you test a change in the app window, start it as `FLEETIFY_REQUIRE_API_TOKEN=1 npm run dev:tauri:wt`, which keeps the token check on, as in a release build.

[docs/RUNNING.md](docs/RUNNING.md) lists the other environment variables. To run agents in the app, install an agent CLI or add a provider's API key in Settings: [docs/AGENTS.md](docs/AGENTS.md) and [docs/PROVIDERS.md](docs/PROVIDERS.md) list what Fleetify supports.

## The gates

CI runs these checks on every pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Run them before you push:

```bash
npm run check:sidecars                                  # the build script and tauri.conf.json list the same sidecars
npm run build:sidecars                                  # stage the MCP sidecars, which clippy and the Rust tests need
cargo fmt --all -- --check                              # Rust formatting
cargo clippy --workspace --all-targets -- -D warnings   # compiles everything; any warning fails
cargo test --workspace --no-fail-fast                   # Rust tests (advisory)
npm run lint                                            # ESLint
npx tsc -b tsconfig.build.json --noEmit                 # TypeScript type check
npm test                                                # renderer tests, Vitest (advisory)
python3 -c "import yaml"                                # PyYAML, which the script tests need
node --test "scripts/ci/*.test.mjs" "scripts/release/*.test.mjs"   # tests of the repository's own scripts
```

The two steps marked advisory don't block a merge, and every other step does. Treat a red test as red all the same: check whether it also fails on `main`, and don't leave a new failure behind. CI also runs `cargo audit` and `npm audit --omit=dev`, both advisory.

- CI runs the Rust checks on Windows, so code behind `cfg(windows)` gets compiled and linted there even when your machine skips it.
- The script tests read YAML with Python 3 and PyYAML: `sudo apt install python3-yaml` on Debian and Ubuntu, `pip install pyyaml` elsewhere. Without PyYAML, those checks skip on your machine; CI checks for it first (the `import yaml` step), so they can't skip there.
- Pull requests also need a [conventional title](#titles) and a [sign-off on every commit](#sign-off-your-commits-dco), each enforced by its own check.
- A change to a Cargo manifest, `Cargo.lock` or `deny.toml` also runs cargo-deny, which checks dependency licences and security advisories and doesn't block a merge. Locally: `cargo deny check licenses advisories bans sources`.

## Pull requests

### Branches

Name a branch after the kind of change it makes, with the same prefix as its title: `feat/sidecar-discovery`, `fix/outbox-flake`, `docs/release-runbook`.

### Titles

Maintainers squash-merge every pull request, so its title becomes the subject of its commit on `main`. From the first public release (v0.2.0) on, release-please reads these titles to write the changelog and pick the next version. A check enforces the [Conventional Commits](https://www.conventionalcommits.org/) form `type(scope): summary`, where the scope is optional:

```text
fix(git): keep the branch picker open after a refresh
```

| Type | Use it for | Changelog | Version bump before 1.0 |
|---|---|---|---|
| `feat` | a new capability that users can see | Features | minor (0.2.0 → 0.3.0) |
| `fix` | a fix for a bug that users can see | Bug Fixes | patch (0.2.0 → 0.2.1) |
| `perf` | a speed or memory gain, with no change in behaviour | Performance Improvements | patch |
| `deps` | a dependency update | Dependencies | patch |
| `revert` | undoing an earlier change | Reverts | patch |
| `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style` | changes users don't see: docs, tests, CI, refactoring, formatting, build scripts | not listed | none, and no release |

Unsure between `feat` and `chore`? Ask whether the change belongs in the public changelog.

Mark a breaking change with `!` after the type or scope, as in `feat(api)!: drop the v1 sessions endpoint`, and explain the migration in the description. Before 1.0, a breaking change bumps the minor version; from 1.0 on, the major.

### Sign off your commits (DCO)

Fleetify uses the [Developer Certificate of Origin](https://developercertificate.org) (DCO) 1.1 rather than a contributor licence agreement. When you sign off a commit, you certify the certificate's four points, summarised here:

- you wrote the contribution, in whole or in part, and have the right to submit it under the project's open source licence; or
- it builds on earlier work that, to the best of your knowledge, is under a suitable open source licence, which gives you the right to submit it, with your changes, under the same licence (unless you are permitted to submit it under a different one); or
- someone who certified one of the above gave it to you, and you haven't changed it;
- and you understand that the contribution is public, and that a record of it, including your sign-off and the personal details in it, is kept indefinitely and may be redistributed in line with the project or the licences involved.

[The full certificate](https://developercertificate.org) is short; read it once before your first sign-off. To sign off, commit with `-s`:

```bash
git commit -s -m "fix(git): keep the branch picker open after a refresh"
```

Git ends the message with a line like `Signed-off-by: Your Name <your email>`, taken from your `user.name` and `user.email`. If you'd rather not publish your email address, set `user.email` to the noreply address GitHub gives you (under Settings → Emails).

The DCO check fails a pull request that has a commit without a sign-off. Commits by bots and merge commits are exempt. To fix it, sign off the commits and update the pull request. Below, `upstream` stands for the remote that points at this repository; if you cloned it directly rather than a fork, that is `origin`:

```bash
# Only the last commit is missing it:
git commit --amend -s --no-edit
git push --force-with-lease

# Several commits are:
git fetch upstream
git rebase --signoff upstream/main
git push --force-with-lease
```

### Review and merging

- Open the pull request against `main` and fill in the template. While you're still working on it, open it as a draft: the maintainers get a review request once you mark it ready for review.
- Keep each pull request to one change. Add or update tests with it, and for a bug fix, add a test that fails without the fix. Attach a screenshot when the UI changes.
- Say in the description how you tested the change, including whether you ran the app.
- CI on a pull request from a fork starts once a maintainer approves the run.
- A maintainer reviews every pull request. It can merge once CI is green and every review conversation is resolved.

## AI-assisted contributions

AI-assisted contributions are welcome. You are responsible for every line you submit, whoever or whatever wrote it: read it, understand it, test it, and be ready to explain it in review. Your sign-off covers code an AI wrote as much as code you typed.

[CLAUDE.md](CLAUDE.md) holds the working notes coding agents should read first: the workflow, the gates and the known pitfalls. [docs/AGENTS.md](docs/AGENTS.md) describes the CLI agents Fleetify runs, which is useful context when a change touches them.

## Good first issues

Issues labelled [`good first issue`](https://github.com/fleetifydev/fleetify/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) are small and self-contained, a good way to learn the codebase. Comment on one before you start, so that two people don't work on the same thing, and ask there if anything is unclear.

## Maintainers

Fleetify's maintainers are its two founders:

- Doruk Özgen, [@dorukozgen](https://github.com/dorukozgen)
- Hakan Karapınar, [@CryonicsX](https://github.com/CryonicsX)

They review pull requests and triage issues. Please reach them through the public channels in [SUPPORT.md](SUPPORT.md) rather than directly.

## Licence

Fleetify is licensed under the [Apache License 2.0](LICENSE), and so are your contributions to it, as section 5 of the licence says. Your DCO sign-off certifies that you can contribute them under it. The Fleetify name and logo aren't covered by the licence: see [TRADEMARKS.md](TRADEMARKS.md).
