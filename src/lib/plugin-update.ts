import type { CatalogPlugin, PluginInstall } from "@/types/plugin";
import { semverGt, isMajorBump } from "./semver";

export interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  newVersion: string;
  isMajor: boolean;
  addsSecret: boolean;
  newSecretKeys: string[];
}

/** Compute whether `install` has an update in `catalog` (semver), and
 *  whether it's "safe" to auto-apply (not major, no newly-required secret).
 *
 *  The installed version's required-secret keys come from the install's
 *  *own* manifest (`install.manifest.requires_secrets`), so `addsSecret`
 *  means "the catalog version requires a secret KEY this install did not" —
 *  the case a silent auto-update must not introduce, since it would leave an
 *  unresolved `${secret:KEY}` reference behind. */
export function computeUpdateInfo(install: PluginInstall, catalog: CatalogPlugin): UpdateInfo {
  const currentVersion = install.version;
  const newVersion = catalog.manifest.version;
  const updateAvailable = semverGt(newVersion, currentVersion);
  const have = new Set((install.manifest.requires_secrets ?? []).map(s => s.key));
  const newSecretKeys = (catalog.manifest.requires_secrets ?? [])
    .map(s => s.key)
    .filter(k => !have.has(k));
  return {
    updateAvailable,
    currentVersion,
    newVersion,
    isMajor: updateAvailable && isMajorBump(currentVersion, newVersion),
    addsSecret: updateAvailable && newSecretKeys.length > 0,
    newSecretKeys,
  };
}

/** Safe = auto-appliable silently: an available, non-major update that adds
 *  no new required secret. */
export function isSafeUpdate(u: UpdateInfo): boolean {
  return u.updateAvailable && !u.isMajor && !u.addsSecret;
}
