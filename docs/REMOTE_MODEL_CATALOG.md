# Remote Model Catalog — design & phase-1 spec

Migrate the Fleetify app's **binary-embedded** model lists (the static
`catalog.rs` `default_models` and the frontend `picker-groups.ts` `CLI_MODELS`)
into the external, CDN-served catalog at [`fleetifydev/models`](https://github.com/fleetifydev/models)
(local: `C:\Users\loseu\Desktop\fleetify-models`), which the app will fetch at
runtime via `fleetify.dev/api`. New models then ship **without an app release**.

> Companion specs (in `~/Downloads`): `fleetify-api-models-endpoints-implementation.md`
> (the serving layer), `fleetify-updater-*` (unrelated updater control plane).
> App-side resolution chain is documented in `docs/MODEL_DISCOVERY.md`.

## Phasing

1. **Phase 1 (this task): populate the catalog.** Author all current,
   doc-verified models for every binary-embedded provider + CLI agent in
   `fleetifydev/models`, build `dist/`, open a PR. **Branch:**
   `feat/all-current-models`. No app code changes.
2. **Phase 2 (this branch): app consumption.** Backend `fetch_remote_catalog`
   (fleetify.dev/api → jsDelivr origin → empty) wired into **both** discovery
   endpoints as the key-less baseline layer, so binary-embedded providers/agents
   (openai/anthropic/claude/codex/…) source their lineup from the published
   catalog instead of the baked `CATALOG`; `CLI_MODELS` becomes a last-ditch
   fallback. Config `FLEETIFY_MODELS_API` / `FLEETIFY_MODELS_TAG`. See
   `fleetify-api-models-endpoints-implementation.md` §7–8.

### Phase 2 — what landed

- **`crates/fleetify-backend/src/routers/providers.rs`**
  - `fetch_remote_catalog(id)` — TTL-cached (10 min; 60 s negative cache),
    3 s timeout, tries `{FLEETIFY_MODELS_API}/providers/{id}/models` then the
    jsDelivr per-provider file (`@{FLEETIFY_MODELS_TAG}`), parses **both** the
    serving-API (`{models:[…]}`) and jsDelivr (`{provider:{models:[…]}}`) shapes.
  - `discover_provider_models` and `list_agent_models` fall through to it when
    their live source is empty. `ProviderModel` + the wire shape gained optional
    `supports_effort` / `group` / `note` / `endpoint` (additive; live sources
    omit them, the renderer defaults).
- **`src/lib/api.ts`** — `DiscoveredModel` carries the richer fields;
  `fetchAgentModels` / `fetchProviderModels` return it.
- **`session-toolbar.tsx` / `chat-input.tsx`** — discover every CLI agent
  (incl. the baked claude/codex/kimi/agy) and every connected HTTP
  provider, mapping `supports_effort` through instead of hard-coding `false`.

**Resolution chain (per `docs/MODEL_DISCOVERY.md`):** live agent/HTTP discovery
→ **remote catalog (this layer)** → baked `CATALOG`. Each layer is additive;
an unreachable catalog degrades to the baked fallback, so the picker is never
empty. End-to-end data flows once PR #1 (the catalog) is merged so jsDelivr
`@main` serves it (or the serving API is deployed).

---

## Phase 1 — provider inventory

The catalog uses a per-provider folder (`providers/<folder>/`) with
`provider.toml` + `models/<id>.toml`. The dist provider `id` is
`[fleetify].catalog_id ?? <folder>`; **`catalog_id` is the join key to the app's
provider-tile id**. Folder names stay canonical; `catalog_id` is aligned to the
app tile.

| Folder | `catalog_id` (= app tile) | kind | Action | Primary source |
|---|---|---|---|---|
| `openai` | `openai` | api | expand | platform.openai.com/docs/models |
| `anthropic` | `anthropic` | api | expand | docs.anthropic.com/en/docs/about-claude/models |
| `deepseek` | `deepseek` | api | **fix** (stale `chat`/`reasoner` → `v4`) | api-docs.deepseek.com |
| `google` | **`gemini-api`** (was `google`) | api | id-fix + expand | ai.google.dev/gemini-api/docs/models |
| `xai` | **`grok`** (was `xai`) | api | id-fix + expand | docs.x.ai/docs/models |
| `nvidia-nim` | `nvidia-nim` | api | expand | build.nvidia.com |
| `perplexity` | `perplexity` | api | expand (Sonar + Agent groups) | docs.perplexity.ai |
| `openrouter` | `openrouter` | api | curated fallback subset | openrouter.ai/models |
| `kimi-api` | `kimi-api` | api | **new** | platform.moonshot.ai / platform.kimi.ai |
| `cloudflare-workers-ai` | `cloudflare-workers-ai` | api | **new** | developers.cloudflare.com/workers-ai/models |
| `claude` | `claude` | cli | **new** (`extends` anthropic) | catalog.rs + Claude Code |
| `codex` | `codex` | cli | **new** (standalone) | **developers.openai.com/codex/models** |
| `kimi` | `kimi` | cli | **new** (`extends` kimi-api) | Kimi CLI |
| `agy` | `agy` | cli | **new** (single "Auto" passthrough) | app behaviour (print mode) |
| `github-copilot` | `github-copilot` | cli | **new** (standalone) | docs.github.com/copilot |
| `antigravity-sdk` | `antigravity-sdk` | cli | **new** (standalone) | Antigravity SDK |

**Excluded:** `opencode` / `cursor` / `hermes` — models come from live ACP
discovery, not a baked set, so they need no catalog entry. `mistral` — present in
the repo but not an app tile; **left untouched**.

## catalog_id alignment

Only two existing providers drift from the app's tile ids; fix both via
`provider.toml`:

```toml
# providers/xai/provider.toml      → catalog_id = "grok"
# providers/google/provider.toml   → catalog_id = "gemini-api"
```

All new CLI/agent folders are named to match their tile id, so their
`catalog_id` is implicit (folder == tile). The pipeline already rejects
duplicate `catalog_id`s.

## CLI agents — `[extends]` mirror strategy

`extends` deep-merges the parent then lets local fields win, then drops `omit`
(verified in `scripts/lib/extends.ts`). The `from` key references the **folder**
(`anthropic/claude-opus-4-8`), not the catalog_id.

- **Mirror where the model is the same vendor model** — override only the
  CLI-specific id (filename) + `[fleetify].label`; inherit cost/limit/modalities:
  - `claude/*` → `extends` `anthropic/*` (e.g. CLI `claude-haiku-4-5-20251001`
    extends `anthropic/claude-haiku-4-5`).
  - `kimi/*` → `extends` `kimi-api/*`.
- **Standalone where the agent exposes vendor-specific variants:** `codex`
  (`gpt-5.x-codex`), `github-copilot`, `antigravity-sdk` (effort-suffixed
  gemini/claude/gpt-oss), and any CLI-only variant absent from the API set
  (e.g. `kimi-k2.6-thinking`).
- `agy`: a single `agy-default` model labelled "Auto" (print mode pins the model
  server-side; mirrors the app's one-entry picker).

## Schema mapping & metadata fidelity

Match the existing rich TOMLs. Fill from docs; **omit unknown fields** (TOML has
no null — the build defaults them). Per `scripts/lib/defaults.ts`:

- Top level: `name`, `family`, `release_date`, `last_updated`, `knowledge`,
  `attachment`, `reasoning`, `tool_call`, `structured_output`, `temperature`,
  `open_weights`.
- `[cost]` `input` / `output` / `cache_read` / `cache_write` (USD per 1M tokens).
- `[limit]` `context` / `output`.
- `[modalities]` `input` / `output` (defaults `["text"]`).
- `[fleetify]` `label`, `supports_effort` (defaults to `reasoning`), `group`,
  `note`, `endpoint`, `hidden`, `aliases`.

Provider-specific notes:
- **Perplexity** keeps two `[fleetify].group`s — `"Sonar API"` (default base URL)
  and `"Agent API"` (each model carries `endpoint = "/v1/agent"`), mirroring
  `catalog.rs`.
- **NVIDIA NIM / Cloudflare** use provider-prefixed ids (`vendor/model`,
  `@cf/vendor/model`) → nested model folders.
- Reasoning models set `reasoning = true` (⇒ `supports_effort` true unless
  overridden); pure-chat models set `temperature = true`.

## Verification — triangulated, doc-grounded

Per the request, every model is checked against the provider's own docs. Three
sources, reconciled (official docs win on ids/pricing; record provenance):

1. **App `catalog.rs`** — already doc-verified (2026-05-25 → 06-01, guarded by
   `no_stale_model_ids`). The baseline id set, already app-aligned.
2. **Provider official docs** (live `WebFetch`) — latest ids, context windows,
   pricing, modalities, dates. URLs in the table above + each `provider.toml`'s
   `doc`.
3. **models.dev** — the project's established grounding source (commit
   `cd683f5`) for structured cost/limit/modality/date metadata.

Provenance: set `last_updated` to the verification date and keep each
`provider.toml` `doc` URL current. If a provider doc is unreachable, fall back to
the `catalog.rs` snapshot and flag it in the PR description (no silent gaps).

## Build / validate / commit

```bash
# in C:\Users\loseu\Desktop\fleetify-models (branch feat/all-current-models)
bun install
bun run validate          # JSON-Schema check of every TOML
bun test                  # unit + e2e (pipeline, extends, defaults, emit)
bun run build             # regenerate dist/models.json + index.json + providers/*.json
git add providers dist
git commit -m "data: …"   # one logical commit per provider (repo convention)
```

Commit `dist/` alongside the TOML (it is consumed directly over jsDelivr). Open a
PR on `feat/all-current-models`.

## Testing & validation gates

- `bun run validate` passes (schema-clean) — **blocking**.
- `bun test` green (pipeline/extends/defaults/emit) — **blocking**.
- `bun run build` succeeds; `dist/models.json` includes every expected
  `catalog_id` with non-empty `models[]`; no duplicate `catalog_id`.
- Spot-check: each `extends` mirror resolves (no "unknown model" / cycle errors);
  Perplexity Agent models carry the `/v1/agent` endpoint; id-fix providers emit
  under `grok` / `gemini-api`.

## Risks & open items

- **Doc reachability / freshness.** Some provider docs are JS-heavy or gated;
  fall back to `catalog.rs` + models.dev and flag. Knowledge cutoff predates these
  2026 models, so live verification is mandatory — never author from memory.
- **CLI ↔ API id divergence** (e.g. Cursor-style bracketed ids are *not* in scope;
  `claude` CLI haiku id is date-suffixed). Mirror files encode the exact id the
  app dispatches.
- **`agy`** has no real selectable models (print mode) — single passthrough entry
  by design.
- Phase-2 app wiring is **not** in this task; the catalog must stay a strict
  superset-compatible projection of what `catalog.rs` ships today so the app's
  lower fallback layers keep working during rollout.
