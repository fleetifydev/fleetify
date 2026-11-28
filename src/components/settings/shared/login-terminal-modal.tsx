/**
 * LoginTerminalModal — a dialog around the terminal a CLI agent's login runs
 * in (`providers.openAccountLogin`). Shared by Settings → Agents (the System
 * account and saved accounts) and onboarding.
 *
 * The header reports how the login process ended; the parent refreshes the
 * scan on exit (`onExit`) and on close (`onClose`), since a login can also
 * finish in the browser after the user stops watching. The terminal stays up
 * after the process exits so its last lines can be read.
 */
import { useState } from "react";
import { Check, Loader2, TerminalSquare, X } from "lucide-react";
import { AccountLoginTerminal } from "./account-login-terminal";

interface Props {
  ptyId: string;
  /** Who is signing in: "Claude Code", or "Claude Code · Work". */
  title: string;
  onExit?: (exitCode: number) => void;
  onClose: () => void;
}

export function LoginTerminalModal({ ptyId, title, onExit, onClose }: Props) {
  const [exitCode, setExitCode] = useState<number | null>(null);

  return (
    <div className="login-modal-scrim" onClick={onClose}>
      <style>{css}</style>
      <div
        className="login-modal"
        role="dialog"
        aria-label={`Sign in to ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head">
          <TerminalSquare size={14} />
          <span style={{ fontWeight: 550 }}>Sign in</span>
          <span style={{ color: "var(--c-dim)" }}>· {title}</span>
          <div style={{ flex: 1 }} />
          <span className="login-modal-state" role="status">
            {exitCode === null ? (
              <>
                <Loader2 size={11} className="animate-spin" /> Waiting for the login to finish
              </>
            ) : exitCode === 0 ? (
              <>
                <Check size={11} /> Login finished
              </>
            ) : (
              <>
                <X size={11} /> Login exited with code {exitCode}
              </>
            )}
          </span>
          <button className="login-modal-btn" onClick={onClose}>
            Done
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <AccountLoginTerminal
            ptyId={ptyId}
            onExit={(code) => {
              setExitCode(code);
              onExit?.(code);
            }}
          />
        </div>
      </div>
    </div>
  );
}

const css = `
.login-modal-scrim {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  backdrop-filter: blur(2px); display: flex; align-items: center;
  justify-content: center; z-index: 1000;
}
.login-modal {
  width: min(760px, 92vw); height: min(480px, 80vh);
  display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
  background: #161616; border: 1px solid var(--c-brd2);
  box-shadow: 0 24px 60px rgba(0,0,0,0.5);
}
.login-modal-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  border-bottom: 1px solid var(--c-brd); font-size: 13px; color: #e8e8e8;
}
.login-modal-state {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: #a0a0a0;
}
.login-modal-btn {
  font-family: inherit; cursor: pointer; outline: none;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px; border-radius: 7px; font-size: 12px; font-weight: 500;
  background: transparent; color: #c8c8c8; border: 1px solid #333;
}
.login-modal-btn:hover { background: #222; color: #fff; }
`;
