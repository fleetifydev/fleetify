/**
 * Startup card — Settings → General.
 *
 * Three rows:
 *   - Launch on system startup (persists intent; native autostart plugin
 *     is a follow-up).
 *   - Restore last session.
 *   - Default workspace folder (uses the existing `defaultFolder` field
 *     on FleetConfig; folder picker opens via Tauri dialog plugin).
 *
 * Reads/writes via `window.electronAPI.getConfig` / `setConfig`. All
 * fields are optional on FleetConfig; defaults applied here mirror the
 * documented intent in `vite-env.d.ts`.
 */
import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import { CardShell, Row, Toggle } from "./_primitives";

interface FleetCfgShim {
  defaultFolder?: string;
  launchOnStartup?: boolean;
  restoreLastSession?: boolean;
}

type ElectronShim = {
  getConfig?: () => Promise<FleetCfgShim | null>;
  setConfig?: (cfg: FleetCfgShim) => Promise<unknown>;
  openFolderDialog?: () => Promise<string | null>;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

export function StartupCard() {
  const [cfg, setCfg] = useState<FleetCfgShim>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    electron().getConfig?.()
      .then(c => { if (mounted) { setCfg(c ?? {}); setLoaded(true); } })
      .catch(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, []);

  const patch = async (next: Partial<FleetCfgShim>) => {
    const merged = { ...cfg, ...next };
    setCfg(merged);
    try { await electron().setConfig?.(merged); } catch { /* best effort */ }
  };

  const launchOnStartup = cfg.launchOnStartup ?? false;
  const restoreLastSession = cfg.restoreLastSession ?? true;
  const defaultFolder = cfg.defaultFolder ?? "";

  const pickFolder = async () => {
    const picked = await electron().openFolderDialog?.();
    if (picked) await patch({ defaultFolder: picked });
  };

  if (!loaded) {
    return (
      <CardShell>
        <div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div>
      </CardShell>
    );
  }

  return (
    <CardShell>
      <Row title="Launch on system startup"
           desc="Open Fleetify when you sign in.">
        <Toggle on={launchOnStartup} onChange={() => void patch({ launchOnStartup: !launchOnStartup })} />
      </Row>
      <Row title="Restore last session"
           desc="Reopen the agent and workspace you were on.">
        <Toggle on={restoreLastSession} onChange={() => void patch({ restoreLastSession: !restoreLastSession })} />
      </Row>
      <Row title="Default workspace folder"
           desc="New agents start here unless overridden."
           last>
        <button
          onClick={pickFolder}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 10px", borderRadius: 6,
            background: "var(--c-srf)", border: "1px solid var(--c-brd)",
            color: "var(--c-high)", fontSize: 12, fontFamily: "inherit",
            cursor: "pointer", maxWidth: 260,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          <Folder size={11} />
          {defaultFolder || "Choose folder…"}
        </button>
      </Row>
    </CardShell>
  );
}
