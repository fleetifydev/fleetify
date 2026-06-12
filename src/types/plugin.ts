// Plugin foundation — shared TypeScript types mirroring backend Pydantic models.

/** Every CLI agent a plugin can target. The first nine materialize
 *  components to an on-disk home; `antigravity-sdk` is MCP-only (no home).
 *  Mirrors the backend `KNOWN_PROVIDERS`. */
export type Provider =
  | "claude-code"
  | "codex"
  | "gemini"
  | "kimi"
  | "opencode"
  | "github-copilot"
  | "cursor"
  | "hermes"
  | "agy"
  | "antigravity-sdk";
export type ScopeType = "user" | "project" | "agent";

export interface Author { name: string; url?: string; }

export interface SecretRequirement {
  key: string;
  label: string;
  url?: string;
}

/** Per-provider component counts. `commands` only applies to agents with
 *  a /command surface (Claude / Gemini / OpenCode); Codex materializes the
 *  same markdown into `~/.codex/prompts/`. Providers without a command
 *  surface simply carry `commands: 0`. */
export interface ProviderDeclares {
  skills: number;
  commands: number;
  hooks: number;
}

export interface Declares {
  mcp_servers: number;
  templates: number;
  workflows: number;
  /** Fleetify-native prompt count — sources at `<plugin>/.fleetify/prompts/*.md`,
   *  materializes to `~/.fleetify/prompts/` (user scope) or
   *  `<project>/.fleetify/prompts/` (project scope). */
  prompts: number;
  /** Per-provider counts keyed by provider id (`claude`, `kimi`,
   *  `github-copilot`, …). A map (not a fixed struct) so new providers are
   *  additive. Mirrors the backend `BTreeMap<String, ProviderDeclares>`. */
  providers: Record<string, ProviderDeclares>;
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
  "mcp", "skills", "prompts", "hooks", "subagents", "workflows",
] as const;

/** Bilingual labels for the filter chips. The backend ships English
 *  values; we render whichever language the user expects. Spec
 *  ``docs/provides.md`` is the source of these strings. */
export const PROVIDES_LABEL_TR: Record<Provides, string> = {
  mcp: "MCP Sunucusu",
  skills: "Skill",
  prompts: "Prompt",
  hooks: "Hook",
  subagents: "Alt Ajan",
  workflows: "Workflow",
};
export const PROVIDES_LABEL_EN: Record<Provides, string> = {
  mcp: "MCP Server",
  skills: "Skills",
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
  const pv = Object.values(d.providers ?? {});
  if (d.mcp_servers > 0) out.push("mcp");
  if (pv.some((p) => p.skills > 0)) out.push("skills");
  if (d.prompts > 0) out.push("prompts");
  if (pv.some((p) => p.hooks > 0)) out.push("hooks");
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
  const perProvider = Object.values(d.providers ?? {}).reduce(
    (sum, p) => sum + p.skills + p.hooks,
    0,
  );
  return d.mcp_servers + d.templates + d.workflows + d.prompts + perProvider;
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
  /** Marketplace source this was installed from. May be null at runtime
   *  for installs made before provenance tracking — the Installed tab then
   *  renders a local-only detail (see PluginDetailPage's fallback). */
  source_id: string;
  /** Subpath within the source repo (e.g. "neon"). Null for a
   *  single-plugin/root-manifest repo, or pre-provenance installs. */
  plugin_path?: string | null;
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
