// Plugin foundation — shared TypeScript types mirroring backend Pydantic models.

export type Provider = "claude" | "codex" | "gemini";
export type ScopeType = "user" | "project" | "agent";

export interface Author { name: string; url?: string; }

export interface SecretRequirement {
  key: string;
  label: string;
  url?: string;
}

/** Per-provider declares for Claude + Gemini, both of which ship
 *  reusable slash commands under ``.<provider>/commands/``. Codex has
 *  its own shape (see :type:`CodexProviderDeclares`) because Codex never
 *  had a commands concept — it loads reusable instruction blocks from
 *  ``~/.codex/prompts/`` instead. */
export interface ProviderDeclares {
  skills: number;
  commands: number;
  hooks: number;
}

/** Codex-only declares — ``prompts`` replaces ``commands``. The Codex
 *  CLI auto-discovers ``.md`` files in ``~/.codex/prompts/`` and surfaces
 *  them as ``/prompts:<name>``; the marketplace materializer copies a
 *  plugin's ``.codex/prompts/`` directory into that location. There is
 *  intentionally NO ``commands`` field — pydantic's ``extra="forbid"``
 *  on the backend will reject a manifest that tries to set it. */
export interface CodexProviderDeclares {
  skills: number;
  prompts: number;
  hooks: number;
}

export interface ProvidersDeclares {
  claude: ProviderDeclares;
  gemini: ProviderDeclares;
  codex: CodexProviderDeclares;
}

export interface Declares {
  mcp_servers: number;
  templates: number;
  workflows: number;
  /** Fleetify-native prompt count — sources at `<plugin>/.fleetify/prompts/*.md`,
   *  materializes to `~/.fleetify/prompts/` (user scope) or
   *  `<project>/.fleetify/prompts/` (project scope). Replaces the
   *  legacy `providers.codex.prompts` field, which is now deprecated. */
  prompts: number;
  providers: ProvidersDeclares;
}

/** Content-type categories surfaced to the marketplace UI as filter
 *  chips. Distinct from `PluginManifest.tags` (domain — "productivity",
 *  "devops"); `provides` describes *what's inside* the plugin and is
 *  derived from `declares.*` counts. Mirrors the backend `Provides`
 *  Literal — see `docs/provides.md` for the canonical derivation rules.
 *  Update both sides together. */
export type Provides =
  | "mcp"
  | "skills"
  | "commands"
  | "prompts"
  | "hooks"
  | "subagents"
  | "workflows";

/** Stable ordering for filter chip rendering — matches the spec's
 *  table. ``prompts`` sits right after ``commands`` to surface the
 *  related-but-distinct content type adjacency: slash commands are
 *  authored for an agent CLI's /command surface, prompts are
 *  Fleetify-native reusable text blocks. */
export const PROVIDES_ORDER: readonly Provides[] = [
  "mcp", "skills", "commands", "prompts", "hooks", "subagents", "workflows",
] as const;

/** Bilingual labels for the filter chips. The backend ships English
 *  values; we render whichever language the user expects. Spec
 *  ``docs/provides.md`` is the source of these strings. */
export const PROVIDES_LABEL_TR: Record<Provides, string> = {
  mcp: "MCP Sunucusu",
  skills: "Skill",
  commands: "Komut",
  prompts: "Prompt",
  hooks: "Hook",
  subagents: "Alt Ajan",
  workflows: "Workflow",
};
export const PROVIDES_LABEL_EN: Record<Provides, string> = {
  mcp: "MCP Server",
  skills: "Skills",
  commands: "Commands",
  prompts: "Prompts",
  hooks: "Hooks",
  subagents: "Subagents",
  workflows: "Workflows",
};

/** Compute `provides` from a Declares snapshot. Mirrors backend's
 *  `derive_provides` (see `backend/app/services/plugins/types.py`).
 *  Used as a graceful fallback when the API response is missing the
 *  field (older marketplace.json cache, third-party source served by
 *  a tool that hasn't been updated). The backend normally fills it
 *  via the manifest validator, so this only matters at the seams. */
export function deriveProvides(d: Declares): Provides[] {
  const out: Provides[] = [];
  if (d.mcp_servers > 0) out.push("mcp");
  if (d.providers.claude.skills > 0
      || d.providers.gemini.skills > 0
      || d.providers.codex.skills > 0) out.push("skills");
  // ``commands`` is now strictly /-commands authored for agent CLIs
  // (Claude, Gemini). Codex's ``prompts`` field used to feed into this
  // bucket — it's been moved up to ``Declares.prompts`` and rendered
  // as its own chip below.
  if (d.providers.claude.commands > 0
      || d.providers.gemini.commands > 0) out.push("commands");
  if (d.prompts > 0) out.push("prompts");
  if (d.providers.claude.hooks > 0
      || d.providers.gemini.hooks > 0
      || d.providers.codex.hooks > 0) out.push("hooks");
  if (d.templates > 0) out.push("subagents");
  if (d.workflows > 0) out.push("workflows");
  return out;
}

