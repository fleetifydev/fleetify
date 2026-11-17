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
import { useState } from "react";
import { Folder, X } from "lucide-react";
import { CardShell, Row, Toggle } from "./_primitives";
import { useConfigCard } from "./_config";

interface FleetCfgShim {
  defaultFolder?: string;
  launchOnStartup?: boolean;
  restoreLastSession?: boolean;
}

type ElectronShim = {
  openFolderDialog?: () => Promise<string | null>;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

const LAUNCH_ON_STARTUP = "Launch on system startup";
const RESTORE_LAST_SESSION = "Restore last session";

export function StartupCard() {
  // A failed save puts the control back and shows why under its row.
  const { cfg, loaded, patch, errorFor } = useConfigCard<FleetCfgShim>();
  const [folderHover, setFolderHover] = useState(false);

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
      <Row title={LAUNCH_ON_STARTUP}
           desc="Open Fleetify when you sign in."
           error={errorFor("launchOnStartup")}>
        <Toggle on={launchOnStartup} label={LAUNCH_ON_STARTUP}
                onChange={() => void patch({ launchOnStartup: !launchOnStartup })} />
      </Row>
      <Row title={RESTORE_LAST_SESSION}
           desc="Reopen the agent and workspace you were on."
           error={errorFor("restoreLastSession")}>
        <Toggle on={restoreLastSession} label={RESTORE_LAST_SESSION}
                onChange={() => void patch({ restoreLastSession: !restoreLastSession })} />
      </Row>
      <Row title="Default workspace folder"
           desc="New agents start here unless overridden."
           error={errorFor("defaultFolder")}
           last>
        <div
          onMouseEnter={() => setFolderHover(true)}
          onMouseLeave={() => setFolderHover(false)}
          style={{
            display: "inline-flex", alignItems: "stretch",
            borderRadius: 6, border: "1px solid var(--c-brd)",
            background: "var(--c-srf)", maxWidth: 260,
            overflow: "hidden",
          }}
        >
          <button
            onClick={pickFolder}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "6px 10px",
              background: "transparent", border: "none",
              color: "var(--c-high)", fontSize: 12, fontFamily: "inherit",
              cursor: "pointer",
              minWidth: 0, flex: 1,
            }}
          >
            <Folder size={11} />
            <span style={{
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {defaultFolder || "Choose folder…"}
            </span>
          </button>
          {defaultFolder && folderHover && (
            <button
              aria-label="Clear default folder"
              title="Clear default folder"
              onClick={() => void patch({ defaultFolder: "" })}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                padding: "0 7px", background: "transparent", border: "none",
                borderLeft: "1px solid var(--c-brd)",
                color: "var(--c-dim)", cursor: "pointer", fontFamily: "inherit",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-dim)"; }}
            >
              <X size={10} />
            </button>
          )}
        </div>
      </Row>
    </CardShell>
  );
}
