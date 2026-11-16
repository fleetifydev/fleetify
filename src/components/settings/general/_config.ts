/**
 * Read-merge-write for the General settings cards.
 *
 * `config_set` replaces the whole `fleet.config.json`, so a card has to merge
 * its change into the config as it is when it saves — not into the copy it
 * read when it mounted. Merging into the mount-time copy silently undid
 * whatever another card had saved since (turning attribution off, then
 * toggling crash reports, turned attribution back on).
 */
type ConfigShim = {
  getConfig?: () => Promise<object | null>;
  setConfig?: (cfg: object) => Promise<unknown>;
};

export async function saveConfigPatch(patch: object): Promise<void> {
  const api = (window as unknown as { electronAPI?: ConfigShim }).electronAPI;
  const latest = (await api?.getConfig?.()) ?? {};
  await api?.setConfig?.({ ...latest, ...patch });
}
