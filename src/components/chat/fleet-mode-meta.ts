import type { FleetMode } from "@/stores/fleet-store";

export function fleetModeMeta(mode: FleetMode): { label: string; color: string; hint: string } {
  switch (mode) {
    case "manual":      return { label: "Manual",      color: "var(--c-dim)",            hint: "Fleet off" };
    case "refine-only": return { label: "Refine only", color: "rgba(148,163,184,0.95)",  hint: "rewrite on send" };
    case "copilot":     return { label: "Co-pilot",    color: "rgba(96,165,250,0.95)",   hint: "refine + decision card" };
    case "auto":        return { label: "Auto",        color: "rgba(64,180,120,0.95)",   hint: "refine + auto-continue" };
  }
}
