import { Minus, Square, X } from "lucide-react";
import { isWindowsPlatform } from "@/lib/utils";

/**
 * Custom Windows window controls — minimize / maximize / close.
 *
 * `BrowserWindow.titleBarStyle: "hidden"` strips the native chrome on
 * Windows, so the renderer paints these buttons itself. Rendered inline
 * inside the WindowsTitleBar row, not as a fixed overlay — the title
 * bar is its own top section (ChatGPT-desktop style). macOS keeps the
 * standard traffic lights and never mounts this component.
 *
 * Sizing follows the Windows 11 caption-button metric (46 × 32) so the
 * three buttons read as a native set rather than custom UI.
 */
const BTN_W = 46;
const BTN_H = 32;
export const WINDOW_CONTROLS_WIDTH_PX = BTN_W * 3;
export const WINDOWS_TITLEBAR_HEIGHT_PX = BTN_H;

export function WindowControls() {
  if (!isWindowsPlatform()) return null;

  const minimize = () => window.electronAPI?.minimizeWindow();
  const maximize = () => window.electronAPI?.maximizeWindow();
  const close    = () => window.electronAPI?.closeWindow();

  return (
    // `no-drag` so clicks aren't intercepted by the surrounding
    // drag-region in the title bar.
    <div
      className="no-drag"
      style={{
        display: "flex",
        height: BTN_H,
        background: "transparent",
      }}
    >
      <CaptionButton onClick={minimize} title="Minimize">
        <Minus size={14} strokeWidth={1.6} />
      </CaptionButton>
      <CaptionButton onClick={maximize} title="Maximize">
        <Square size={11} strokeWidth={1.6} />
      </CaptionButton>
      <CaptionButton onClick={close} title="Close" danger>
        <X size={14} strokeWidth={1.6} />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  children, onClick, title, danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  // Hover bg: close uses the Windows-11 red caption tint; minimize +
  // maximize use the same low-key surface the rest of the IconBtns
  // use, so the destructive action has a distinct affordance.
  const hoverBg = danger ? "#c42b1c" : "var(--c-srf)";
  const hoverFg = danger ? "#ffffff"  : "var(--c-high)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: BTN_W, height: BTN_H,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "transparent", border: "none",
        color: "var(--c-med)",
        cursor: "pointer", padding: 0,
        transition: "background 0.08s, color 0.08s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.style.color = hoverFg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--c-med)";
      }}
    >
      {children}
    </button>
  );
}
