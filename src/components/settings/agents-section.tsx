/**
 * Settings → Agents section. Registry-driven replacement for the legacy
 * one-dropdown AgentsSection. Shows one AgentCard per CLI agent in the
 * catalog (claude, codex, gemini, kimi), each with its detection state
 * (installed + authenticated) plus enable/disable toggle that writes to
 * ProvidersConfig.enabled_agents.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import type { ProviderSpec } from "@/lib/providers-api";
import { AgentCard, type AgentScanEntry } from "./agents/agent-card";

const sectionHeader: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: "0.10em",
  color: "var(--c-dim)",
  textTransform: "uppercase",
  marginTop: 4,
  marginBottom: 10,
  paddingLeft: 1,
};

async function fetchAgentScan(): Promise<Record<string, AgentScanEntry>> {
  try {
    const r = await fetch("/api/agents/scan", { credentials: "include" });
    if (!r.ok) return {};
    return (await r.json()) as Record<string, AgentScanEntry>;
  } catch {
    return {};
  }
}

export function AgentsSection() {
  const { tiles, loading } = useProvidersConfig();
  const [scan, setScan] = useState<Record<string, AgentScanEntry>>({});
  const [scanLoading, setScanLoading] = useState(true);

  const refreshScan = async () => {
    setScanLoading(true);
    const s = await fetchAgentScan();
    setScan(s);
    setScanLoading(false);
  };

  useEffect(() => {
    void refreshScan();
  }, []);

  if (loading || scanLoading) {
    return (
      <div
        style={{
          fontSize: 13,
          color: "var(--c-low)",
          padding: "20px 0",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Loader2 size={14} className="spin" /> Loading agents…
      </div>
    );
  }

  const cliAgents: ProviderSpec[] = tiles
    .filter((t) => t.spec.kind === "cli")
    .map((t) => t.spec);

  return (
    <>
      <div style={sectionHeader}>CLI Agents</div>
      {cliAgents.map((spec) => (
        <AgentCard
          key={spec.id}
          spec={spec}
          scan={scan[spec.id]}
          onChanged={refreshScan}
        />
      ))}
      <div
        style={{
          fontSize: 11.5,
          color: "var(--c-dim)",
          marginTop: 6,
          paddingLeft: 2,
        }}
      >
        CLI agents run as subprocesses. Use the Install / Login buttons to
        copy the right command or launch a terminal — Fleetify never runs
        them on your behalf.
      </div>
    </>
  );
}