/** Read `provides` off a manifest with a safety net: if the field is
 *  missing/empty (older catalog entry), derive on the fly so the
 *  filter UI still works. Always returns at least an empty array. */
export function manifestProvides(m: PluginManifest): Provides[] {
  if (m.provides && m.provides.length > 0) return m.provides;
  return deriveProvides(m.declares);
}

/** Total component count for a plugin — what the install dialog
 *  summary, the detail page header, and the marketplace cards all want.
 *  Provider-aware: sums skills+hooks across all three providers, sums
 *  commands across Claude+Gemini only, sums prompts on Codex only. */
export function totalDeclaredComponents(d: Declares): number {
  const claude = d.providers.claude.skills + d.providers.claude.commands + d.providers.claude.hooks;
  const gemini = d.providers.gemini.skills + d.providers.gemini.commands + d.providers.gemini.hooks;
  // Codex used to contribute its ``prompts`` count here; the field
  // moved up to ``d.prompts`` as a Fleetify-native cross-cutting
  // count. ``providers.codex.prompts`` lingers on the schema for
  // backward-compat but no longer materializes, so we don't double-
  // count it here either.
  const codex  = d.providers.codex.skills + d.providers.codex.hooks;
  return d.mcp_servers + d.templates + d.workflows + d.prompts + claude + gemini + codex;
}

/** Resolve the user-facing label for a plugin manifest. Every UI
 *  surface that shows a plugin name should go through this so the
 *  fallback rule (`display_name ?? name`) stays in one place. */
export function pluginLabel(m: { display_name?: string; name: string }): string {
  return m.display_name && m.display_name.trim() ? m.display_name : m.name;
}

export interface PluginManifest {
  name: string;
  /** Optional human-readable title shown in marketplace + install dialog
   *  + detail page. Falls back to `name` (the kebab-case slug) when
   *  missing. `name` stays the identifier; this field is cosmetic. */
  display_name?: string;
  version: string;
  description: string;
  author?: Author;
  min_fleetify_version?: string;
  providers: Provider[];
  tags: string[];
  /** Content-type categories — `["mcp", "skills"]`. The backend
   *  validator fills this from `declares.*` counts so older manifests
   *  without the field still surface a value. May be missing on
   *  responses served from a stale third-party catalog cache; route
   *  reads through `manifestProvides()` to fall back to client-side
   *  derivation in that case. */
  provides?: Provides[];
  icon?: string;
  requires_secrets: SecretRequirement[];
  declares: Declares;
  homepage?: string;
  license?: string;
}

export interface MarketplaceSource {
  id: string;
  name: string;
  description?: string | null;
  repo_url: string;
  is_official: boolean;
  enabled: boolean;
}

export interface CatalogPlugin {
  source_id: string;
  source_name: string;
  source_is_official: boolean;
  path: string;
  featured: boolean;
  manifest: PluginManifest;
}

export interface PluginEnablement {
  scope_type: ScopeType;
  scope_id: string | null;
  enabled: boolean;
}

export interface PluginInstall {
  id: string;
  plugin_name: string;
  version: string;
  source_id: string;
  commit_sha: string;
  install_path: string;
  auto_update: boolean;
  /** Master switch driving whether the plugin is currently materialised
   *  on disk. When false every scope is torn down even though the
   *  underlying enablement rows are kept, so flipping it back to true
   *  rehydrates the same configuration. */
  master_enabled: boolean;
  installed_at: string | null;
  last_updated_at: string | null;
  manifest: PluginManifest;
  enablements: PluginEnablement[];
}

export interface UpdatePreview {
  current_version: string;
  new_version: string;
  declares_changed: boolean;
  secrets_changed: boolean;
  old_declares: Declares;
  new_declares: Declares;
  new_requires_secrets: SecretRequirement[];
  old_version: string;
}

export interface PluginDetail {
  source_id: string;
  source_name: string;
  source_is_official: boolean;
  path: string;
  manifest: PluginManifest;
  readme_md: string | null;
  changelog_md: string | null;
  repo_url: string;
}

export interface ProbeResult {
  kind: "marketplace" | "plugin";
  name: string;
  description?: string;
  plugin_count: number;
}

export interface AddSourceResult {
  id: string;
  name: string;
  kind: "marketplace" | "plugin";
  plugin_count: number;
}
