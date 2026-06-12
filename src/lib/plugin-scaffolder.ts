/**
 * Plugin scaffolder — pure functions that turn a form state into the
 * file map a fresh Fleet plugin repository needs.
 *
 * Schema reference: `backend/app/services/plugins/types.py::PluginManifest`.
 * Anything the parser there demands (kebab-case name, semver version,
 * non-empty providers list, declares counts matching what's on disk)
 * must come out of this generator correctly — otherwise the marketplace
 * fetch path will reject the plugin with a 4xx.
 */

export interface ScaffoldInput {
  name: string;          // kebab-case slug
  displayName?: string;  // optional human-readable label (manifest.display_name)
  version: string;       // semver
  description: string;
  authorName: string;
  authorUrl?: string;
  homepage?: string;
  license?: string;
  tags: string[];        // each kebab-case-ish; we lowercase before write
  providers: ("claude-code" | "codex" | "gemini")[]; // non-empty
  components: {
    mcp_server: boolean;
    skill: boolean;
    template: boolean;
    hook: boolean;
    workflow: boolean;
  };
  mcp?: {
    command: string;     // e.g. "npx"
    args: string[];      // e.g. ["-y", "@org/some-mcp-server"]
    envVars: string[];   // names of env vars to forward, e.g. ["GITHUB_TOKEN"]
  };
  secrets: { key: string; label: string; url?: string }[];
}

export interface ScaffoldOutput {
  files: Record<string, string>;
  /** Inert dry-run flag — useful when the caller wants to preview the
   *  file list without invoking the electron writer. */
  fileCount: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function validateScaffoldInput(input: ScaffoldInput): string | null {
  if (!input.name.trim()) return "Name is required.";
  if (!NAME_RE.test(input.name)) {
    return "Name must be kebab-case (lowercase letters, digits, hyphens; cannot start with a hyphen).";
  }
  if (input.name.length > 40) return "Name is too long (max 40 chars).";
  if (input.displayName !== undefined && input.displayName.length > 80) {
    return "Display name is too long (max 80 chars).";
  }
  if (!input.version.trim()) return "Version is required.";
  if (!SEMVER_RE.test(input.version)) {
    return `Version must be semver (e.g. 0.1.0), got "${input.version}".`;
  }
  if (!input.description.trim()) return "Description is required.";
  if (input.description.length > 200) return "Description is too long (max 200 chars).";
  if (!input.authorName.trim()) return "Author name is required.";
  if (input.providers.length === 0) return "Pick at least one supported provider.";

  const anyComponent = Object.values(input.components).some(Boolean);
  if (!anyComponent) return "Pick at least one component the plugin will provide.";

  if (input.components.mcp_server) {
    if (!input.mcp || !input.mcp.command.trim()) {
      return "MCP server: command is required (e.g. 'npx').";
    }
  }
  for (const s of input.secrets) {
    if (!s.key.trim()) return "Secret key is required.";
    if (!/^[A-Z][A-Z0-9_]*$/.test(s.key)) {
      return `Secret key "${s.key}" should be SCREAMING_SNAKE_CASE.`;
    }
    if (!s.label.trim()) return `Secret "${s.key}" needs a human-readable label.`;
  }
  return null;
}

export function generateScaffold(input: ScaffoldInput): ScaffoldOutput {
  const files: Record<string, string> = {};

  // ── declares: counts must match what we write to disk, otherwise
  //    the backend's count_components_on_disk cross-check rejects.
  //
  //    Per-provider components (skills / commands / hooks) get duplicated
  //    into every declared provider's .<provider>/ subdir below. ──
  const perProvider = {
    skills:   input.components.skill ? 1 : 0,
    commands: 0,
    hooks:    input.components.hook ? 1 : 0,
  };
  const blankProvider = { skills: 0, commands: 0, hooks: 0 };
  const declares = {
    mcp_servers: input.components.mcp_server ? 1 : 0,
    templates:   input.components.template ? 1 : 0,
    workflows:   input.components.workflow ? 1 : 0,
    providers: {
      "claude-code": input.providers.includes("claude-code") ? perProvider : blankProvider,
      gemini: input.providers.includes("gemini") ? perProvider : blankProvider,
      codex:  input.providers.includes("codex") ? perProvider : blankProvider,
    },
  };

  // ── .fleetify-plugin/plugin.json ──
  const trimmedDisplay = input.displayName?.trim();
  const manifest: Record<string, unknown> = {
    name: input.name,
    ...(trimmedDisplay ? { display_name: trimmedDisplay } : {}),
    version: input.version,
    description: input.description,
    author: {
      name: input.authorName,
      ...(input.authorUrl ? { url: input.authorUrl } : {}),
    },
    providers: input.providers,
    declares,
    ...(input.tags.length > 0 ? { tags: input.tags.map(t => t.toLowerCase()) } : {}),
    ...(input.homepage ? { homepage: input.homepage } : {}),
    ...(input.license ? { license: input.license } : {}),
    ...(input.secrets.length > 0 ? {
      requires_secrets: input.secrets.map(s => ({
        key: s.key,
        label: s.label,
        ...(s.url ? { url: s.url } : {}),
      })),
    } : {}),
  };
  files[".fleetify-plugin/plugin.json"] = JSON.stringify(manifest, null, 2) + "\n";

  // ── mcp.json — only when an MCP server is declared. ──
  if (input.components.mcp_server && input.mcp) {
    const envBlock: Record<string, string> | undefined = input.mcp.envVars.length > 0
      ? Object.fromEntries(input.mcp.envVars.map(v => [v, `\${${v}}`]))
      : undefined;
    const mcpJson = {
      mcpServers: {
        [input.name]: {
          command: input.mcp.command,
          args: input.mcp.args,
          ...(envBlock ? { env: envBlock } : {}),
        },
      },
    };
    files["mcp.json"] = JSON.stringify(mcpJson, null, 2) + "\n";
  }

  // Per-provider components live under .<provider>/ subdirs — the
  // backend materializer copies these into each provider's native
  // skills / commands / hooks roots at install time. Authoring once
  // per provider keeps the cross-check in lockstep with the manifest
  // declares and means each provider can diverge later (e.g. a
  // Gemini-specific tweak in its SKILL.md without touching Claude's).

  const SKILL_BODY =
`---
name: example-skill
description: Short one-line description of when an agent should reach for this skill.
---

# Example skill

Replace this body with the actual guidance / reference content the agent
should load when this skill is invoked. Skills are surfaced as part of
the system prompt — keep them tight and high-signal.
`;

  const HOOK_SCRIPT =
`#!/usr/bin/env sh
# Example hook — fired by the provider's hook subsystem.
# stdin: a JSON event payload. stdout/stderr: ignored unless logged.
# exit 0 to allow, exit 2 to block (Claude / Gemini / Codex shared
# convention).
echo "hello from example-hook" >&2
`;
  const HOOKS_JSON = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              // Materializer expands ${FLEETIFY_HOOK_SCRIPTS} to the
              // absolute path of the scripts dir at install time.
              command: "${FLEETIFY_HOOK_SCRIPTS}/example.sh",
            },
          ],
        },
      ],
    },
  }, null, 2) + "\n";

  for (const provider of input.providers) {
    if (input.components.skill) {
      files[`.${provider}/skills/example-skill/SKILL.md`] = SKILL_BODY;
    }
    if (input.components.hook) {
      files[`.${provider}/hooks/hooks.json`] = HOOKS_JSON;
      files[`.${provider}/hooks/scripts/example.sh`] = HOOK_SCRIPT;
    }
  }

  // ── templates/example-agent.md (cross-cutting, root-level) ──
  if (input.components.template) {
    files["templates/example-agent.json"] = JSON.stringify({
      name: "example-agent",
      description: "A preset agent role this plugin contributes.",
      system_prompt:
        "You are an Example agent specialised in <describe domain>.\n\n" +
        "## Operating principles\n" +
        "- Replace these with the real principles for this agent role.\n" +
        "- Stay scoped to the domain above.\n",
    }, null, 2) + "\n";
  }

  // ── workflows/example-workflow.json (cross-cutting, root-level) ──
  if (input.components.workflow) {
    files["workflows/example-workflow.json"] = JSON.stringify({
      name: "example-workflow",
      description: "Multi-step recipe this plugin contributes.",
      steps: [
        { name: "step-1", prompt: "Describe step 1 here." },
        { name: "step-2", prompt: "Describe step 2 here." },
      ],
    }, null, 2) + "\n";
  }

  // ── README.md ──
  files["README.md"] = generateReadme(input);

  return { files, fileCount: Object.keys(files).length };
}

