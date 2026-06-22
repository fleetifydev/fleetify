/** App-wide cache of DISCOVERED model catalogs, keyed by provider/agent id.
 *
 *  Why a store and not component state: the composer + session-toolbar used to
 *  hold these in picker-open-gated `useState`, so the labels lived only while
 *  that component instance survived. Any model known ONLY to the remote
 *  catalog (every newly-shipped model, e.g. `claude-fable-5` -> "Fable 5")
 *  lost its display name on remount and the model chip rendered the raw id.
 *  Hoisting the catalogs here gives every chip/picker the same long-lived
 *  label source.
 *
 *  Two entry points with deliberately different weights:
 *  - `hydrate`     - eager, once per app run: remote-catalog agents + connected
 *                    HTTP providers. Server-side these resolve from the (boot-
 *                    prewarmed, TTL-cached) remote catalog - no CLI spawns.
 *  - `discoverLive` - on picker open: everything `hydrate` covers PLUS the
 *                    live-probe agents (a local CLI/ACP probe each), exactly
 *                    the fan-out the pickers always ran on open.
 *
 *  Empty results are never stored: an absent key keeps the caller on its
 *  static fallback (CLI_MODELS / curated catalog), mirroring the documented
 *  "discovery unavailable" contract of the fetch helpers. */
import { create } from "zustand";
import { fetchAgentModels, fetchProviderModels, type DiscoveredModel } from "@/lib/api";
import { effortForDiscoveredModel, type PickerModel } from "@/lib/picker-groups";
import type { ProviderTile } from "@/lib/providers-api";
import { resolveSessionModel } from "@/lib/model-resolution";

/** CLI agents whose lineup the backend serves from the remote model catalog
 *  (fleetify.dev/api) - cheap to fetch eagerly at mount. */
export const REMOTE_CATALOG_AGENTS = ["claude-code", "codex-cli", "kimi-code", "antigravity-cli"] as const;

/** CLI agents whose lineup comes from a live local CLI/ACP probe - fetched
 *  lazily (picker open) to avoid spawning processes at app mount. Their
 *  running sessions also push `available_models_update`, which heals the
 *  per-session list independently of this store. */
export const LIVE_PROBE_AGENTS = ["opencode", "cursor-cli", "grok-build", "github-copilot", "hermes-agent"] as const;

function toPickerModels(
  providerId: string,
  models: DiscoveredModel[],
  tiles: ProviderTile[],
): PickerModel[] {
  return models.map((m) => {
    const eff = m.effort ?? effortForDiscoveredModel(providerId, m.id, tiles);
    return {
      id: m.id,
      label: m.label,
      ctx: m.ctx,
      note: m.note,
      effort: eff,
      supports_effort: eff.kind !== "none",
      default: m.default ?? false,
    };
  });
}

interface DiscoveredModelsState {
  /** providerId/agentId -> discovered PickerModels. Absent key = nothing
   *  discovered (callers keep their static fallback). */
  models: Record<string, PickerModel[]>;
  /** Single-flight latch for `hydrate` (once per app run). */
  hydrated: boolean;
  hydrate: (tiles: ProviderTile[]) => Promise<void>;
  discoverLive: (tiles: ProviderTile[], projectPath?: string) => Promise<void>;
  /** Heal stale persisted Fleet-default / Sessions-Default model ids against
   *  the freshly-discovered catalog. Durable-config side of self-healing:
   *  reads config, and for each (provider, model) pair whose model no longer
   *  exists for its provider, rewrites it to the provider's flagged default
   *  (via `resolveSessionModel`) and merge-writes config. Silent, fail-open
   *  (skips a pair whose provider has no discovered models). Called at the end
   *  of `hydrate` / `discoverLive`; never re-triggers them. */
  reconcileFleetDefault: () => Promise<void>;
}

/** (providerKey, modelKey) pairs in `FleetConfig` to reconcile. Typed against
 *  `keyof FleetConfig` so indexing below stays honest (each is `string?`). */
