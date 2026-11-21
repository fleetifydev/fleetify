# Releasing Fleetify

This is the maintainers' runbook: how a release is built, signed, checked and published, how to cut one, and what to do when something goes wrong. [INSTALL.md](INSTALL.md) is the users' side of the same release.

Releases come from release-please. It keeps a release pull request open, titled `chore(main): release <version>`, with the next version and its changelog, worked out from the titles of the pull requests merged since the last release ([CONTRIBUTING.md](../CONTRIBUTING.md#titles) lists the types and what each one bumps). When that pull request merges, the release workflow builds Fleetify for every platform, signs and checks the files, attaches them to a draft release and smoke-tests them, and only then publishes the release, which creates its `v<version>` tag.

- [What runs where](#what-runs-where)
- [Keys and secrets](#keys-and-secrets)
- [Cutting a release](#cutting-a-release)
- [If a run fails](#if-a-run-fails)
- [Pausing updates](#pausing-updates)
- [Rotating a key](#rotating-a-key)
- [The fleetify.dev front door](#the-fleetifydev-front-door)
- [Release assets](#release-assets)
- [Maintenance](#maintenance)
- [Turning on code signing](#turning-on-code-signing)

## What runs where

| Workflow | When it runs | What it does |
|---|---|---|
| [`release.yml`](../.github/workflows/release.yml) | every push to `main` | runs release-please; once a release pull request merges, builds, assembles, smoke-tests and publishes the release |
| [`release-dry-run.yml`](../.github/workflows/release-dry-run.yml) | pull requests that change what a release build reads, pushes to `main`, every Monday, and on demand | the same build, assembly and smoke test, publishing nothing; dispatched with `signing: release`, it makes a release candidate |
| [`build.yml`](../.github/workflows/build.yml) | called by both | builds and signs the bundles |
| [`smoke.yml`](../.github/workflows/smoke.yml) | called by both | installs and starts every bundle |

### The release workflow

[`release.yml`](../.github/workflows/release.yml) runs on every push to `main`, one run at a time: its runs share the concurrency group `release`, and none is cancelled once it has started. A newer push can take the place of a run that is still waiting, which loses nothing, as release-please finds every release pull request that has merged. Its jobs:

1. **release-please**, in the `release-bot` environment, gets a token for the Fleetify Release Bot, a GitHub App, and runs release-please with it twice. The first run looks for a release pull request that has merged, and creates its release, as a draft whose `v<version>` tag doesn't exist yet. Only when it created none does the second run open or update the release pull request, if anything merged since the last release calls for one. So the push that merges the release pull request makes the release instead. The second run waits, with a warning, while a draft release is pending: release-please finds the last release by its tag, so until the draft is published it would offer a release of every commit it can reach. Events made with the App's token start workflows, unlike those made with the default token, so the release pull request gets its checks like any other.
2. **build** runs build.yml on the merge commit in the `release` environment, when a release was created.
3. **assemble**, in the `release-bot` environment, puts the release's 20 files together with `assemble.mjs`, which checks every updater signature against the key in [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) and requires its key id to be `44C694713A20D751`. It attests the files' build provenance, uploads them to the draft, and checks that the draft holds exactly the assets that `expectedAssets()` in [`release-assets.mjs`](../scripts/release/release-assets.mjs) names.
4. **smoke** runs smoke.yml on those files. The macOS app's designated requirement must equal the one pinned in [`scripts/release/macos-designated-requirement.txt`](../scripts/release/macos-designated-requirement.txt).
5. **publish**, in the `release-bot` environment, once assemble and smoke have passed, checks that the draft points at the commit that was built and that its tag doesn't exist yet, as publishing would keep a tag that exists already. Then it publishes the draft and marks it as the latest release. Publishing creates the tag, as the Release Bot. The job then checks that the release is no longer a draft, that the tag exists, and that GitHub's `latest.json` for the latest release names the new version.

Two rulesets guard the tags: only the organisation's admins and the Release Bot may create a `v*` tag, and no one may move or delete one. A tag created before the checks passed would be permanent, which is why the tag only comes into being at publish. Don't create a `v*` tag by hand.

The attestation step runs in a job that release.yml defines itself, so the attestations name release.yml as their signer. That is what `--signer-workflow` checks when users [verify a download](INSTALL.md#verify-a-download).

### The build

[`build.yml`](../.github/workflows/build.yml) takes the commit, the environment (`release` or `dry-run`) and the version. Each target compiles in a job that holds no key, and only the short jobs after it can reach the signing keys:

| Job | Runner | Environment | What it does |
|---|---|---|---|
| notices | `ubuntu-24.04` | none | writes `THIRD-PARTY-NOTICES` with cargo-about |
| compile, ×4 | `ubuntu-22.04`, `windows-2025`, `macos-15`, `macos-15-intel` | none | builds the app, its MCP sidecars and the UI, scans them for secrets, and checks the updater settings built in; on Linux and Windows it also makes the bundles, without signing them (`tauri bundle --no-sign`) |
| sign, ×2 | `ubuntu-24.04` | the caller's | signs the Linux and Windows updater artifacts with the Tauri CLI's signer, and checks each signature |
| bundle-macos, ×2 | `macos-15`, `macos-15-intel` | the caller's | bundles the macOS app and disk image, code-signs the app with the macOS identity and signs its updater archive with the updater key, then checks both signatures |

What keeps the keys away from the code that compiles:

- The compile job runs the build code of every dependency (crate build scripts, proc macros, Vite plugins), so it gets no environment and no secret.
- The jobs with the keys download each artifact into a folder of its own and check that it holds exactly the files they expect (`check-artifact.mjs`). bundle-macos reads `compiled.tar` member by member and takes only the app binary and the four sidecars (`compiled-tar.mjs`).
- They run nothing but GitHub's own actions (each pinned to a commit), the Tauri CLI that `package-lock.json` pins, system tools and the repository's scripts; `scripts/ci/check-workflows.test.mjs` holds them to that. npm installs everywhere with `--ignore-scripts`.
- No build uses a Rust cache, not even a dry run: each starts from a clean target folder.

The AppImage bundler downloads the tools it runs whenever its cache (`~/.cache/tauri`) lacks them, with no check, and two of them, AppRun and the GTK plugin's hook, ship inside the AppImage. So before the bundler runs, `appimage-tools.mjs` puts into that cache the versions that [`appimage-tools.json`](../scripts/release/appimage-tools.json) pins by SHA-256.

The hand-off artifacts between the jobs are kept for seven days, so approve a release's deployment within a week of its compile jobs.

### The smoke test

[`smoke.yml`](../.github/workflows/smoke.yml) installs or unpacks each bundle of an assembled release and starts it the way a user does, from the filesystem root, with a fresh home. [`launch-smoke.mjs`](../scripts/release/launch-smoke.mjs) lists what it checks. Each job checks out `scripts/release` alone, so nothing runs from a source tree.

- **Linux** (`ubuntu-24.04`): the AppImage and the `.deb`, and whether the `.rpm`'s dependencies resolve on Fedora, and on openSUSE Tumbleweed for information only.
- **Windows** (`windows-2025`): a silent per-user install, started from `C:\`.
- **macOS** (`macos-15` and `macos-15-intel`): the app from the disk image, once its signature passes `macos-signature.mjs`. Candidates and releases compare its designated requirement with the pinned one; dry runs, which sign with an identity made for the run, check its shape only.
- Each job then installs the release again with `install.sh` or `install.ps1`, served on `127.0.0.1:18081` the way GitHub serves release assets. On macOS and Windows it also checks that the scripted download carries no quarantine flag or Mark-of-the-Web.
- With `rehearse`, which only dry runs set, each bundle also rehearses an update: the app must find, download and verify version 99.0.0 of its own bundle type from a local update server.

### Dry runs and candidates

[`release-dry-run.yml`](../.github/workflows/release-dry-run.yml) builds, assembles and smoke-tests a release without publishing anything. It runs on pull requests that change what a release build reads (the paths it lists), on pushes to `main`, every Monday at 05:00 UTC, and when dispatched. It doesn't block a merge, but treat a red run as red. A release commit, whose subject starts with `chore(main): release`, skips its push run, as the release workflow builds that commit itself.

- **`signing: ephemeral`**, the default and what every automatic run uses, runs in the `dry-run` environment. Each build makes a throwaway updater key, and on macOS a throwaway signing identity, and its updater asks only the smoke test's local update server.
- **`signing: release`** makes a release candidate: it builds from `main` only, with the release keys, in the `release` environment. Its `release` artifact, kept for 14 days, holds the 20 files a release would publish, under `main`'s current version. Nothing is tagged or published.

### The environments

- **`release`** holds the signing keys. Its deployments wait until a required reviewer, one of the project owners, approves them, and they may come only from `main` and from `v*` tags. One approval covers the jobs of a run that wait for it together, as sign and bundle-macos do.
- **`release-bot`** holds the Release Bot's private key. Its deployments need no approval, and they may come only from `main`.
- **`dry-run`** has no protection rules, secrets or variables.

Never call build.yml with `secrets: inherit`. It would hand the repository's secrets to every job in build.yml, the compile job included. The signing keys reach a job only through the environment its caller names.

## Keys and secrets

| Name | Kind | Where | What it is |
|---|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | secret | `release` environment | the updater signing key: a password-protected minisign key, key id `44C694713A20D751` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | `release` environment | its password |
| `APPLE_CERTIFICATE` | secret | `release` environment | the macOS code-signing identity, a self-signed certificate with its private key, as a base64 `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | secret | `release` environment | the `.p12`'s password |
| `APPLE_SIGNING_IDENTITY` | variable | `release` environment | the identity's name, `Fleetify Self-Signed Code Signing` |
| `RELEASE_BOT_PRIVATE_KEY` | secret | `release-bot` environment | the private key of the Fleetify Release Bot, a GitHub App |
| `RELEASE_BOT_CLIENT_ID` | variable | repository | the App's client ID |
| `POSTHOG_API_KEY`, `POSTHOG_HOST`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | variables | repository | the public, write-only PostHog project key and its host, which release builds compile in |

- The updater key's public half is `plugins.updater.pubkey` in tauri.conf.json. Every build embeds it, and an installed copy installs only an update whose signature it verifies.
- Of all the jobs, only build.yml's sign and bundle-macos reach the `release` environment's keys, and only bundle-macos the macOS identity.
- The macOS identity is self-signed, and the app is signed with the hardened runtime and isn't notarized. macOS ties the microphone permission and Fleetify's keychain items to the app's designated requirement, which is pinned in [`scripts/release/macos-designated-requirement.txt`](../scripts/release/macos-designated-requirement.txt), so they carry over an update only while it stays the same.
- The Release Bot's key is in the `release-bot` environment, which only `main` may deploy to and which asks for no approval, as the release-please job runs on every push to `main`. A workflow on any other branch or pull request can't reach it. Only release.yml's release-please, assemble and publish jobs use it, and each makes a token of its own: release-please's can write contents, pull requests and issues, and assemble's and publish's contents only.
- No workflow gives a build a private API key, such as a model provider's, and `scan-secrets.mjs` checks the built UI and binaries for one before they're bundled.

**Custody.** The project owners ([CONTRIBUTING.md](../CONTRIBUTING.md#maintainers)) hold the keys. Each private key and password is kept in the project's shared password vault and in an offline copy. The public halves are in the repository. Set a secret only through standard input, never as an argument, and never print, paste or log a key or a password:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release -R fleetifydev/fleetify < key-file
```

| Key | If every copy is lost | If it leaks |
|---|---|---|
| Updater key | Installed copies can't verify a later update, so users have to reinstall by hand. | Anyone holding it could sign an update that installed copies accept: [rotate it](#the-updater-key). |
| macOS identity | The next release needs a new one, and each Mac user is asked once more for the microphone and the keychain after updating. | It vouches for nothing beyond Fleetify's own signature, but [rotate it](#the-macos-identity). |
| Release Bot key | Generate a new one in the App's settings. | Revoke it in the App's settings and [set a new one](#the-release-bots-key). |

## Cutting a release

From the candidate until the release is published, merge nothing else into `main`. The candidate tests `main` as it is, and a later merge would ship untested. When `main` moves, release-please also regenerates the release pull request, which drops any commit you pushed to it and your edits to its description.

### 1. Cut a candidate

```bash
gh workflow run release-dry-run.yml --ref main -f signing=release
gh run list --workflow release-dry-run.yml --event workflow_dispatch --limit 1
```

Open the run with `gh run view <run-id> --web`. Once its compile jobs pass, the sign and bundle-macos jobs wait for the `release` environment: choose **Review deployments**, select `release` and choose **Approve and deploy**. Then wait for the run to end:

```bash
gh run watch <run-id> --exit-status
```

Every job must pass: notices, compile ×4, sign ×2, bundle ×2, assemble, whose log shows `signature ok, key 44C694713A20D751` for each updater artifact, and the smoke test ×4. Then download the candidate:

```bash
gh run download <run-id> --name release --dir candidate
```

Its files carry `main`'s current version, the one before the release. The release run builds the same code under the new version.

### 2. Run the RC checks

The release-candidate (RC) checks run on real machines, with the candidate's files: macOS on Apple silicon and on Intel, Windows 11, and Linux.

1. Check the files against `SHA256SUMS`, as [INSTALL.md](INSTALL.md#verify-a-download) describes.
2. Install each package as INSTALL.md describes, on a machine or user account that has never run Fleetify, and check that what you see matches it: the macOS Gatekeeper steps and their wording, the Windows SmartScreen steps, the `.deb`, the `.rpm`, and the AppImage on a clean Ubuntu 24.04 without `libfuse2t64`, where INSTALL.md's FUSE advice must hold.
3. Sign in with a real Fleetify account.
4. Run one real agent turn, for example with Claude Code.
5. Dictate a voice note. macOS asks for the microphone, once.
6. Open the screens that load the most code: a chat with highlighted code, the terminal, math and Preview. The app's log must then have no `fleetify.csp` lines, which report content security policy violations; [INSTALL.md](INSTALL.md#remove-your-data) gives the log folder for each OS.
7. In the Browser panel, open a page that shows `typeof window.__TAURI_INTERNALS__` and `typeof window.__TAURI__`. Both must be `undefined`, and **Select** must still hand a picked element to the chat.
8. On Windows, quit Fleetify while an agent session runs, and start it again at once. It must start.

Fix any finding through a normal pull request, then cut a new candidate.

### 3. Check the release pull request

```bash
gh pr list --label "autorelease: pending"
```

- Its version is the one the merged titles call for.
- Its diff bumps all 14 version sources together, which CI's **Versions agree** step checks.
- Read its notes. release-please also reads the body of each squash commit, and a line there that starts like a conventional commit, such as `fix: …` or `feat(scope): …`, becomes an entry of its own. The squash body of a pull request with a single commit is that commit's message, so such a pull request can appear twice. Remove the extra entries.

To change the notes, edit them in both places the same way:

- **CHANGELOG.md**, in a signed-off commit on the release pull request's branch. Keep its first lines as release-please wrote them, `# Changelog` and the heading under it that names the version: a script test checks them.
- **The pull request's description**, which becomes the GitHub release's notes. Keep the two `---` lines, and the `## <version>` heading at the top of the notes between them: release-please reads the notes from there.

```bash
gh pr view <number> --json body --jq .body > notes.md
# edit notes.md
gh pr edit <number> --body-file notes.md
```

### 4. For 0.2.0 only: prepare the first release

The first release needs one more commit on its release pull request, and it must be the last thing you push before you merge:

- In [`release-please-config.json`](../release-please-config.json), remove `bootstrap-sha` and the package's `release-as`. `release-as` makes this release 0.2.0, and `bootstrap-sha` starts its changelog after the history that came before; left in, `release-as` would ask every later release pull request for 0.2.0 again. A script test requires both while the manifest's version is below 0.2.0 and forbids them from 0.2.0 on, so the release pull request's CI stays red until this commit.
- In CHANGELOG.md, edit the notes under the heading release-please wrote. Drop the second `**backend:**` line, "load the built-in config and keep fleet.db under ~/.fleetify", which the squash body of pull request #19 adds. Add what a first release needs, such as a short introduction, a pointer to INSTALL.md, and the notes on the unsigned Windows installer and the self-signed macOS build.

```bash
branch=$(gh pr view <number> --json headRefName --jq .headRefName)
git fetch origin "$branch"
git switch -c release-prep "origin/$branch"
# edit release-please-config.json and CHANGELOG.md
git add release-please-config.json CHANGELOG.md
git commit -s -m "chore: prepare the 0.2.0 release"
git push origin "HEAD:$branch"
```

Then make the same changes to the notes in the pull request's description. Its CI passes now.

### 5. Check the release pull request's dry run

The release commit skips the dry run on `main`, so the release pull request's own dry run stands in for it. The pull request changes paths the dry run watches, and the Release Bot's events start workflows, so every update of it, your preparation commit included, starts one. Before you merge, check that the **Release dry run** run passed on the head you are about to merge:

```bash
head=$(gh pr view <number> --json headRefOid --jq .headRefOid)
gh run list --workflow release-dry-run.yml --commit "$head" --event pull_request
```

If no run passed on that head, dispatch one on the branch and wait for it:

```bash
branch=$(gh pr view <number> --json headRefName --jq .headRefName)
gh workflow run release-dry-run.yml --ref "$branch" -f signing=ephemeral
gh run list --workflow release-dry-run.yml --branch "$branch" --event workflow_dispatch --limit 1
gh run watch <run-id> --exit-status
```

### 6. Merge and approve

```bash
head=$(gh pr view <number> --json headRefOid --jq .headRefOid)
gh pr merge <number> --squash --match-head-commit "$head"
gh run list --workflow release.yml --branch main --limit 1
```

The merge starts release.yml. Its release-please job creates the draft release, and once the compile jobs pass, sign and bundle-macos wait for the `release` environment: approve the deployment as for the candidate. Then watch the run with `gh run watch <run-id> --exit-status`. It runs build (notices, compile ×4, sign ×2, bundle ×2), assemble (20 assets, attested and uploaded to the draft), smoke ×4, and publish.

### 7. Verify

```bash
v=0.2.0   # the version you released
gh release view "v$v" --json isDraft,tagName,assets --jq '{isDraft, tagName, assets: (.assets | length)}'
gh release view --json tagName --jq .tagName
git ls-remote --tags origin "refs/tags/v$v"
gh release download "v$v" --dir "release-$v"
cd "release-$v"
sha256sum --check SHA256SUMS
for f in *; do
  gh attestation verify "$f" --repo fleetifydev/fleetify --signer-workflow fleetifydev/fleetify/.github/workflows/release.yml
done
node -p 'const m = require("./latest.json"); `${m.version}: ${Object.keys(m.platforms).length} entries`'
```

The release is no longer a draft and has 20 assets. It is the latest release, and its tag exists. Every checksum is OK (on macOS, run `shasum -a 256 --check SHA256SUMS`), every file's attestation verifies, and `latest.json` names the version, with 10 entries.

From the second release on, also check the update itself on a machine that runs the previous release: **Settings → General → Updates → Check now** finds the new version and downloads it, and **Restart to update** installs it, keeping the sign-in and, on macOS, the microphone permission. Once the front door serves updates, `curl -sS "https://fleetify.dev/api/desktop/update/linux/x86_64/<previous version>?bundle_type=appimage"` must show the new version too.

## If a run fails

### A candidate or a dry run

Nothing was published, and no version was used. Fix the cause in a normal pull request and run it again.

### The release run, before publish

The release is still a draft and its tag doesn't exist, so nothing is public yet. While it stays a draft, release.yml opens or updates no release pull request: each run's release-please job says so in a warning. The release pull request comes back with the first push to `main` after the draft is published or deleted.

- **A job failed for a reason that a second try can fix**, such as a runner fault or a network error: re-run the failed jobs, with the jobs after them, using `gh run rerun <run-id> --failed`. Approve the `release` environment again if the run asks.
- **The release itself is wrong**: delete the draft with `gh release delete v<version> --yes`, and fix the cause in a normal pull request. The version is spent, as `main` already names it in `.release-please-manifest.json` and CHANGELOG.md, so the fix ships under the next version. Without a tag for the deleted version, release-please can't find the previous release, so the next release pull request's notes reach further back than they should: cut them down to what's new.
- **The release-please job failed**, on the Release Bot's credentials for example: fix the cause and re-run the job.

### After publish

Tags are immutable: a ruleset forbids moving or deleting a `v*` tag, with no exceptions, so a published version can't be redone. If it's bad, [pause updates](#pausing-updates), fix the problem in a normal pull request and ship the fix as the next patch release. If only the publish job's checks failed, after it had published, check the release by hand as in [step 7](#7-verify).

## Pausing updates

An installed copy asks fleetify.dev for updates first and GitHub second, in the order of `plugins.updater.endpoints` in tauri.conf.json. While its pause flag is set, fleetify.dev answers `204 No Content`, which the updater takes as "no update" without asking GitHub. A copy that can't reach fleetify.dev still asks GitHub, which serves the `latest.json` of the release marked as latest. To stop offering a bad release, do both:

1. Set the front door's pause flag, in the fleetify.dev service's configuration, outside this repository.
2. Mark the previous release as the latest:

   ```bash
   gh release edit v<previous> --latest
   ```

   GitHub's `latest.json` then names the previous version. The install scripts and the front door's download links follow the latest release too, so new installs get the previous version as well.

Copies that already installed the bad release aren't offered the older one: the updater never downgrades. Ship the fix as the next patch release, whose publish job marks it as the latest, then lift the pause. The first release has no earlier one to fall back to.

## Rotating a key

### The updater key

Installed copies trust only the public key built into them, so a new key can reach them only inside an update signed with the old one.

1. Make the new key offline with `npx --no -- tauri signer generate -w fleetify-updater.<date>.key`, and give it a long random password when it asks. Keep the key, its password and the `.pub` file in the vault and the offline copy. The new key's id is at the end of the first line that `base64 --decode < fleetify-updater.<date>.key.pub` prints.
2. Ship one release that has the new public key built in and is signed with the old key. In one pull request:
   - put the new `.pub` file's text in `plugins.updater.pubkey`;
   - change `UPDATER_KEY_ID` in release-assets.mjs, and the tests that pin the key id, in `src-tauri/src/shell/updater.rs` and `scripts/release/`, to the new id;
   - for this release only, point the release signature checks at the old public key, committed as a file. The `release` environment still holds the old key, which signs this release, but the checks compare each signature with tauri.conf.json's key: those in build.yml's sign and bundle-macos jobs, and those in the assemble steps of the candidate and the release. `minisign.mjs verify` takes `--pubkey-file`; assemble.mjs has no such option yet. `check-workflows.test.mjs` pins those commands, so it changes with them.

   Then cut a candidate and release as usual.
3. Once that release is out, set the new key and its password as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the `release` environment, through standard input. Point the checks back at tauri.conf.json's key, with `--expect-key-id` set to the new id, and cut a candidate: assemble must report the new key id.

A copy older than the rotation release trusts only the old key, so it can't install a release signed with the new one: it needs the rotation release first, or a reinstall. Leave time between the two releases, and expect a few manual reinstalls.

### The macOS identity

1. Make a new self-signed certificate of the same shape, for code signing only and valid for ten years, and export it with its key as a password-protected `.p12`. `IDENTITY="Fleetify Self-Signed Code Signing" bash scripts/release/macos-keychain.sh cert-config` prints an OpenSSL config of that shape, the one the dry runs use. Keep the `.p12` and its password in the vault and the offline copy.
2. Replace the identity in the `release` environment, through standard input. The second command asks for the password:

   ```bash
   base64 -w 0 identity.p12 | gh secret set APPLE_CERTIFICATE --env release -R fleetifydev/fleetify
   gh secret set APPLE_CERTIFICATE_PASSWORD --env release -R fleetifydev/fleetify
   ```

   If the certificate's name changed, change the `APPLE_SIGNING_IDENTITY` variable too.
3. Pin its designated requirement. Cut a candidate: its macOS signature checks fail, because [`scripts/release/macos-designated-requirement.txt`](../scripts/release/macos-designated-requirement.txt) still holds the old certificate's, and their log shows the new one as `designated => …`. Check that its `H"…"` value is the new certificate's SHA-1, which `openssl x509 -in identity.pem -outform DER | openssl dgst -sha1` prints. Put the requirement, without `designated => `, in the file through a pull request, and cut another candidate.
4. After the first update signed with the new identity, macOS asks each user once more for the microphone and for Fleetify's keychain items. Say so in that release's notes.

### The Release Bot's key

Generate a new private key in the App's settings (the organisation's **Settings → Developer settings → GitHub Apps**) and set it:

```bash
gh secret set RELEASE_BOT_PRIVATE_KEY --env release-bot -R fleetifydev/fleetify < new-private-key.pem
```

Once the release-please job of release.yml's next run passes, delete the old key in the App's settings, and replace it in the vault.

## The fleetify.dev front door

fleetify.dev answers the first update endpoint that installed copies ask, and serves the download links for the website and the docs, so those addresses can stay the same whatever hosts the files. The service lives outside this repository; this section is the contract it keeps. The files themselves stay on GitHub, as release assets.

### The update endpoint

```text
GET https://fleetify.dev/api/desktop/update/{target}/{arch}/{current_version}?bundle_type={bundle_type}
```

It is the first entry of `plugins.updater.endpoints` in tauri.conf.json; GitHub's `latest.json` for the latest release is the second. The updater fills in:

| Part | Values |
|---|---|
| `target` | `linux`, `windows` or `darwin` |
| `arch` | `x86_64` or `aarch64` |
| `current_version` | the installed version, `MAJOR.MINOR.PATCH` |
| `bundle_type` | how the copy was installed: `appimage`, `deb`, `rpm`, `nsis`, `msi`, `app`, or `unknown` |

The bundle type picks the package: a `.deb` or `.rpm` install that is handed the AppImage can't install it. Treat a missing `bundle_type` as `unknown`.

The answer comes from the `latest.json` of the release marked as latest on GitHub, which the service may cache for a short time, through exactly the logic of `resolveUpdate()` in [`release-assets.mjs`](../scripts/release/release-assets.mjs). That takes the entry for `{target}-{arch}-{bundle_type}`, or else the one for `{target}-{arch}`, and offers it only when its version is newer than `current_version`.

| Status | When | Body |
|---|---|---|
| `200` | resolveUpdate returns an update | its result, as JSON with `Content-Type: application/json`: `version`, `url`, `signature`, `notes` and `pub_date`, Tauri's format for a dynamic update server |
| `204` | the pause flag is set, or resolveUpdate returns nothing: the copy is current, or `latest.json` has no entry for it | none |
| any non-2xx, such as `503` | `latest.json` can't be fetched or read, or resolveUpdate throws, on a `current_version` that isn't `MAJOR.MINOR.PATCH` or an entry without a `url` or a `signature` | anything |

A `204` ends the check: the updater reports no update and doesn't ask GitHub, which is what makes the pause flag work. Never answer with a 2xx whose body isn't JSON, such as an HTML error page: the updater ends the whole check on it too, but as a failure. After a non-2xx answer, or none within 20 seconds, the updater asks GitHub.

### Download links

Each of these paths redirects, with a `302`, to an asset of the release marked as latest on GitHub, at its download URL: what `downloadBase()` in release-assets.mjs returns for the version, then `/` and the asset's name. Any other platform name gets a `404`.

| Path | Asset (`<v>` is the version) |
|---|---|
| `/download/macos-arm64` | `Fleetify_<v>_aarch64.dmg` |
| `/download/macos-x64` | `Fleetify_<v>_x64.dmg` |
| `/download/windows-x64` | `Fleetify_<v>_x64-setup.exe` |
| `/download/linux-x64-appimage` | `Fleetify_<v>_amd64.AppImage` |
| `/download/linux-x64-deb` | `Fleetify_<v>_amd64.deb` |
| `/download/linux-x64-rpm` | `Fleetify-<v>-1.x86_64.rpm` |
| `/install.sh` | `install.sh` |
| `/install.ps1` | `install.ps1` |

The install scripts then download the release's files from GitHub themselves.

## Release assets

Every release has these 20 assets. `expectedAssets()` in [`release-assets.mjs`](../scripts/release/release-assets.mjs) names them, and the assemble and release jobs check the list. `<v>` is the version.

| Asset | What it is | Its `latest.json` entries |
|---|---|---|
| `Fleetify_<v>_aarch64.dmg` | macOS, Apple silicon: the disk image | |
| `Fleetify_<v>_aarch64.app.tar.gz` | macOS, Apple silicon: the app, for the updater and `install.sh` | `darwin-aarch64-app`, `darwin-aarch64` |
| `Fleetify_<v>_aarch64.app.tar.gz.sig` | its updater signature | |
| `Fleetify_<v>_x64.dmg` | macOS, Intel: the disk image | |
| `Fleetify_<v>_x64.app.tar.gz` | macOS, Intel: the app, for the updater and `install.sh` | `darwin-x86_64-app`, `darwin-x86_64` |
| `Fleetify_<v>_x64.app.tar.gz.sig` | its updater signature | |
| `Fleetify_<v>_x64-setup.exe` | Windows x64: the per-user installer, which the updater runs too | `windows-x86_64-nsis`, `windows-x86_64` |
| `Fleetify_<v>_x64-setup.exe.sig` | its updater signature | |
| `Fleetify_<v>_amd64.AppImage` | Linux x64: the AppImage | `linux-x86_64-appimage`, `linux-x86_64` |
| `Fleetify_<v>_amd64.AppImage.sig` | its updater signature | |
| `Fleetify_<v>_amd64.deb` | Linux x64: the Debian and Ubuntu package | `linux-x86_64-deb` |
| `Fleetify_<v>_amd64.deb.sig` | its updater signature | |
| `Fleetify-<v>-1.x86_64.rpm` | Linux x64: the Fedora and openSUSE package | `linux-x86_64-rpm` |
| `Fleetify-<v>-1.x86_64.rpm.sig` | its updater signature | |
| `LINUX-APPIMAGE-LIBRARIES.txt` | the system libraries inside the AppImage, with their Ubuntu packages, versions, copyright files and source links | |
| `THIRD-PARTY-NOTICES` | the licences of the third-party software in the bundles, which each bundle also carries | |
| `install.sh` | the install script for macOS and Linux | |
| `install.ps1` | the install script for Windows | |
| `latest.json` | the updater manifest: the 10 entries above, each with its file's URL and signature | |
| `SHA256SUMS` | the SHA-256 of every other asset | |

- Tauri names both macOS app archives `Fleetify.app.tar.gz`, so the release adds the version and the architecture.
- The disk images have no `latest.json` entry: an app installed from one reports its bundle type as `app` and updates through the app archive.
- An updater artifact's first entry is the one the updater looks up first, `{os}-{arch}-{bundle type}`; the second, where there is one, is what it falls back to when it can't tell how it was installed.
- The build provenance attestations cover all 20 assets.

## Maintenance

### Toolchains and tools

- [`rust-toolchain.toml`](../rust-toolchain.toml) pins Rust 1.100.0, and [`.nvmrc`](../.nvmrc) Node 22. Move either one in a `build:` pull request of its own; both files are among the dry run's paths, so the pull request runs one.
- build.yml's notices job installs cargo-about 0.9.3. To write `THIRD-PARTY-NOTICES` locally, install cargo-about from crates.io with its `cli` feature, `cargo install cargo-about --locked --version 0.9.3 --features cli`, then run `npm ci`, `cargo fetch --locked` and `node scripts/release/third-party-notices.mjs --out THIRD-PARTY-NOTICES`. The file is gitignored, so never commit it.
- The release workflows pin every action to a full commit, of a release at least 14 days old. Dependabot proposes updates with the same 14-day wait.

### The AppImage tool pins

The weekly dry run also re-checks the AppImage tools that `appimage-tools.json` pins. Three of them are release assets that upstream can replace, and linuxdeploy-plugin-appimage comes from a `continuous` release that is rebuilt from time to time; the two plugin scripts are pinned to a commit. A SHA-256 that no longer matches fails the build on purpose. Download the new file, inspect it, and update its hash in appimage-tools.json in a `build:` pull request of its own.

### Tauri

Tauri stays on 2.11.2 until an upgrade is planned:

- The workspace patches tauri-runtime-wry from `vendor/`, and Cargo applies the patch only while its version is the one tauri asks for, dropping it silently otherwise. An upgrade re-vendors it, as [FLEETIFY_PATCH.md](../vendor/tauri-runtime-wry/FLEETIFY_PATCH.md#how-to-refresh-on-a-tauri-bump) describes. After any change to `Cargo.lock`, `cargo tree -i tauri-runtime-wry --target all` must show only the copy in `vendor/`.
- tauri-plugin-updater moves with tauri's minor version: 2.12 is the newest that works with tauri 2.11, as 2.13 and later need tauri 2.12. A test in `src-tauri/src/shell/updater.rs` holds `Cargo.lock` to it.
- release-assets.mjs holds the bundle file names that tauri-cli 2.11.2 writes, and appimage-tools.json the AppImage tools of tauri-bundler 2.9.2: check both against the new versions.
- Dependabot leaves tauri, its plugins, wry and tao alone, and gives the `@tauri-apps` npm packages patch updates only ([`.github/dependabot.yml`](../.github/dependabot.yml)).
- A Tauri upgrade gets a dry run on its pull request, and a candidate before the next release.

### Runner images

- build.yml builds Linux on `ubuntu-22.04`, the oldest supported Ubuntu LTS, so that the bundles run on glibc 2.35 and later; Windows on `windows-2025`; and macOS on `macos-15` (Apple silicon) and `macos-15-intel` (Intel). smoke.yml runs on `ubuntu-24.04`, `windows-2025`, `macos-15` and `macos-15-intel`.
- `TARGETS` in release-assets.mjs names each build's runner, and a script test keeps build.yml's matrices equal to it, so change them together.
- Moving the Linux build to a newer image raises the oldest Linux that Fleetify runs on: update the requirements in INSTALL.md with it.
- `macos-15-intel` builds and smoke-tests the Intel Mac bundle. When GitHub announces its retirement, decide how to build and test that bundle without it, for example by cross-compiling on an Apple silicon runner.

### A merge queue

The main ruleset's required checks come from `ci.yml`, `dco.yml` and `pr-title.yml`. A merge queue runs checks on `merge_group` events, which none of the three listens to yet, so each needs that trigger before a merge queue is turned on. Otherwise a queued pull request waits for checks that never report.

## Turning on code signing

Today the macOS build is signed with Fleetify's own certificate and isn't notarized, and the Windows installer isn't signed, so both OSes warn before the first start ([INSTALL.md](INSTALL.md)). Signing that the OSes recognise takes an Apple Developer Program membership and a Windows code-signing certificate.

### macOS: Developer ID and notarization

1. Join the Apple Developer Program as an organisation, which takes a D-U-N-S number, and create a Developer ID Application certificate.
2. Put it in the `release` environment in place of the self-signed identity, and give the macOS bundle step notarization credentials, such as an App Store Connect API key, with which Tauri notarizes the app. The hardened runtime and the entitlements in [`src-tauri/Entitlements.plist`](../src-tauri/Entitlements.plist) are in place already. Add each new secret to the list of release secrets in `check-workflows.test.mjs`, which keeps each one in a release-only step.
3. A Developer ID signature's designated requirement names Apple's certificate chain and the team rather than a certificate's hash, so the checks in `macos-signature.mjs` and the pinned requirement change with it. The trust setting in `macos-keychain.sh`, which only a self-signed certificate needs, can go.
4. After the first update signed this way, macOS asks each user once more for the microphone and for Fleetify's keychain items: say so in the release notes, and rewrite INSTALL.md's Gatekeeper steps.

### Windows: a code-signing certificate

1. Get an OV code-signing certificate whose key stays in a cloud signing service.
2. Authenticode signs the app inside the installer as well as the installer, during bundling, so the Windows bundle step moves from the keyless compile job into a Windows job in the `release` environment, as macOS's does, with the signing service's credentials there. Tauri's `bundle.windows.signCommand` can call the service's signing tool.
3. Rewrite INSTALL.md's SmartScreen steps, and the scope note in [SECURITY.md](../SECURITY.md) about the warnings.

### Linux

The `.deb` and `.rpm` aren't GPG-signed. Signing them, or publishing a package repository, takes a GPG key, kept like the others.
