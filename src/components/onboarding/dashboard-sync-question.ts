/**
 * The dashboard sync question, word for word. Onboarding asks it at its
 * dashboard step (after "One more thing, <name>."), and <DashboardSyncNotice>
 * asks an install that finished onboarding before that step existed. Both
 * show the same text and buttons, so neither may reword it alone.
 */
import type { ConsentChoice } from "./consent-widget";

/** What dashboard sync does and sends. */
const WHAT_IT_SENDS =
  "Your sessions will show up on your fleetify.dev dashboard. To do that, Fleetify sends session titles (the folder name, or a name you typed), project folder names, which agent and model each session uses, the kind of each agent action, token usage and cost, and a heartbeat every minute while it's open, to your account. Never your code, file contents, commands or API keys.";

export interface DashboardSyncQuestion {
  /** Markdown. */
  text: string;
  /** Keep the setting as it is, then change it: the buttons, in order. */
  choices: readonly [ConsentChoice, ConsentChoice];
}

/** Asked while no saved choice says off: sync is on by default. */
export const DASHBOARD_SYNC_QUESTION: DashboardSyncQuestion = {
  text: `${WHAT_IT_SENDS} It's on by default — you can turn it off now or anytime in **Settings → Privacy**.`,
  choices: [
    { label: "Keep it on", enabled: true },
    { label: "Turn it off", enabled: false },
  ],
};

/** Asked when onboarding runs again after the user turned sync off. */
export const DASHBOARD_SYNC_QUESTION_WHEN_OFF: DashboardSyncQuestion = {
  text: `${WHAT_IT_SENDS} Dashboard sync is off. You can keep it off or turn it on.`,
  choices: [
    { label: "Keep it off", enabled: false },
    { label: "Turn it on", enabled: true },
  ],
};

/** The question for the saved choice (`telemetryGetConfig().cloud_choice`). */
export function dashboardSyncQuestion(
  cloudChoice: boolean | null | undefined,
): DashboardSyncQuestion {
  return cloudChoice === false ? DASHBOARD_SYNC_QUESTION_WHEN_OFF : DASHBOARD_SYNC_QUESTION;
}

/**
 * The dashboard sync choice the shell has saved: `true` or `false`, `null`
 * when there is none, or `undefined` when it can't say (no bridge, or the
 * call failed). Never throws.
 */
export async function readCloudChoice(): Promise<boolean | null | undefined> {
  try {
    return (await window.electronAPI?.telemetryGetConfig?.())?.cloud_choice;
  } catch {
    return undefined;
  }
}
