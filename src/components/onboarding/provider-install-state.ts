import type { ProviderScan } from "@/lib/api";

/**
 * CLI-agent buckets on the system scan that carry an `installed` flag.
 *
 * Each scan key is the snake_case form of the catalog provider id (kebab `-` →
 * `_`), mapping 1:1 to the `providers::CATALOG` id:
 *
 *   provider id (p.id)   scan key            binary
 *   claude-code          claude_code         claude
 *   antigravity-cli      antigravity_cli     agy
 *   github-copilot       github_copilot      copilot
 *
 * These are the JSON keys of `ProviderScan`, hand-built by the backend at
 * `/providers/scan` (see `routers/providers.rs`); the id↔scanKey pairing lives
 * on each `ProviderDef` in onboarding-chat.tsx, and `isProviderInstalled`
 * indexes the scan response by this key (`scan[p.scanKey]`).
 */
export type ScanCliKey = keyof Pick<
  ProviderScan,
  | "claude_code"
  | "codex_cli"
  | "kimi_code"
  | "antigravity_cli"
  | "antigravity_sdk"
  | "opencode"
  | "cursor_cli"
  | "grok_build"
  | "github_copilot"
  | "hermes_agent"
>;

/** The provider-row fields that determine install detection. */
export interface ProviderInstallProbe {
  /** Local Ollama row — detected via the system scan's `ollama` bucket. */
  ollama?: boolean;
  /** CLI agents — detected via the system scan's `installed` flag. */
  scanKey?: ScanCliKey;
}

/**
 * Whether a provider row should render under "Installed on this device".
 *
 * Local Ollama isn't a CLI binary on PATH, so it carries no `scanKey`; its scan
 * bucket is `{ running, installed, models }`. We key on `installed` — the
 * durable signal (the daemon answered OR the `ollama` binary is on disk) — and
 * fall back to `running`. Keying on `running` alone was the bug: the picker's
 * scan snapshot is taken seconds before the verify step's re-scan, so a daemon
 * that is stopped or merely slow to answer the 2 s probe got mis-bucketed as
 * "Installable" even though Ollama was installed. Every other CLI agent is
 * detected via its `scanKey` bucket's `installed` flag.
 */
export function isProviderInstalled(
  p: ProviderInstallProbe,
  scan: ProviderScan | null,
): boolean {
  if (p.ollama) return scan?.ollama?.installed === true || scan?.ollama?.running === true;
  return !!(p.scanKey && scan && scan[p.scanKey]?.installed);
}
