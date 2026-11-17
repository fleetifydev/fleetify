/**
 * Root error boundary. Without one, a render error anywhere in the app
 * unmounts the whole tree and leaves a blank window. This shows a recovery
 * screen instead, with a Reload button.
 *
 * The error goes to `logRenderError`: the details stay in the local log, and
 * product analytics, when the user opted in, gets only the error's type.
 * Errors in event handlers and async code never reach a boundary; the global
 * capture in `src/lib/log.ts` logs those.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { logRenderError } from "@/lib/log";

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    logRenderError(error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? <RecoveryScreen /> : this.props.children;
  }
}

function RecoveryScreen() {
  return (
    <div
      role="alert"
      style={{
        position: "fixed", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
        background: "var(--background)", color: "var(--c-high)",
        fontFamily: "inherit",
      }}
    >
      <div style={{
        width: "100%", maxWidth: 420, padding: "22px 24px",
        borderRadius: 10, border: "1px solid var(--c-brd)",
        background: "var(--card)", textAlign: "center",
      }}>
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
          Something went wrong
        </h1>
        <p style={{ margin: "8px 0 18px", fontSize: 13, color: "var(--c-low)", lineHeight: 1.5 }}>
          Fleetify hit an unexpected error. Reload to continue — your sessions are saved.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "7px 16px", borderRadius: 7, border: "none",
            background: "var(--c-high)", color: "var(--card)",
            fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
