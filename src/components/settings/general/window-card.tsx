/**
 * Window card — Settings → General, on Windows and macOS.
 *
 * One row: keep Fleetify running when you close the window
 * (`keepRunningOnClose`, on by default). Closing the window then hides it,
 * and agent sessions keep working. On Windows Fleetify stays in the
 * notification area, where its icon opens the window again and its
 * right-click menu has Quit Fleetify; on macOS it stays in the Dock, and ⌘Q
 * quits. Switched off, closing the window quits. The shell reads the
 * setting each time the window is closed (src-tauri/src/shell/lifecycle.rs)
 * and, like it, counts it as on unless it is saved as `false`.
 *
 * On Windows the shell hides the window only while its notification-area
 * icon is there: when the icon couldn't be added, closing the window quits,
 * and the row says so instead of promising the notification area
 * (`windowCanKeepRunning`). Linux has no such row: closing the window quits
 * there, since not every desktop shows a tray icon to come back to.
 */
import { useEffect, useState } from "react";
import { CardShell, Row, Toggle } from "./_primitives";
import { useConfigCard } from "./_config";
import { getPlatform, type Platform } from "@/lib/utils";

interface WindowCfg {
  keepRunningOnClose?: boolean;
}

const KEEP_RUNNING = "Keep Fleetify running when you close the window";

/** Where Fleetify stays on `platform` once its window is closed, and how to
 *  quit it, as the row's description; null where closing the window always
 *  quits. `canKeepRunning` is false on Windows when the notification-area
 *  icon couldn't be added, and closing the window quits then. */
export function keepRunningDescription(platform: Platform, canKeepRunning = true): string | null {
  switch (platform) {
    case "windows":
      return canKeepRunning
        ? "Fleetify stays in the notification area, and your agents keep working. To quit, right-click the Fleetify icon at the right end of the taskbar (it may be under the ^ arrow) and choose Quit Fleetify."
        : "Fleetify couldn't add its notification-area icon this time, so closing the window quits it.";
    case "mac":
      return "Fleetify stays in the Dock, and your agents keep working. To quit, press ⌘Q, or right-click its Dock icon and choose Quit.";
    default:
      return null;
  }
}

/** Whether closing the window can keep Fleetify running, as the shell
 *  answers on Windows (`windowCanKeepRunning`): null until it has. Without
 *  an answer, it counts as yes, the description Fleetify always had.
 *  Elsewhere the answer doesn't change the description, so there is
 *  nothing to ask. */
function useCanKeepRunning(platform: Platform): boolean | null {
  const [canKeepRunning, setCanKeepRunning] = useState<boolean | null>(
    platform === "windows" ? null : true,
  );
  useEffect(() => {
    if (platform !== "windows") return;
    let mounted = true;
    Promise.resolve(window.electronAPI?.windowCanKeepRunning?.())
      .then(answer => { if (mounted) setCanKeepRunning(answer !== false); })
      .catch(() => { if (mounted) setCanKeepRunning(true); });
    return () => { mounted = false; };
  }, [platform]);
  return canKeepRunning;
}

export function WindowCard() {
  // A failed save puts the switch back and shows why: the switch must not
  // say off while the file still says on, since the shell reads the file.
  const { cfg, loaded, patch, errorFor } = useConfigCard<WindowCfg>();
  const platform = getPlatform();
  const canKeepRunning = useCanKeepRunning(platform);
  const desc = keepRunningDescription(platform, canKeepRunning !== false);

  if (desc === null) return null;

  if (!loaded || canKeepRunning === null) {
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
