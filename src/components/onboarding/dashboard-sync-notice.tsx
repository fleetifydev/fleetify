/**
 * DashboardSyncNotice — the dashboard sync question for an install that
 * finished onboarding before onboarding asked it.
 *
 * Such an install has no saved choice (`telemetryGetConfig().cloud_choice`
 * is null), so the shell keeps dashboard sync off and sends nothing. Once
 * the user is signed in and past the intro, this asks onboarding's question,
 * word for word, with its two buttons (`dashboard-sync-question.ts`). Either
 * button saves the answer through `telemetrySetCloudEnabled`, which also
 * sets the live gate, then closes the notice; nothing else closes it. An
 * answer counts for the rest of the session, even one that couldn't be
 * saved: that one is asked again at the next launch.
 *
 * A modal (`aria-modal`): Escape does nothing here, and the chat's Escape
 * handling underneath leaves it alone too (`modalOpen`). It sits above the
 * first-launch tour.
 */
import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownLinkComponents } from "@/components/markdown-link";
import { sendPrivacyChoice } from "@/lib/privacy-choice";
import { ConsentWidget } from "./consent-widget";
import { DASHBOARD_SYNC_QUESTION, readCloudChoice } from "./dashboard-sync-question";

export function DashboardSyncNotice({
  signedIn,
  introComplete,
}: {
  signedIn: boolean;
  /** The intro (onboarding) is done; someone still in it answers there. */
  introComplete: boolean;
}) {
  const active = signedIn && introComplete;
  /** The saved choice; undefined until read, or when it can't be. */
  const [cloudChoice, setCloudChoice] = useState<boolean | null | undefined>(undefined);
  const [answered, setAnswered] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const textId = useId();

  // Read the saved choice each time the user reaches this point: signing in
  // again in the same session may follow an answer saved meanwhile.
  useEffect(() => {
    if (!active) return;
    let current = true;
    void readCloudChoice().then((choice) => {
      if (current) setCloudChoice(choice);
    });
    return () => {
      current = false;
    };
  }, [active]);

  const open = active && !answered && cloudChoice === null;

  // Focus the dialog itself, not a button: neither answer is preselected.
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const answer = async (enabled: boolean) => {
    await sendPrivacyChoice(() => window.electronAPI?.telemetrySetCloudEnabled?.(enabled));
    setAnswered(true);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9600,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: 460,
          background: "var(--sidebar)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 12,
          padding: 18,
          boxShadow: "0 20px 50px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)",
          color: "var(--c-high)",
          outline: "none",
        }}
      >
        <h2
          id={titleId}
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--c-high)",
            letterSpacing: "-0.005em",
            lineHeight: 1.3,
          }}
        >
          Dashboard sync
        </h2>
        <div
          id={textId}
          style={{
            marginTop: 8,
            color: "var(--foreground)",
            fontSize: 13,
            lineHeight: 1.55,
            letterSpacing: "-0.004em",
          }}
        >
          <ReactMarkdown components={markdownLinkComponents}>
            {DASHBOARD_SYNC_QUESTION.text}
          </ReactMarkdown>
        </div>
        <ConsentWidget
          choices={DASHBOARD_SYNC_QUESTION.choices}
          onChoice={(enabled) => void answer(enabled)}
        />
      </div>
    </div>
  );
}