function generateReadme(input: ScaffoldInput): string {
  const componentLines: string[] = [];
  // Surface provider-scoped components once with the first listed
  // provider as a representative path, so the README isn't N copies of
  // the same line. The actual files live under every declared provider.
  const firstProvider = input.providers[0] ?? "claude-code";
  if (input.components.mcp_server) componentLines.push("- **MCP server** — `mcp.json`");
  if (input.components.skill)      componentLines.push(`- **Skill** — \`.${firstProvider}/skills/example-skill/\``);
  if (input.components.template)   componentLines.push("- **Agent template** — `templates/example-agent.json`");
  if (input.components.hook)       componentLines.push(`- **Hook** — \`.${firstProvider}/hooks/hooks.json\``);
  if (input.components.workflow)   componentLines.push("- **Workflow** — `workflows/example-workflow.json`");

  const secretLines = input.secrets.length > 0
    ? input.secrets.map(s => `- \`${s.key}\` — ${s.label}${s.url ? ` ([get one](${s.url}))` : ""}`).join("\n")
    : "_No secrets required._";

  const title = input.displayName?.trim() || input.name;
  return `# ${title}

${input.description}

Built by **${input.authorName}**${input.authorUrl ? ` ([${input.authorUrl}](${input.authorUrl}))` : ""}.

## What this plugin provides

${componentLines.length > 0 ? componentLines.join("\n") : "_No components declared._"}

## Required secrets

${secretLines}

## Install

1. Push this folder to a public GitHub repository.
2. In Fleet, open **Marketplace → Sources → Add source** and paste the repo URL.
3. The plugin appears in your discover surface; click **Get** to install it.

## Submit to Fleet Official

Want this plugin in the curated Fleet Official catalog? Open a pull request
against [\`fleetifydev/marketplace\`](https://github.com/fleetifydev/marketplace)
with this folder added under the top-level path.

---

_Scaffolded by Fleet → Marketplace → Publish._
`;
}
