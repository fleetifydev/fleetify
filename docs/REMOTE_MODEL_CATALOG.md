# Remote model catalog

The model lineups for providers and CLI agents come from a published catalog,
[`fleetifydev/models`](https://github.com/fleetifydev/models), which the app
fetches at runtime. A new model can therefore appear in the picker without an
app release. [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md) shows where this layer
sits among the model sources.

> Related: [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md),
> [`PROVIDERS.md`](PROVIDERS.md).

---

## 1. Where a lineup comes from

When a provider or agent has no live model list of its own, or its live source
comes back empty, `fetch_remote_catalog`
(`crates/fleetify-backend/src/routers/providers.rs`) tries, in order:

1. **The serving API:** `GET {FLEETIFY_MODELS_API}/providers/{id}/models`, by
   default on `https://fleetify.dev/api`.
2. **The CDN:** the catalog's built file,
   `https://cdn.jsdelivr.net/gh/fleetifydev/models@{tag}/dist/providers/{id}.json`,
   where `{tag}` is the catalog version assigned to this install (§2), or
   `FLEETIFY_MODELS_TAG` (default `main`) until the pointer has answered.
3. **The disk cache:** the last lineup fetched successfully, kept in
   `~/.fleetify/models-cache/{id}.json` for offline and cold starts.

If all three come up empty, the picker falls back to the lists built into the
app: the catalog's `default_models` and the renderer's `CLI_MODELS`.

A fetched lineup is cached in memory for 10 minutes, and a miss for 60 seconds,
so opening a picker doesn't refetch every time. Each request times out after
3 seconds.

## 2. Staying current

The serving API also answers a small pointer, `GET {FLEETIFY_MODELS_API}/meta`,
with the current catalog's tag and commit. The app asks for it at natural
moments, such as the window gaining focus or a model picker opening, at most
every 15 seconds. When the catalog has moved, it drops its cached lineups, so a
newly published model shows up without waiting out the cache.

The pointer request carries a rollout bucket, a number from 0 to 99 derived from
the device ID, so that a new catalog version can reach a slice of installs
first. Inside such a staged rollout the app skips the serving API, which serves
the stable catalog, and reads its assigned version from the CDN. The dashboard
heartbeat reports which catalog an install runs (`catalog_commit`,
`catalog_tag`, `catalog_bucket`; see [`ANALYTICS.md`](ANALYTICS.md)).

## 3. Per-model effort

The effort levels each model supports come from a snapshot of the catalog that
is embedded at build time, `crates/fleetify-backend/assets/models-snapshot.json`
(read by `providers/catalog_snapshot.rs`), which doubles as an offline baseline.
It is regenerated from the catalog's `dist/models.json` when effort metadata
or a default model changes. Fetch it at a pinned commit, and name that commit
in the change that updates the file:

```bash
SHA=$(gh api repos/fleetifydev/models/commits/main --jq .sha)
curl -fsSL "https://cdn.jsdelivr.net/gh/fleetifydev/models@$SHA/dist/models.json" \
  -o crates/fleetify-backend/assets/models-snapshot.json
```

The snapshot supplies effort, not model lists: a first launch that reaches no
catalog takes its models from defaults built into the app. The snapshot does
record each provider's default, and `src/lib/__tests__/offline-defaults.test.ts`
holds the built-in defaults to it. For Claude Code it checks the fallback
default in `src/lib/picker-groups.ts`, the default row in
`src/components/chat/chat-input.tsx`, the New Agent dialog's `most_capable`
tier, the welcome card's labels and the `/compact` summariser in
`services/compactor.rs`. For the Anthropic API it checks the first model of its
list in `providers/catalog.rs`. A refresh that moves one of those defaults
fails `npm test` until they follow. Move the default, and keep the previous
model's labels for the sessions that still use it. The test doesn't check the
New Agent dialog's model options or its templates, so move those by hand.

## 4. Adding or changing a model

Models are defined in the `fleetifydev/models` repository, which takes changes
through its own pull requests. Each provider there has a `catalog_id`, which
must equal the app's provider id, such as `openai`, `gemini-api` or
`claude-code`, or the app won't find its lineup. Once a change is published,
running apps pick it up as §2 describes.

## 5. Configuration

| Variable | Default | Effect |
|---|---|---|
| `FLEETIFY_MODELS_API` | `https://fleetify.dev/api` | Base URL of the serving API and the pointer. |
| `FLEETIFY_MODELS_TAG` | `main` | The CDN ref to use until the pointer assigns one. |
