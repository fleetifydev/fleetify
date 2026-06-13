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

/** CLI agents whose lineup the backend serves from the remote model catalog
 *  (fleetify.dev/api) - cheap to fetch eagerly at mount. */
export const REMOTE_CATALOG_AGENTS = ["claude-code", "codex-cli", "gemini-cli", "kimi-code", "antigravity-cli"] as const;

/** CLI agents whose lineup comes from a live local CLI/ACP probe - fetched
 *  lazily (picker open) to avoid spawning processes at app mount. Their
 *  running sessions also push `available_models_update`, which heals the
 *  per-session list independently of this store. */
export const LIVE_PROBE_AGENTS = ["opencode", "cursor-cli", "github-copilot", "hermes-agent"] as const;

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
}

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
    },

    async discoverLive(tiles, projectPath = "") {
      await Promise.all([
        ...REMOTE_CATALOG_AGENTS.map((id) => storeAgent(id, projectPath, tiles)),
        ...LIVE_PROBE_AGENTS.map((id) => storeAgent(id, projectPath, tiles)),
        ...connectedApiIds(tiles).map((pid) => storeProvider(pid, tiles)),
      ]);
    },
  };
});
