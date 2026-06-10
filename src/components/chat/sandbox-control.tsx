import { useState, useRef, useEffect } from "react";
import { Check } from "lucide-react";

const SANDBOX_LABELS: Record<string, string> = {
  "read-only": "Read-only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
  "off": "Off",
  "on": "On",
};

function friendlyLabel(opt: string): string {
  return SANDBOX_LABELS[opt] ?? opt;
}

/**
 * Compact sandbox control beside the permission picker.
 *
 * - Toggle variant  (options = ["off","on"]): renders a small "Sandbox: On/Off"
 *   toggle button; clicking flips the value.
 * - Select variant  (options with 3+ values, e.g. Codex tiers): renders a small
 *   popover select with friendly labels; active = value ?? options[0].
 */
export function SandboxControl({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const isToggle =
    options.length === 2 &&
    options.includes("off") &&
    options.includes("on");

  if (isToggle) {
    return (
      <SandboxToggle
        active={value === "on"}
        onChange={(on) => onChange(on ? "on" : "off")}
      />
    );
  }

  // options is guaranteed non-empty by sandboxOptionsFor callers, but guard
  // for TypeScript: options[0] could be undefined if the array is empty.
  const fallback = options[0] ?? "";
  return (
    <SandboxSelect
      options={options}
      value={value ?? fallback}
      onChange={onChange}
    />
  );
}

function SandboxToggle({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      onMouseDown={(e) => e.preventDefault()}
      title={`Sandbox: ${active ? "On" : "Off"}`}
      style={{
        // Same "calm pill" pattern as the permission picker: neutral label,
        // tiny state-coloured dot. Removes the loud green wall-of-text and
        // makes the row read as a list of statuses, not competing accents.
        padding: "3px 8px", marginRight: 1,
        border: "none",
        background: "none",
        color: "var(--c-low)",
        fontSize: 12, fontWeight: 500, cursor: "pointer",
        letterSpacing: "0.005em",
        borderRadius: 5,
        transition: "color 0.12s, background 0.12s",
        flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6,
        fontFamily: "var(--font-sans)",
        outline: "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(var(--fg-rgb),0.05)";
        e.currentTarget.style.color = "var(--c-high)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "none";
        e.currentTarget.style.color = "var(--c-low)";
      }}
    >
      <span style={{
        width: 5, height: 5, borderRadius: "50%",
        background: active ? "rgb(64,180,120)" : "var(--c-low)", flexShrink: 0,
      }}/>
      Sandbox {active ? "on" : "off"}
    </button>
  );
}

function SandboxSelect({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const trigger = friendlyLabel(value);

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.preventDefault()}
        title={`Sandbox: ${trigger}`}
        style={{
          padding: "3px 7px", marginRight: 1,
          border: "none",
          background: open ? "rgba(var(--fg-rgb), 0.05)" : "none",
          color: "var(--c-low)",
          fontSize: 12, fontWeight: 600, cursor: "pointer",
          letterSpacing: "0.005em",
          borderRadius: 5,
          transition: "color 0.12s, background 0.12s",
          flexShrink: 0,
          fontFamily: "var(--font-sans)",
          outline: "none",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "rgba(var(--fg-rgb),0.05)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "none";
        }}
      >
        Sandbox: {trigger}
      </button>
      {open && (
        <div
          style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: 0,
            minWidth: 200,
            background: "var(--popover, #161616)",
            border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
            borderRadius: 8,
            padding: 4,
            boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
            zIndex: 60,
            fontFamily: "var(--font-sans)",
            animation: "fleet-popover-up 0.14s ease-out both",
          }}
        >
          <div
            style={{
              padding: "5px 9px 4px",
            }}
          >
            <span style={{ fontSize: 10.5, color: "var(--c-dim)", fontWeight: 500 }}>
              Sandbox
            </span>
          </div>
          {options.map((opt) => {
            const active = value === opt;
            return (
              <button
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "5px 10px",
                  background: active ? "var(--c-srf)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  borderRadius: 5,
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = "var(--c-srf)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 500,
                    color: "var(--c-fg)",
                  }}
                >
                  {friendlyLabel(opt)}
                </span>
                {active && <Check size={10} style={{ color: "var(--c-dim)" }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
