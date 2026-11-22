# Changelog

## [0.2.1](https://github.com/fleetifydev/fleetify/compare/v0.2.0...v0.2.1) (2026-11-22)


### Bug Fixes

* **branding:** make the app icon visible on dark and light backgrounds ([#35](https://github.com/fleetifydev/fleetify/issues/35)) ([d3d4d04](https://github.com/fleetifydev/fleetify/commit/d3d4d04ecdaf21fe4d8248885f89d35ce106b2a7))
* **windows:** stop opening a console window for each background command ([#34](https://github.com/fleetifydev/fleetify/issues/34)) ([a1a9f65](https://github.com/fleetifydev/fleetify/commit/a1a9f6590b15174d49c954461be916ac9522cf53))

## [0.2.0](https://github.com/fleetifydev/fleetify/releases/tag/v0.2.0) (2026-11-22)

The first public release of Fleetify, a command center for AI agents: run Claude Code, Codex, OpenCode and more side by side from one desktop app, follow every session from the Fleet hub, and keep parallel work apart with git worktrees. Fleetify is open source under the Apache License 2.0.

**Install.** Pick the file for your system below and follow [INSTALL.md](https://github.com/fleetifydev/fleetify/blob/main/docs/INSTALL.md). Fleetify asks you to sign in with a free Fleetify account the first time it starts.

**About the warnings.** The Windows installer isn't code-signed, so Microsoft Defender SmartScreen warns you before it runs. The macOS app is signed with Fleetify's own certificate and isn't notarized by Apple, so macOS asks you to allow it once. INSTALL.md walks through both. Every file is listed in `SHA256SUMS` and has a GitHub build provenance attestation; [Verify a download](https://github.com/fleetifydev/fleetify/blob/main/docs/INSTALL.md#verify-a-download) shows how to check them.

**Updates.** From this release on, Fleetify checks for updates when it starts and every six hours, downloads them in the background, and installs them when you choose **Restart to update**.

### Features

* **onboarding:** link the terms and the privacy policy from the sign-in screen ([#29](https://github.com/fleetifydev/fleetify/issues/29)) ([c160cfb](https://github.com/fleetifydev/fleetify/commit/c160cfb71f788b1ed410f789499d6ce724e45272))
* **release:** publish signed releases with release-please ([#27](https://github.com/fleetifydev/fleetify/issues/27)) ([37a8901](https://github.com/fleetifydev/fleetify/commit/37a8901b42e2e26cce16a07d4e25f163f5ebe123))
* **updater:** download updates in the background and restart to install ([#25](https://github.com/fleetifydev/fleetify/issues/25)) ([efa6686](https://github.com/fleetifydev/fleetify/commit/efa6686bcb6502d0af6a95f4ecfcf4ff2ab8752e))

### Bug Fixes

* **backend:** load the built-in config and keep fleet.db in ~/.fleetify ([#19](https://github.com/fleetifydev/fleetify/issues/19)) ([11e6eac](https://github.com/fleetifydev/fleetify/commit/11e6eac356589fbc076f7854ac35f12d3cc532f7))
* **fleet-wipe:** refuse unknown arguments and require --yes to delete ([#21](https://github.com/fleetifydev/fleetify/issues/21)) ([5ae76e3](https://github.com/fleetifydev/fleetify/commit/5ae76e3529829a0536304614bb0096aaabbd28de))
* **models:** ship an up-to-date offline model catalog ([#24](https://github.com/fleetifydev/fleetify/issues/24)) ([601dcc9](https://github.com/fleetifydev/fleetify/commit/601dcc943c1afa1c03e20c51fc210364c3345887))
* pre-release hardening ([#3](https://github.com/fleetifydev/fleetify/issues/3)) ([dd1a825](https://github.com/fleetifydev/fleetify/commit/dd1a825301a33ccef9ea70f7ee900943ee37d5ed))
* release readiness for the first public release ([#2](https://github.com/fleetifydev/fleetify/issues/2)) ([c3dc869](https://github.com/fleetifydev/fleetify/commit/c3dc8694f397adc3754b017aa453ed8329cf31cd))

### Dependencies

* move to zip 9 ([#22](https://github.com/fleetifydev/fleetify/issues/22)) ([bf4fa21](https://github.com/fleetifydev/fleetify/commit/bf4fa21a9954880d37303bffef34ff069cebfc6c))
* update url to 2.5.9 ([#33](https://github.com/fleetifydev/fleetify/issues/33)) ([da72f22](https://github.com/fleetifydev/fleetify/commit/da72f22256ec6390dcf761277a62c48dd62c5cfc))
