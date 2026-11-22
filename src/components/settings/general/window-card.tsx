/**
 * Window card — Settings → General, on Windows and macOS.
 *
 * One row: keep Fleetify running when you close the window
 * (`keepRunningOnClose`, on by default). Closing the window then hides it,
 * and agent sessions keep working. On Windows Fleetify stays in the
 * notification area, where its icon opens the window again and its menu
 * quits; on macOS it stays in the Dock, and ⌘Q quits. Switched off, closing
 * the window quits. The shell reads the setting each time the window is
 * closed (src-tauri/src/shell/lifecycle.rs) and, like it, counts it as on
 * unless it is saved as `false`. Linux has no such row: closing the window
 * quits there, since not every desktop shows a tray icon to come back to.
 */
import { CardShell, Row, Toggle } from "./_primitives";
import { useConfigCard } from "./_config";
import { getPlatform, type Platform } from "@/lib/utils";

interface WindowCfg {
  keepRunningOnClose?: boolean;
}

const KEEP_RUNNING = "Keep Fleetify running when you close the window";

/** Where Fleetify stays on `platform` once its window is closed, as the
 *  row's description; null where closing the window always quits. */
export function keepRunningDescription(platform: Platform): string | null {
  switch (platform) {
    case "windows":
      return "Fleetify stays in the notification area, and your agents keep working. Quit from its icon there.";
    case "mac":
      return "Fleetify stays in the Dock, and your agents keep working. Quit with ⌘Q.";
    default:
      return null;
  }
}

export function WindowCard() {
  // A failed save puts the switch back and shows why: the switch must not
  // say off while the file still says on, since the shell reads the file.
  const { cfg, loaded, patch, errorFor } = useConfigCard<WindowCfg>();
  const desc = keepRunningDescription(getPlatform());

  if (desc === null) return null;

  if (!loaded) {
    return <CardShell><div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div></CardShell>;
  }

  // Same rule as the shell's `keep_running_from`: only an explicit `false`
  // turns it off.
  const keepRunning = cfg.keepRunningOnClose !== false;

  return (
    <CardShell>
      <Row title={KEEP_RUNNING} desc={desc} error={errorFor("keepRunningOnClose")} last>
        <Toggle on={keepRunning} label={KEEP_RUNNING}
                onChange={() => void patch({ keepRunningOnClose: !keepRunning })} />
      </Row>
    </CardShell>
  );
}
