/**
 * Updates card — Settings → General.
 *
 * Automatic updates (`updatesAuto`) lets the shell check for updates when
 * Fleetify starts and every six hours, and download a newer version in the
 * background (src-tauri/src/shell/updater.rs). Like the shell, it counts as
 * on unless it is saved as `false`. Check now asks the shell to check at
 * once, whether automatic updates are on or not. The row's description
 * follows the updater's status (useUpdateStore), and once an update has
 * downloaded, Restart to update installs it. Fleetify has one stable
 * channel, so there is no channel picker.
 */
import type { CSSProperties } from "react";
import { CardShell, Row, Toggle } from "./_primitives";
import { useConfigCard } from "./_config";
import { useUpdateStore } from "@/stores/update-store";
import type { UpdateStatus } from "@/lib/api";

interface UpdatesCfg {
  updatesAuto?: boolean;
}

const AUTOMATIC_UPDATES = "Automatic updates";

declare const __APP_VERSION__: string | undefined;

/* `__APP_VERSION__` is a Vite `define` replacement — it gets inlined at
   build time. In test runs (and any context where the define isn't
   wired) the symbol is undeclared and reading it throws ReferenceError,
   which would unmount the whole card. Resolve through a try/catch so
   the surface still renders. */
function appVersion(): string {
  try { return __APP_VERSION__ ?? "—"; } catch { return "—"; }
}

/** The statuses in which Check now is shown but off: a check or an install
 *  is running, or the shell starts no check (a debug build, or an update is
 *  ready, as after a failed install). */
const CHECK_UNAVAILABLE: ReadonlySet<UpdateStatus["state"]> =
  new Set(["checking", "downloading", "ready", "installing", "disabled"]);

/** The "Check for updates" row's description for `status`, where `app` is
 *  the version running. */
function statusLine(status: UpdateStatus | null, app: string): string {
  if (!status) return `Current: v${app}`;
  switch (status.state) {
    case "checking":
      return "Checking…";
    case "upToDate":
      return `v${app} is the latest version.`;
    case "downloading": {
      // The percent only when the server gave a size.
      if (!status.total) return `Downloading v${status.version}…`;
      const pct = Math.min(100, Math.floor((status.downloaded / status.total) * 100));
      return `Downloading v${status.version}… ${pct}%`;
    }
    case "ready":
      return `v${status.version} is ready.`;
    case "installing":
      return `Installing v${status.version}…`;
    case "failed":
      return status.message;
    case "disabled":
      return "Updates are off in development builds.";
    case "idle":
    default:
      return `Current: v${app}`;
  }
}

export function UpdatesCard() {
  // A failed save puts the control back and shows why under its row.
  const { cfg, loaded, patch, errorFor } = useConfigCard<UpdatesCfg>();
  const status = useUpdateStore(s => s.status);
  const restartError = useUpdateStore(s => s.restartError);
  const check = useUpdateStore(s => s.check);
  const restart = useUpdateStore(s => s.restart);

  if (!loaded) {
    return <CardShell><div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div></CardShell>;
  }

  const auto = cfg.updatesAuto !== false;
  const ready = status?.state === "ready";
  const checkEnabled = !status || !CHECK_UNAVAILABLE.has(status.state);

  return (
    <CardShell>
      <Row title={AUTOMATIC_UPDATES}
           desc="Check for updates when Fleetify starts and every six hours, and download them in the background."
           error={errorFor("updatesAuto")}>
        <Toggle on={auto} label={AUTOMATIC_UPDATES} onChange={() => void patch({ updatesAuto: !auto })} />
      </Row>
      {/* A failed install usually leaves the update ready: Restart to update
          stays, with the reason under the row. If the install task itself
          dies, the status is failed and the update is gone. */}
      <Row title="Check for updates"
           desc={statusLine(status, appVersion())}
           error={ready ? restartError : null}
           last>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {ready && (
            <button type="button" onClick={() => void restart()} style={buttonStyle("primary", true)}>
              Restart to update
            </button>
          )}
          <button
            type="button"
            onClick={() => void check()}
            disabled={!checkEnabled}
            style={buttonStyle(ready ? "secondary" : "primary", checkEnabled)}
          >
            Check now
          </button>
        </div>
      </Row>
    </CardShell>
  );
}

/** The row's buttons. Once an update is ready, Restart to update is the
 *  primary one, and Check now steps back, disabled. */
function buttonStyle(kind: "primary" | "secondary", enabled: boolean): CSSProperties {
  return {
    padding: "6px 14px", borderRadius: 7,
    background: kind === "primary" ? "var(--c-high)" : "transparent",
    border: kind === "primary" ? "1px solid transparent" : "1px solid var(--c-brd)",
    color: kind === "primary" ? "var(--card)" : "var(--c-high)",
    fontSize: 12, fontWeight: 600,
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.55,
    fontFamily: "inherit",
  };
}
