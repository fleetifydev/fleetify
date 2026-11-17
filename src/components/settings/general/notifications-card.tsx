/**
 * Notifications card — Settings → General.
 *
 * Five rows:
 *   - Desktop notifications (master) — toggling off dims the per-event
 *     children.
 *   - Completion sound (WebAudio beep + Test button). Persists under the
 *     existing `fleet:settings:completion-sound` localStorage key so the
 *     setting survives the General-section rewrite.
 *   - Notify on errors / budget — both dim when master is off OR DND is on.
 *   - Do Not Disturb — overrides everything else.
 *
 * Reads/writes the four boolean prefs via `electronAPI.getConfig/setConfig`.
 */
import { useCallback, useState } from "react";
import { Volume2 } from "lucide-react";
import { CardShell, Row, Toggle } from "./_primitives";
import { useConfigCard } from "./_config";

interface NotificationsCfg {
  notificationsEnabled?: boolean;
  notifyErrorsEnabled?: boolean;
  notifyBudgetEnabled?: boolean;
  doNotDisturb?: boolean;
}

const DESKTOP_NOTIFICATIONS = "Desktop notifications";
const COMPLETION_SOUND = "Completion sound";
const NOTIFY_ON_ERRORS = "Notify on errors";
const NOTIFY_ON_BUDGET = "Notify on budget warnings";
const DO_NOT_DISTURB = "Do Not Disturb";

/* Local mirror of the legacy `useToggle("completion-sound", false)` hook
   from settings-page.tsx. Same key, same on-disk representation ("1" /
   "0"), so users keep their existing preference across the rewrite. */
function useSoundToggle() {
  const KEY = "fleet:settings:completion-sound";
  const [on, setOn] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setOn(prev => {
      const next = !prev;
      try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* noop */ }
      return next;
    });
  }, []);
  return [on, toggle] as const;
}

function playBeep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.34);
    osc.onended = () => { ctx.close().catch(() => {}); };
  } catch { /* WebAudio unavailable */ }
}

export function NotificationsCard() {
  // A failed save puts the switch back and shows why under its row.
  const { cfg, loaded, patch, errorFor } = useConfigCard<NotificationsCfg>();
  const [completionSound, toggleCompletionSound] = useSoundToggle();

  const master = cfg.notificationsEnabled ?? true;
  const dnd = cfg.doNotDisturb ?? false;
  const notifyErrors = cfg.notifyErrorsEnabled ?? true;
  const notifyBudget = cfg.notifyBudgetEnabled ?? true;
  const childrenDisabled = !master || dnd;

  if (!loaded) {
    return <CardShell><div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div></CardShell>;
  }

  return (
    <CardShell>
      <Row title={DESKTOP_NOTIFICATIONS} desc="Show OS notifications for agent events."
           error={errorFor("notificationsEnabled")}>
        <Toggle on={master} label={DESKTOP_NOTIFICATIONS}
                onChange={() => void patch({ notificationsEnabled: !master })} />
      </Row>
      <Row title={COMPLETION_SOUND} desc="Play a short ding when an agent finishes a task.">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => playBeep()}
            title="Test sound"
            style={{
              width: 26, height: 26, borderRadius: 6,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent", border: "1px solid var(--c-brd)",
              color: "var(--c-med)", cursor: "pointer", outline: "none",
              transition: "background 0.1s, color 0.1s, border-color 0.1s",
            }}
          >
            <Volume2 size={12} />
          </button>
          <Toggle on={completionSound} label={COMPLETION_SOUND} onChange={toggleCompletionSound} />
        </div>
      </Row>
      <Row title={NOTIFY_ON_ERRORS} desc="Alert when an agent crashes or hits a fatal error." disabled={childrenDisabled}
           error={errorFor("notifyErrorsEnabled")}>
        <Toggle on={notifyErrors} label={NOTIFY_ON_ERRORS}
                onChange={() => void patch({ notifyErrorsEnabled: !notifyErrors })} />
      </Row>
      <Row title={NOTIFY_ON_BUDGET} desc="Alert when an agent approaches its budget cap." disabled={childrenDisabled}
           error={errorFor("notifyBudgetEnabled")}>
        <Toggle on={notifyBudget} label={NOTIFY_ON_BUDGET}
                onChange={() => void patch({ notifyBudgetEnabled: !notifyBudget })} />
      </Row>
      <Row title={DO_NOT_DISTURB} desc="Mute all notifications until you toggle off."
           error={errorFor("doNotDisturb")} last>
        <Toggle on={dnd} label={DO_NOT_DISTURB} onChange={() => void patch({ doNotDisturb: !dnd })} />
      </Row>
    </CardShell>
  );
}
