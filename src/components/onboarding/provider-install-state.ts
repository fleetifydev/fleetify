import type { ProviderScan } from "@/lib/api";

/** CLI-agent buckets on the system scan that carry an `installed` flag. */
export type ScanCliKey = keyof Pick<
  ProviderScan,
  | "claude_cli"
  | "codex_cli"
  | "kimi_cli"
  | "agy_cli"
  | "antigravity_sdk"
  | "opencode_cli"
  | "cursor_cli"
  | "grok_cli"
  | "github_copilot_cli"
  | "hermes_cli"
>;

/** The provider-row fields that determine install detection. */
export interface ProviderInstallProbe {
  /** Local Ollama daemon row — detected via the live HTTP scan, not a binary. */
  ollama?: boolean;
  /** CLI agents — detected via the system scan's `installed` flag. */
  scanKey?: ScanCliKey;
}

/**
 * Whether a provider row should render under "Installed on this device".
 *
 * Local Ollama is an HTTP daemon, not a CLI binary on PATH: its scan shape is
 * `{ running, models }` (no `installed` field), so it deliberately carries no
 * `scanKey` and is detected via `scan.ollama.running`. Without this branch the
 * Ollama row — having no `scanKey` — was unconditionally bucketed as
 * "Installable" even with the daemon running. Every other CLI agent is
 * detected via its `scanKey` bucket's `installed` flag.
 */
export function isProviderInstalled(
  p: ProviderInstallProbe,
  scan: ProviderScan | null,
): boolean {
  if (p.ollama) return scan?.ollama?.running === true;
  return !!(p.scanKey && scan && scan[p.scanKey]?.installed);
}
