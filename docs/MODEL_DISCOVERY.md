# Model Discovery & the Model Picker

How the model list a user sees is sourced — from the static catalog, from a live
CLI-agent probe, or from a provider's `/models` endpoint — and how those feed the
unified picker.

> Related: [`PROVIDER_ARCHITECTURE.md`](PROVIDER_ARCHITECTURE.md),
> [`AGENT_BRIDGES.md`](AGENT_BRIDGES.md).

---

## 1. Three sources, one precedence

For any provider tile, `buildPickerGroups` (`src/lib/picker-groups.ts`) resolves
the model list with this precedence:

```
dynamicModels[id]  (runtime-discovered)   ▶  highest
   else  catalog default_models           ▶  curated, static
      else  CLI_MODELS[id]  fallback       ▶  hardcoded, last resort
```

- **`default_models`** — curated `ModelSpec`s in the catalog (most HTTP providers,
  GitHub Copilot, Antigravity SDK).
- **`CLI_MODELS`** — a hardcoded fallback in `picker-groups.ts` for CLI agents
  whose models are baked into the binary (Claude/Codex/Gemini/Kimi) and as a
  cold-start placeholder for live-model agents (e.g. Hermes' `"Hermes (configured
  model)"`).
- **`dynamicModels`** — discovered at runtime; **overrides** the others when
  present. Two backend sources feed it (below).

---

## 2. Backend discovery endpoints (`routers/providers.rs`)

### `GET /agents/{id}/models?cwd=…` — live-model CLI agents

For agents whose real catalog lives in the binary, not the registry. Returns
`{ id, models:[{id,label}] }`; an **empty list** is the documented "discovery
unavailable" signal (agent not installed / not logged in) → the renderer keeps
its static fallback. TTL-cached (120 s); `?refresh=1` bypasses.

`discover_agent_models` per id:

| id | How |
|---|---|
| `opencode` | runs `opencode models` (one id per line) |
| `cursor` | a short ACP `session/new` probe (`bridges::cursor::list_models`) |
| `github-copilot` | `bridges::github_copilot::list_models` |
| `hermes` | `bridges::hermes::list_provider_models` (every authenticated provider, ids `provider:model`) → falls back to a `session/new` probe (current provider only) |

Hermes is special: it fans **one agent across multiple authenticated providers**.
`list_provider_models` shells to the Hermes venv Python
(`hermes_cli.inventory.build_models_payload`) and returns one entry per
`(provider, model)` with the id encoded `provider:model` (e.g.
`copilot:claude-opus-4.8`). Only authenticated providers are returned.

### `GET /providers/{id}/models` — HTTP providers with a live catalog

For OpenRouter (`/api/v1/models`, hundreds of models) and Cloudflare Workers AI.
Returns `{ id, models:[{id,label,ctx?}] }`; longer TTL. Empty → curated fallback.

---

## 3. Live models from a running session (WS)

When an ACP agent cold-starts, its `session/new` result includes the offered
models. The bridge emits a `BridgeEvent::AvailableModels { models, current }`,
which becomes the WS `available_models_update` message. The renderer stores it in
`chat-store.dynamicModels[sessionId]`. This is the **freshest** list for the
*running* session's provider.

---

## 4. The dual feed: toolbar (HTTP) + composer (WS)

The picker is fed from **both** paths, which must be reconciled:

1. **Lazy HTTP discovery** — when the picker opens, `session-toolbar.tsx` and
   `chat-input.tsx` fetch `/agents/{id}/models` for each live-model agent
   (`opencode`, `cursor`, `github-copilot`, `hermes`) and
   `/providers/{id}/models` for connected HTTP providers, into local
   `discoveredModels`.
2. **Startup pre-warm** — the backend warms the Hermes model cache at boot
   (`prewarm_hermes_models`, called from `lib.rs`'s startup task) so the first
   picker open is instant instead of flashing the placeholder.
3. **Running-session WS list** — `chat-store.dynamicModels[sessionId]`.

These are **unioned** (not replaced) into the `dynamicModels` map passed to
`buildPickerGroups`: the discovered catalog (which for Hermes spans *all*
providers) is kept, and any live session models not already present are appended.
(Replacing collapsed Hermes' multi-provider list to just the active provider on a
running session — see the `feat/hermes` fixes.)

---

## 5. The unified picker

`src/components/chat/unified-model-picker.tsx` renders three columns —
**Providers | Models | Effort** — from `buildPickerGroups`'s output:

- **Auto** is always the first rail (a routing sentinel; see [`ROUTING.md`](ROUTING.md)).
- **CLI agents** use `display_name` verbatim; **HTTP providers** use short brand
  labels. Large catalogs (OpenRouter) get a search box.
- **Effort** is enabled only when the active model's `supports_effort` is true.

### Hermes' provider sub-selector

A `PickerGroup` may carry an optional `providers: [{id,label}]`. For Hermes,
`buildPickerGroups` extracts the distinct providers from the `provider:model` id
prefixes (only when there's more than one) with friendly labels. The picker then
renders a **provider dropdown** above the model list and filters models to the
selected provider, defaulting to the active model's provider. Picking
`copilot:gpt-5.5` round-trips through `session/set_model`, which Hermes resolves
back into a provider+model switch.

---

## 6. Applying a pick

`onPickModel(groupId, modelId)`:

- **Active session** → patches `session.model_name` (+ `tool` on a cross-provider
  switch) and, for live ACP agents, calls `wsManager.switchModel` to switch the
  running session in place.
- **Composer / Fleet hub (no session yet)** → writes the pick into the composer
  field (`setComposerField`), which the picker reads back when there's no
  effective session, and which seeds the session on creation.

The chip face (provider logo + label) and the dispatch `tool` are reconciled by
`resolveModelChip` / `resolveDispatchTool` so the toolbar and composer never
disagree.

---

## Key files

| Concern | File |
|---|---|
| Picker group builder + precedence + Hermes providers | `src/lib/picker-groups.ts` |
| The 3-column picker + provider dropdown | `src/components/chat/unified-model-picker.tsx` |
| Discovery endpoints + pre-warm | `crates/fleetify-backend/src/routers/providers.rs`, `crates/fleetify-backend/src/lib.rs` |
| Hermes multi-provider inventory | `crates/fleetify-backend/src/bridges/hermes.rs` |
| WS `available_models_update` | `crates/fleetify-backend/src/bridges/mod.rs`, `src/services/ws-manager.ts` |
| Toolbar / composer discovery + merge | `src/components/chat/session-toolbar.tsx`, `src/components/chat/chat-input.tsx` |
