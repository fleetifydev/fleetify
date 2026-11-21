/**
 * The in-app updater as the renderer sees it, for the update banner and
 * Settings → General → Updates.
 *
 * The shell runs the updater (src-tauri/src/shell/updater.rs). `init` reads
 * its status once, then follows the `fleet:updater-status` event the shell
 * sends with every change; App calls it once, outside its screen gates, so
 * the status is known before sign-in too. `check` (Check now) and
 * `restart` (Restart to update) call the shell's commands. Without the
 * bridge, in a plain browser, the status stays null and every call does
 * nothing.
 */
import { create } from "zustand";
import type { UpdateStatus } from "@/lib/api";

/** Shown when Restart to update fails without a message of its own. */
const RESTART_FAILED = "Couldn't install the update.";

export interface UpdateStore {
  /** The shell's status: null until it answers, and without the bridge. */
  status: UpdateStatus | null;
  /** The ready version put off with Later. */
  dismissedVersion: string | null;
  /** Why the last Restart to update failed. A new try or a new check
   *  clears it. */
  restartError: string | null;
  /** Reads the status and follows its changes. Returns the unsubscribe. */
  init(): () => void;
  /** Check now: asks the shell to check, whether automatic updates are on
   *  or not. */
  check(): Promise<void>;
  /** Restart to update: installs the update that has downloaded, and the
   *  app restarts into it. Settles once the shell has answered. */
  restart(): Promise<void>;
  /** Later: hides the banner until another version is ready. */
  dismiss(): void;
}

/** The shell's bridge, when this window has one. */
function bridge(): Window["fleetify"] {
  return typeof window === "undefined" ? undefined : window.fleetify;
}

/** True for what the shell sends as a status. */
function isStatus(value: unknown): value is UpdateStatus {
  return typeof value === "object" && value !== null
    && typeof (value as { state?: unknown }).state === "string";
}

/**
 * How many statuses have arrived as events. The answer to a read or a check
 * that was asked for before an event went out can hold an older status than
 * that event, so an answer counts only when no event has arrived since it
 * was asked for. An event that isn't a status doesn't count.
 */
let heard = 0;

/** The Restart to update still waiting for the shell, so that a second
 *  click doesn't ask again. */
let restarting: Promise<void> | null = null;

export const useUpdateStore = create<UpdateStore>((set, get) => {
  /** Makes `status` the current status. A new check means the last
   *  install try is over, and its error goes. */
  const apply = (status: unknown) => {
    if (!isStatus(status)) return;
    set(status.state === "checking" ? { status, restartError: null } : { status });
  };

  return {
    status: null,
    dismissedVersion: null,
    restartError: null,

    init() {
      const fleetify = bridge();
      let active = true;
      let unsubscribe = () => {};
      if (typeof fleetify?.onUpdaterStatus === "function") {
        unsubscribe = fleetify.onUpdaterStatus((status) => {
          if (!active || !isStatus(status)) return;
          heard += 1;
          apply(status);
        });
      }
      if (typeof fleetify?.updaterStatus === "function") {
        const before = heard;
        new Promise<UpdateStatus>((resolve) => resolve(fleetify.updaterStatus()))
          .then((status) => { if (active && heard === before) apply(status); })
          .catch(() => { /* the events bring the status */ });
      }
      return () => {
        active = false;
        unsubscribe();
      };
    },

    async check() {
      const fleetify = bridge();
      if (typeof fleetify?.updaterCheck !== "function") return;
      const before = heard;
      try {
        const status = await fleetify.updaterCheck();
        if (heard === before) apply(status);
      } catch {
        // The shell answers every check with a status, a failed check too,
        // so only the bridge itself fails here: the status stays as it is.
      }
    },

    restart() {
      const fleetify = bridge();
      if (typeof fleetify?.updaterRestart !== "function") return Promise.resolve();
      if (restarting) return restarting;
      set({ restartError: null });
      // A failed install usually leaves the update ready (the shell puts the
      // status back), so Restart to update stays offered, with the reason.
      // If the install task itself dies, the status is failed and the update
      // is gone; the next check downloads it again.
      restarting = new Promise<void>((resolve) => resolve(fleetify.updaterRestart()))
        .then(
          () => {},
          (error: unknown) => {
            set({ restartError: typeof error === "string" && error ? error : RESTART_FAILED });
          },
        )
        .finally(() => { restarting = null; });
      return restarting;
    },

    dismiss() {
      const { status } = get();
      if (status?.state === "ready") set({ dismissedVersion: status.version });
    },
  };
});