const RECONCILE_PAIRS: readonly [keyof FleetConfig, keyof FleetConfig][] = [
  ["defaultProvider", "defaultModel"],
  ["sessionDefaultProvider", "sessionDefaultModel"],
];

export const useDiscoveredModelsStore = create<DiscoveredModelsState>((set, get) => {
  const storeAgent = async (agentId: string, cwd: string, tiles: ProviderTile[]) => {
    const { models } = await fetchAgentModels(agentId, cwd);
    if (models.length === 0) return; // keep static fallback
    set((s) => ({ models: { ...s.models, [agentId]: toPickerModels(agentId, models, tiles) } }));
  };
  const storeProvider = async (pid: string, tiles: ProviderTile[]) => {
    const models = await fetchProviderModels(pid);
    if (models.length === 0) return; // keep curated fallback
    set((s) => ({ models: { ...s.models, [pid]: toPickerModels(pid, models, tiles) } }));
  };
  const connectedApiIds = (tiles: ProviderTile[]) =>
    tiles.filter((t) => t.spec.kind === "api" && t.connected).map((t) => t.spec.id);

  return {
    models: {},
    hydrated: false,

    async hydrate(tiles) {
      if (get().hydrated || tiles.length === 0) return;
      set({ hydrated: true });
      await Promise.all([
        ...REMOTE_CATALOG_AGENTS.map((id) => storeAgent(id, "", tiles)),
        ...connectedApiIds(tiles).map((pid) => storeProvider(pid, tiles)),
      ]);
      // Heal stale persisted defaults against the catalog we just populated.
      // `get()` so the freshly-`set` models are visible to reconcile.
      await get().reconcileFleetDefault();
    },

    async discoverLive(tiles, projectPath = "") {
      await Promise.all([
        ...REMOTE_CATALOG_AGENTS.map((id) => storeAgent(id, projectPath, tiles)),
        ...LIVE_PROBE_AGENTS.map((id) => storeAgent(id, projectPath, tiles)),
        ...connectedApiIds(tiles).map((pid) => storeProvider(pid, tiles)),
      ]);
      await get().reconcileFleetDefault();
    },

    async reconcileFleetDefault() {
      // Best-effort read; no config bridge or a throwing one ⇒ nothing to heal.
      let cfg: FleetConfig | null | undefined;
      try {
        cfg = await window.electronAPI?.getConfig?.();
      } catch {
        return;
      }
      if (!cfg) return;

      const models = get().models;
      const next: FleetConfig = { ...cfg };
      let changed = false;
      for (const [pk, mk] of RECONCILE_PAIRS) {
        const prov = cfg[pk] as string | undefined;
        const avail = prov ? models[prov] : undefined;
        // Fail-open: skip when the provider isn't pinned or has no discovered
        // models (catalog unavailable for it — don't clobber a maybe-valid id).
        if (!prov || !avail || avail.length === 0) continue;
        const persisted = cfg[mk] as string | undefined;
        const r = resolveSessionModel(persisted ?? null, avail);
        // Only the "healed" verdict means the id was genuinely stale; "ok" /
        // "unverified" leave config untouched.
        if (r.status === "healed" && r.model !== persisted) {
          (next[mk] as string) = r.model;
          changed = true;
        }
      }
      // Nothing healed ⇒ no write. This (plus reconcile never calling
      // hydrate/discoverLive nor touching `hydrated`/`models`) keeps the
      // catalog-load → reconcile path free of any reconcile↔hydrate loop:
      // a `setConfig` here does not feed back into this store.
      if (!changed) return;
      // FULL REPLACE contract: `next` is the spread of the complete config
      // getConfig returned, so the merge-write loses no other fields.
      try {
        await window.electronAPI?.setConfig?.(next);
      } catch {
        /* best-effort: a failed persist just leaves the stale id for next load */
      }
    },
  };
});
