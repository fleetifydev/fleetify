# Security policy

Thank you for helping keep Fleetify and its users safe. Please report a vulnerability privately, as described below, and never in a public issue, discussion or pull request.

## Supported versions

Fleetify is pre-1.0. Security fixes go into the latest release only, and older releases don't get backports.

| Version | Security fixes |
|---|---|
| Latest release | Yes |
| Older releases | No |

## How to report a vulnerability

Use either channel:

- **GitHub private vulnerability reporting**, which we prefer: [open a private report](https://github.com/fleetifydev/fleetify/security/advisories/new). Only you and the maintainers can see it, and we can work on the fix with you in a private advisory.
- **Email:** [security@fleetify.dev](mailto:security@fleetify.dev).

### What to include

- the Fleetify version or commit you tested, and your OS and its version;
- the affected part: the app, a sidecar, the updater, an install script or the fleetify.dev cloud;
- what the vulnerability lets an attacker do, and under which conditions;
- the steps to reproduce it, or a proof of concept;
- logs or screenshots, with tokens, keys and personal data removed;
- whether you have told anyone else, and how you would like to be credited.

## What happens next

- **Within 3 business days**, we acknowledge your report.
- **Within 7 days** of your report, we triage it: we confirm whether it's a vulnerability, assess its severity and tell you what we plan to do.
- **Within 90 days** of your report, we aim to release a fix and publish a GitHub security advisory that credits you, unless you'd rather stay anonymous. If a fix needs longer, we agree a disclosure date with you.

A vulnerability in the fleetify.dev cloud is fixed on the service itself, so there is no release and no advisory: we tell you when it's fixed, and credit you if you wish.

Please keep the details private until the advisory is published or the disclosure date we agreed with you; for a cloud vulnerability, until we tell you it's fixed.

## Scope

In scope:

- the Fleetify desktop app: the Tauri shell, the embedded backend and the user interface;
- the MCP sidecars: `fleet-memory-mcp`, `fleet-dispatch-mcp`, `fleet-reveng-mcp` and `fleet-browser-mcp`;
- the updater and the install scripts.

The fleetify.dev cloud (sign-in, the dashboard and its API) isn't part of this repository, but we accept reports about it the same way and route them to the people who run it.

Out of scope:

- vulnerabilities in the agent CLIs and model providers Fleetify works with, such as Claude Code or Codex: please report those to their vendors;
- vulnerabilities in a dependency that Fleetify doesn't expose: report those upstream, and tell us if you find that Fleetify is affected;
- the warnings Windows and macOS show because Fleetify's builds aren't signed by a publisher they recognise;
- denial-of-service attacks, social engineering, and attacks that need physical access to a user's machine;
- findings from automated scanners without a demonstrated impact.

## Safe harbour

We won't take legal action against you, or ask anyone else to, over security research that makes a good-faith effort to follow this policy:

- test only your own installation and your own accounts, and don't access, change or delete other people's data;
- don't degrade fleetify.dev for others: no denial-of-service or load testing, and no high-volume automated scanning;
- stop when you find a vulnerability, report it, and don't use it further than you need to show it;
- give us a reasonable time to fix it before you disclose anything.

If someone else takes legal action against you over research that followed this policy, we will make it known that you acted in line with it.

## Bug bounty

We don't run a bug bounty yet, so we can't pay for reports. We credit every valid report, unless you prefer otherwise.

## Verifying a release

Every release on the [Releases page](https://github.com/fleetifydev/fleetify/releases) is immutable: once it is published, GitHub lets no one change its files or move its tag. Each one comes with:

- a `SHA256SUMS` file, which lists the SHA-256 checksum of each file in the release;
- GitHub build provenance attestations, which show that a file was built by this repository's GitHub Actions; releases after 0.3.2 also carry them as a file, `provenance.intoto.jsonl`, for `gh attestation verify --bundle`;
- GitHub's attestation of the release itself, which records its tag and the checksum of each of its files.

To check a download, compare its checksum with its line in `SHA256SUMS`, using `sha256sum <file>` on Linux, `shasum -a 256 <file>` on macOS or `Get-FileHash <file>` in PowerShell. Then check where it was built, and that it belongs to the release, with the [GitHub CLI](https://cli.github.com), where `<version>` is the release's version:

```bash
gh attestation verify <file> --repo fleetifydev/fleetify --signer-workflow fleetifydev/fleetify/.github/workflows/release.yml
gh release verify v<version> --repo fleetifydev/fleetify
gh release verify-asset v<version> <file> --repo fleetifydev/fleetify
```
