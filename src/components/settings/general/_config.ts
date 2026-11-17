/**
 * Read-merge-write for the General settings cards.
 *
 * `config_set` replaces the whole `fleet.config.json`, so a card has to merge
 * its change into the config as it is when it saves — not into the copy it
 * read when it mounted. Merging into the mount-time copy silently undid
 * whatever another card had saved since (turning attribution off, then
 * toggling crash reports, turned attribution back on).
 *
 * Saves also run one at a time. Two that overlapped used to read the same
 * config, and the second write then dropped the first one's change.
 *
 * `config_set` doesn't throw when it can't write the file: it answers
 * `{ ok: false, error }`. `saveConfigPatch` turns that answer into a
 * rejection, so a card can't show a change the file doesn't have.
 */
import { useEffect, useRef, useState } from "react";

type ConfigShim = {
  getConfig?: () => Promise<object | null>;
  setConfig?: (cfg: object) => Promise<unknown>;
};

function configApi(): ConfigShim | undefined {
  return (window as unknown as { electronAPI?: ConfigShim }).electronAPI;
}

/** Shown when a save fails without a message of its own. */
export const CONFIG_SAVE_FAILED = "Couldn't save this setting.";

/** True for config_set's answer to a save that failed. */
function failedSave(result: unknown): result is { ok: false; error?: unknown } {
  return typeof result === "object" && result !== null
    && (result as { ok?: unknown }).ok === false;
}

/** Settles when the last queued save has finished, whether it worked or not. */
let lastSave: Promise<void> = Promise.resolve();

/**
 * Merges `patch` into fleet.config.json. Rejects with an `Error` whose
 * message can be shown as is when the change wasn't saved: config_set said
 * so, the bridge threw, or there is no bridge.
 */
export async function saveConfigPatch(patch: object): Promise<void> {
  const save = lastSave.then(async () => {
    const api = configApi();
    // Without the read, the write would replace the whole file with `patch`.
    if (!api?.getConfig || !api.setConfig) throw new Error(CONFIG_SAVE_FAILED);
    let result: unknown;
    try {
      // Read just before writing, so the merge sees every earlier save.
      const latest = (await api.getConfig()) ?? {};
      result = await api.setConfig({ ...latest, ...patch });
    } catch (e) {
      // Tauri rejects with a bare string; keep only a real Error's message.
      throw e instanceof Error && e.message ? e : new Error(CONFIG_SAVE_FAILED);
    }
    if (failedSave(result)) {
      const { error } = result;
      throw new Error(typeof error === "string" && error ? error : CONFIG_SAVE_FAILED);
    }
  });
  // A failed save must not block the ones queued after it; its own caller
  // still gets the error through `save`.
  lastSave = save.catch(() => {});
  return save;
}

/**
 * State for a General card whose settings live in fleet.config.json.
 *
 * `patch` shows a change at once and saves it. If the save fails, the
 * changed settings go back to the values the file still holds, and
 * `errorFor(key)` returns the message for that setting's row until a later
 * save of it works. Outcomes arrive in the order the saves were queued, so
 * after quick repeated changes the card ends on what the file says.
 */
export function useConfigCard<T extends object>() {
  const [cfg, setCfg] = useState<Partial<T>>({});
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  // What the file holds, as far as this card knows: the config it read at
  // mount plus every save that has worked since.
  const saved = useRef<Partial<T>>({});

  useEffect(() => {
    let mounted = true;
    configApi()?.getConfig?.()
      .then(c => {
        if (!mounted) return;
        saved.current = (c ?? {}) as Partial<T>;
        setCfg(saved.current);
        setLoaded(true);
      })
      .catch(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, []);

  const patch = async (next: Partial<T>) => {
    const keys = Object.keys(next) as (keyof T)[];
    setCfg(prev => ({ ...prev, ...next }));
    try {
      await saveConfigPatch(next);
      saved.current = { ...saved.current, ...next };
      setCfg(prev => ({ ...prev, ...next }));
      setErrors(prev => {
        const left = { ...prev };
        for (const key of keys) delete left[key];
        return left;
      });
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : CONFIG_SAVE_FAILED;
      const revert: Partial<T> = {};
      for (const key of keys) revert[key] = saved.current[key];
      setCfg(prev => ({ ...prev, ...revert }));
      setErrors(prev => {
        const shown = { ...prev };
        for (const key of keys) shown[key] = message;
        return shown;
      });
    }
  };

  const errorFor = (key: keyof T): string | null => errors[key] ?? null;

  return { cfg, loaded, patch, errorFor };
}
