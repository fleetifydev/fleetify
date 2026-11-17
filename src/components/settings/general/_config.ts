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
 */
type ConfigShim = {
  getConfig?: () => Promise<object | null>;
  setConfig?: (cfg: object) => Promise<unknown>;
};

/** Settles when the last queued save has finished, whether it worked or not. */
let lastSave: Promise<void> = Promise.resolve();

export async function saveConfigPatch(patch: object): Promise<void> {
  const save = lastSave.then(async () => {
    const api = (window as unknown as { electronAPI?: ConfigShim }).electronAPI;
    // Read just before writing, so the merge sees every earlier save.
    const latest = (await api?.getConfig?.()) ?? {};
    await api?.setConfig?.({ ...latest, ...patch });
  });
  // A failed save must not block the ones queued after it; its own caller
  // still gets the error through `save`.
  lastSave = save.catch(() => {});
  return save;
}
