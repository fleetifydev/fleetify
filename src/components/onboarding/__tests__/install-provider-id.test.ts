import { describe, it, expect } from "vitest";
// Vite's `?raw` query loads the file as a string at test time. We
// assert against the OnboardingChat source directly rather than
// driving the install button through the rendered component because
// the verify loop sits behind a typewriter intro + multi-bubble
// pacing, and the invariant we're guarding ("which tool key reaches
// the IPC?") is a single-line concern that a static check covers
// without timer plumbing.
//
// Regression context: passing `p.scanKey` ("agy_cli",
// "antigravity_sdk", "claude_cli"…) to `installProvider` lands at
// the backend's `shell_install_provider` which routes on the kebab
// `p.id` ("agy", "antigravity-sdk", "claude") and returns
// `unknown provider: <scanKey>` for every CLI install in onboarding.
import onboardingSrc from "@/components/onboarding/onboarding-chat.tsx?raw";

describe("OnboardingChat install IPC", () => {
  it("passes the kebab provider id to installProvider, not the snake-case scanKey", () => {
    expect(onboardingSrc).not.toMatch(/installProvider\(\s*p\.scanKey/);
    // Two call sites today — the auto-install fired during the
    // verify loop and the explicit handleInstall triggered from the
    // row's Install button. Both must use `p.id`.
    const matches = onboardingSrc.match(/installProvider\(\s*p\.id\b/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("gates the verify-loop auto-install on p.autoInstall === true", () => {
    // Antigravity CLI's installer runs a remote shell script
    // (`iex (irm …)` / `curl|bash`) and the Antigravity SDK has a
    // dedicated Setup affordance — neither should fire from the
    // verify-loop spinner. The gate must require an explicit flag,
    // not just "this row has a scanKey".
    expect(onboardingSrc).toMatch(/p\.autoInstall\s*===\s*true/);
  });

  it("does not autoInstall any provider — every CLI waits for an explicit Install click", () => {
    // Earlier iterations auto-fired `npm install -g …` for Claude /
    // Codex / Gemini / Kimi during the verify loop. Users reported it
    // as surprising ("why is something downloading?"), so the contract
    // now requires every row — including the npm-installed CLIs — to
    // wait for an explicit Install button click. The verify-loop gate
    // (`p.autoInstall === true`) is preserved so a future first-run
    // experience can opt a row back in without re-plumbing.
    const block = onboardingSrc.match(/const PROVIDERS:\s*ProviderDef\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const rows = block![1].split(/},\s*/);
    const autoInstallById = new Map<string, boolean>();
    for (const row of rows) {
      const idMatch = row.match(/id:\s*"([^"]+)"/);
      if (!idMatch) continue;
      autoInstallById.set(idMatch[1], /autoInstall:\s*true/.test(row));
    }
    for (const [id, opted] of autoInstallById) {
      expect(opted, `${id} must not opt in to autoInstall`).toBe(false);
    }
  });

  it("renders an identifying header for the Antigravity SDK row", () => {
    // The SDK render must include a ProviderLogo + {p.label} (or the
    // shared <KeyEntryRow> which itself renders both) so the row
    // never reverts to the orphan "Python detected …" block users
    // reported as a vanished row in the screenshot follow-up.
    const sdkBranchStart = onboardingSrc.indexOf(`p.id === "antigravity-sdk"`);
    expect(sdkBranchStart, "antigravity-sdk render branch not found").toBeGreaterThan(0);
    // Slice the branch out — every branch in providers.map ends in
    // `);\n        }`. The next branch starts on a new top-level if.
    // 4000 chars is comfortably wider than the SDK branch today.
    const sdkBranch = onboardingSrc.slice(sdkBranchStart, sdkBranchStart + 4000);
    expect(sdkBranch).toMatch(/<ProviderLogo\s|<KeyEntryRow\s/);
    expect(sdkBranch).toMatch(/\{\s*p\.label\s*\}|<KeyEntryRow\s/);
  });

  it("renders inline key entry for API providers and a URL row for Ollama", () => {
    // The user finishes setup on this screen instead of bouncing to
    // Settings → Providers. Regression guard: each API-key provider
    // routes through KeyEntryRow when no key is present, and Ollama
    // always routes through OllamaUrlRow.
    expect(onboardingSrc).toMatch(/<KeyEntryRow\b/);
    expect(onboardingSrc).toMatch(/<OllamaUrlRow\b/);
  });

  it("runs provider verification in parallel, not sequentially", () => {
    // The verify loop used to be a `for (const p of providers)` with
    // a 250 ms stagger between rows. Switching to Promise.all means
    // all spinners light up in unison and the screen finishes in
    // roughly max(provider time) instead of sum.
    expect(onboardingSrc).toMatch(/Promise\.all\(\s*providers\.map\(/);
    expect(onboardingSrc).not.toMatch(/for\s*\(\s*const\s+p\s+of\s+providers\s*\)/);
  });

  it("lists every backend catalog provider id (full 20) and keeps gemini-api naming", () => {
    // providers.setKey/setDefault reject ids not in `providers::CATALOG`.
    // Onboarding must now offer the FULL catalog so the selection drives
    // the enabled set. Anthropic + Cloudflare + the three new CLIs join
    // the list; only the legacy mis-ids stay banned.
    const block = onboardingSrc.match(/const PROVIDERS:\s*ProviderDef\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const ids = Array.from(block![1].matchAll(/id:\s*"([^"]+)"/g)).map((m) => m[1]);

    // Legacy mis-ids that are NOT in the catalog must never appear.
    expect(ids).not.toContain("groq");
    expect(ids).not.toContain("googleai");
    expect(ids).toContain("gemini-api");

    // The full catalog (20 ids).
    const catalog = [
      "claude", "codex", "gemini", "kimi", "opencode", "github-copilot",
      "cursor", "agy", "antigravity-sdk",
      "openai", "anthropic", "deepseek", "grok", "nvidia-nim", "kimi-api",
      "gemini-api", "perplexity", "openrouter", "cloudflare-workers-ai",
      "ollama",
    ];
    for (const id of catalog) {
      expect(ids, `expected catalog provider "${id}" in onboarding list`).toContain(id);
    }
    expect(ids.length).toBe(catalog.length);
  });

  it("renders a Continue button gated on at least one ready provider", () => {
    // The main-agent picker used to appear automatically after a
    // fixed timer; users complained it fired before they finished
    // pasting keys. The widget now exposes onContinue and renders
    // a ContinueRow at the bottom, enabled only when isProviderReady
    // returns true for at least one row.
    expect(onboardingSrc).toMatch(/<ContinueRow\b/);
    expect(onboardingSrc).toMatch(/function ContinueRow\b/);
    expect(onboardingSrc).toMatch(/providers\.some\(\s*\(\s*p\s*\)\s*=>\s*isProviderReady\b/);
  });

  it("filters the main-agent picker to ready providers", () => {
    // MainAgentWidget receives readyProviders (when populated) so
    // the user can't pick a not-yet-installed CLI as the default.
    expect(onboardingSrc).toMatch(/<MainAgentWidget[\s\S]*?providers=\{\s*readyProviders\s*\?\?/);
  });

  it("freezes inputs and buttons after Continue (forwarded via frozen prop)", () => {
    // Once the parent resolves the verify-step message, every
    // interactive bit (Edit Key, Save, Cancel, Install, Download,
    // Set URL, Continue) has to be gone — the user shouldn't be
    // able to retype values for a step they just signed off on.
    expect(onboardingSrc).toMatch(/frozen\?\s*:\s*boolean/);
    // KeyEntryRow + OllamaUrlRow forward frozen to suppress their
    // action buttons and entry panels.
    expect(onboardingSrc).toMatch(/!frozen\s*&&\s*mode\s*===\s*"entry"/);
    expect(onboardingSrc).toMatch(/!frozen\s*&&\s*open\s*&&\s*!running/);
  });

  it("renames Codex / Gemini CLI rows and uses 'Gemini' label for the API row", () => {
    // Codex CLI / Gemini CLI labels disambiguate the CLI rows from
    // their API namesakes; the API row's label drops to plain
    // "Gemini" (the brand the user knows) while its catalog id
    // stays "gemini-api" so providers.setKey hits the right entry.
    expect(onboardingSrc).toMatch(/label:\s*"Codex CLI"/);
    expect(onboardingSrc).toMatch(/label:\s*"Gemini CLI"/);
    expect(onboardingSrc).toMatch(/id:\s*"gemini-api"[\s\S]{0,80}label:\s*"Gemini"/);
  });

  it("Edit affordance reads 'Edit Key' and requires a non-empty model list to land on Ready", () => {
    // Spec: the underlined link in the saved-state row must say
    // "Edit Key", not just "Edit". Treat the testConnection result
    // as failed when model_count is zero / null — Gemini's OpenAI-
    // compat /models endpoint has been observed returning 200 with
    // a public catalogue regardless of key validity, which is what
    // made bad keys look Ready.
    expect(onboardingSrc).toMatch(/Edit Key/);
    expect(onboardingSrc).toMatch(/test\.model_count[\s\S]{0,80}>\s*0/);
  });

  it("picker shows 'Add key' for catalog API providers without env-key probes", () => {
    // DeepSeek / Grok / Kimi API / Perplexity / NVIDIA NIM don't have
    // env-var buckets on the scan probe — falling through to the
    // empty-label branch left them with a bare dot in the picker
    // while OpenAI / Google AI still said "Add key". Mirror those
    // by adding a `p.kind === "api"` fallback in getInstallInfo.
    expect(onboardingSrc).toMatch(/p\.kind\s*===\s*"api"[\s\S]{0,200}label:\s*"Add key"/);
  });

  it("KeyEntryRow supports a saved mode with masked preview and Edit", () => {
    // After setKey + testConnection succeed, the row swaps to a
    // saved-state header (masked preview + underlined Edit link)
    // instead of showing "Add key in Settings" through the
    // fall-through to ScanRow. Edit returns the row to entry mode.
    expect(onboardingSrc).toMatch(/initiallyHasKey\b/);
    // Method dispatch may be split across lines (prettier wraps long
    // chains) so match `providersApi` and the method name separately.
    expect(onboardingSrc).toMatch(/providersApi[\s\n]*\.[\s\n]*getKeyPreview\b/);
    expect(onboardingSrc).toMatch(/providersApi[\s\n]*\.[\s\n]*testConnection\b/);
    // The saved view's Edit affordance has to remain an underlined
    // text button (per the user spec) so it visibly invites a click.
    expect(onboardingSrc).toMatch(/textDecoration:\s*"underline"/);
  });

  it("persists the selection as the enabled set via setConnectedBulk", () => {
    // Selecting providers in onboarding must now drive Settings → Providers.
    // handleProvidersConfirm builds the connected map from the catalog +
    // calls setConnectedBulk so non-selected providers are forced OFF.
    expect(onboardingSrc).toMatch(/buildSelectionPersist\(/);
    expect(onboardingSrc).toMatch(/providersApi[\s\n]*\.[\s\n]*setConnectedBulk\(/);
  });

  it("shows a 'Set up in Settings' hint for probe-less CLI agents", () => {
    // opencode / cursor / github-copilot have no scanKey; resolveProvider
    // and getInstallInfo must point the user to Settings rather than show
    // a bare "Manual setup" / empty label.
    expect(onboardingSrc).toMatch(/detail:\s*"Set up in Settings"/);
    expect(onboardingSrc).toMatch(/p\.kind\s*===\s*"cli"[\s\S]{0,120}label:\s*"Set up in Settings"/);
  });

  it("fleet step persists an explicit (provider, model) via setDefault", () => {
    // handleMainAgentPick now takes a modelId and passes it to setDefault
    // so first launch opens on the chosen model, not Auto.
    expect(onboardingSrc).toMatch(/handleMainAgentPick\s*=\s*async\s*\(\s*provider:[^)]*modelId/);
    expect(onboardingSrc).toMatch(/setDefault\(\s*provider\.id\s*,\s*modelId/);
  });

  it("fleet step renders a model sub-list from catalog tiles", () => {
    // MainAgentWidget resolves models via modelsForTile and renders ModelRow.
    expect(onboardingSrc).toMatch(/modelsForTile\(/);
    expect(onboardingSrc).toMatch(/<ModelRow\b/);
    expect(onboardingSrc).toMatch(/function ModelRow\b/);
  });
});
