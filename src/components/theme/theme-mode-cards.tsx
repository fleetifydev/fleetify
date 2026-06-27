/**
 * ThemeModeCards — System / Dark / Light, big side-by-side cards.
 *
 * The single source of truth for the three-mode picker. Onboarding's
 * ThemeWidget and the Settings → Theme section both render this, so the look
 * and behaviour stay identical. Selecting a card applies the choice live via
 * the theme store (`setMode`), which resolves "system" against the OS and
 * keeps following it afterwards.
 */
import { Check } from "lucide-react";
import { useThemeStore, type ThemeMode } from "@/stores/theme-store";

/** Mini light/dark preview shown inside each card. */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  const swatch = (dark: boolean, key?: string) => {
    const bg = dark ? "#161618" : "#fbfbfc";
    const fg = dark ? "rgba(255,255,255,0.82)" : "rgba(0,0,0,0.78)";
    const dim = dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
    const accent = dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
    return (
      <div
        key={key}
        style={{
          flex: 1,
          background: bg,
          display: "flex",
          flexDirection: "column",
          gap: 5,
          padding: "12px 11px",
          justifyContent: "center",
        }}
      >
        <div style={{ width: 16, height: 5, borderRadius: 3, background: accent }} />
        <div style={{ width: "78%", height: 5, borderRadius: 3, background: fg }} />
        <div style={{ width: "92%", height: 4, borderRadius: 3, background: dim }} />
        <div style={{ width: "58%", height: 4, borderRadius: 3, background: dim }} />
      </div>
    );
  };
  return (
    <div
      style={{
        height: 80,
        borderRadius: 9,
        overflow: "hidden",
        display: "flex",
        border: "1px solid rgba(128,128,128,0.18)",
      }}
    >
      {mode === "system"
        ? [swatch(true, "d"), swatch(false, "l")]
        : mode === "dark"
          ? swatch(true)
          : swatch(false)}
    </div>
  );
}

const OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "System" },
  { mode: "dark", label: "Dark" },
  { mode: "light", label: "Light" },
];

export function ThemeModeCards() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div style={{ display: "flex", gap: 10 }}>
      {OPTIONS.map((o) => {
        const active = mode === o.mode;
        return (
          <button
            key={o.mode}
            onClick={() => setMode(o.mode)}
            aria-pressed={active}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 8,
              borderRadius: 12,
              cursor: "pointer",
              background: active ? "var(--secondary)" : "transparent",
              border: `1px solid ${active ? "var(--c-high)" : "var(--c-brd)"}`,
              transition: "border-color 0.15s ease, background 0.15s ease",
            }}
          >
            <ThemePreview mode={o.mode} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                fontSize: 12.5,
                fontWeight: active ? 600 : 500,
                color: active ? "var(--c-high)" : "var(--c-med)",
              }}
            >
              {active && <Check size={12} strokeWidth={2.6} />}
              {o.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}
