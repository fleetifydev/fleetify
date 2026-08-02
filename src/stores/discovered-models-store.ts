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
import {
  fetchAgentModels,
  fetchProviderModels,
  revalidateCatalog,
  type DiscoveredModel,
} from "@/lib/api";
import { effortForDiscoveredModel, type PickerModel } from "@/lib/picker-groups";
import type { ProviderTile } from "@/lib/providers-api";
import { resolveSessionModel } from "@/lib/model-resolution";
import { planModelHeal, type HealTarget } from "@/lib/model-heal";

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
      active: m.active,
      priority: m.priority,
    };
  });
}

/** Push every open surface's selected model back onto something the catalog
 *  still serves. Runs ONLY after a confirmed catalog change, so the normal
 *  steady state never rewrites a user's pick.
 *
 *  Covers the three places a model is selected: every session row (which is
 *  also the Fleet screen — its model IS the staff session's), and the
 *  new-session composer. Persisted config defaults are healed separately by
 *  `reconcileFleetDefault`. Silent by design: "healed" has always been the
 *  quiet verdict (see `sendBlockMessage`), and the chip repainting to the new
 *  default is the feedback.
 *
 *  Dynamic import of app-store keeps the store graph one-directional — app-store
 *  already reaches into this module the same way. */
async function applyModelHeal(models: Record<string, PickerModel[]>): Promise<number> {
  const { useAppStore } = await import("@/stores/app-store");
  const app = useAppStore.getState();
  const targets: HealTarget[] = [
    // Archived sessions are off-screen and heal on reopen — not worth a PATCH
    // each on every catalog publish.
    ...app.sessions
      .filter((s) => !(s as { archived_at?: string | null }).archived_at)
      .map((s) => ({ kind: "session" as const, id: s.id, tool: s.tool, model: s.model_name ?? null })),
    ...(app.composer.open
      ? [{ kind: "composer" as const, tool: app.composer.tool, model: app.composer.modelName }]
      : []),
  ];
  const plan = planModelHeal(targets, models);
  if (plan.length === 0) return 0;
  const { updateSession: apiPatchSession } = await import("@/lib/api");
  for (const { target, nextModel } of plan) {
    if (target.kind === "composer") {
      app.setComposerField({ modelName: nextModel });
      continue;
    }
    if (!target.id) continue;
    // Optimistic local write + fire-and-forget persist: the UI must repaint now,
    // and a failed PATCH just leaves the id to be healed again next time.
    app.updateSession(target.id, { model_name: nextModel });
    void apiPatchSession(target.id, { model_name: nextModel }).catch(() => {});
  }
  return plan.length;
}

interface DiscoveredModelsState {
  /** providerId/agentId -> discovered PickerModels. Absent key = nothing
   *  discovered (callers keep their static fallback). */
  models: Record<string, PickerModel[]>;
  /** Single-flight latch for `hydrate` (once per app run, per catalog). */
  hydrated: boolean;
  /** Catalog identity (`catalogCommit`) the current `models` came from. Null
   *  until the first successful probe. */
  catalogCommit: string | null;
  /** Bumped once a catalog change has been fully absorbed — models
   *  re-discovered, config defaults reconciled, selected models healed.
   *  Subscribe to this (not `catalogCommit`) to re-read anything derived from
   *  the healed state: the commit is recorded at probe time, before the heal
   *  has run, so keying off it would re-read the values we are about to fix. */
  healRevision: number;
  hydrate: (tiles: ProviderTile[]) => Promise<void>;
  discoverLive: (tiles: ProviderTile[], projectPath?: string) => Promise<void>;
  /** Cheap pointer probe. Records the identity and reports whether the
   *  published catalog moved (in which case the backend has already dropped
   *  its cache, so the next fetch re-pulls). */
  probeCatalog: () => Promise<boolean>;
  /** Background freshness pass for natural triggers (window focus, app start).
   *  No-op unless the catalog actually moved; on a move it re-discovers the
   *  cheap set and heals every selected model. Returns whether it did work. */
  revalidate: (tiles: ProviderTile[]) => Promise<boolean>;
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
    catalogCommit: null,
    healRevision: 0,

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

    async probeCatalog() {
      const r = await revalidateCatalog();
      if (r.commit && r.commit !== get().catalogCommit) set({ catalogCommit: r.commit });
      return r.changed;
    },

    async discoverLive(tiles, projectPath = "") {
      // Probe FIRST: if the catalog moved, the backend drops its cache here, so
      // the fan-out below re-pulls fresh instead of serving a lineup that no
      // longer exists. Folding the probe into this path means opening the
      // picker is itself a freshness trigger, at the cost of one small request.
      const moved = await get().probeCatalog();
      await Promise.all([
        ...REMOTE_CATALOG_AGENTS.map((id) => storeAgent(id, projectPath, tiles)),
        ...LIVE_PROBE_AGENTS.map((id) => storeAgent(id, projectPath, tiles)),
        ...connectedApiIds(tiles).map((pid) => storeProvider(pid, tiles)),
      ]);
      await get().reconcileFleetDefault();
      if (moved) {
        await applyModelHeal(get().models);
        set((s) => ({ healRevision: s.healRevision + 1 }));
      }
    },

    async revalidate(tiles) {
      if (tiles.length === 0) return false;
      if (!(await get().probeCatalog())) return false;
      // Re-run the CHEAP set only (remote-catalog agents + connected HTTP
      // providers). Deliberately NOT discoverLive: those agents' lineups come
      // from local CLI probes, not the catalog, so spawning them on a
      // background focus event would be pure cost.
      set({ hydrated: false });
      await get().hydrate(tiles);
      await applyModelHeal(get().models);
      set((s) => ({ healRevision: s.healRevision + 1 }));
      return true;
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
