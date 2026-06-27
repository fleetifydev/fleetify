/**
 * AccountFooter — shared user-row for Fleet, Settings, and Library sidebars.
 *
 * Visually identical to Fleet's original AccountFooter: 20px initials pill,
 * displayName, size={14} theme toggle, gap:10, padding:6px 10px,
 * fontSize:13, borderRadius:7. Settings passes onClickAccount to switch
 * in-page tabs; Library/Fleet use the default (dispatch fleet:open-settings).
 *
 * The theme toggle reflects the current mode (Sun=light, Moon=dark,
 * Monitor=system) and cycles System → Light → Dark → System on click.
 */
import { Sun, Moon, Monitor } from "lucide-react";
import { useThemeStore } from "@/stores/theme-store";

export interface AccountFooterProps {
  /**
   * Called when the user row (not the theme toggle) is clicked.
   * Default: dispatches `fleet:open-settings` with `{ tab: "Account" }`.
   */
  onClickAccount?: () => void;
}

export function AccountFooter({ onClickAccount }: AccountFooterProps = {}) {
  const raw = localStorage.getItem("fleet:user");
  const user = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  const displayName: string = user?.name ?? user?.email?.split("@")[0] ?? "User";
  const initials = displayName.trim().split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase() || "U";
  const mode = useThemeStore((s) => s.mode);
  const cycleMode = useThemeStore((s) => s.cycleMode);
  const ThemeIcon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
  const modeLabel = mode === "system" ? "System" : mode === "dark" ? "Dark" : "Light";

  const handleClick = onClickAccount ?? (() =>
    window.dispatchEvent(new CustomEvent("fleet:open-settings", { detail: { tab: "Account" } }))
  );

  return (
    <button
      onClick={handleClick}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "6px 10px", border: "none", cursor: "pointer",
        textAlign: "left", fontSize: 13, fontWeight: 400,
        borderRadius: 7, background: "none", color: "var(--c-med)",
        transition: "none",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "none";       e.currentTarget.style.color = "var(--c-med)"; }}
    >
      <span style={{
        width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "var(--c-srf2)", color: "var(--c-med)",
        fontSize: 9.5, fontWeight: 600, letterSpacing: 0.2,
      }}>{initials}</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {displayName}
      </span>
      <span
        role="button"
        aria-label={`Theme: ${modeLabel} — click to switch`}
        title={`Theme: ${modeLabel} — click to switch`}
        onClick={(e) => { e.stopPropagation(); cycleMode(); }}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 18, height: 18, borderRadius: 4, flexShrink: 0,
          color: "var(--c-dim)",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-dim)"; }}
      >
        <ThemeIcon size={14} />
      </span>
    </button>
  );
}
