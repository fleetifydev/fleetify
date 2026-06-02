/**
 * Pure helpers for turning an onboarding provider selection into the
 * persisted enabled state. Kept out of the component so it can be unit
 * tested without the typewriter/verify timer plumbing.
 */

/** Build the payload for `providers.setConnectedBulk`.
 *  - `connected`: every known provider id → whether it was selected
 *    (selected true, everything else explicitly false so non-selected
 *    providers — including CLI agents normally ON by default — are forced
 *    OFF in Settings).
 *  - `enabledAgents`: the selected CLI-agent ids only (drives Settings →
 *    Agents' "Active" shortlist + the New Agent dialog). CLI membership is
 *    decided by the backend catalog, passed in as `cliAgentIds`. */
export function buildSelectionPersist(
  allProviderIds: string[],
  selectedIds: string[],
  cliAgentIds: string[],
): { connected: Record<string, boolean>; enabledAgents: string[] } {
  const selected = new Set(selectedIds);
  const connected: Record<string, boolean> = {};
  for (const id of allProviderIds) connected[id] = selected.has(id);
  const enabledAgents = cliAgentIds.filter((id) => selected.has(id));
  return { connected, enabledAgents };
}
