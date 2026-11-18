import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { backendFetch } from "@/lib/api";
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

async function fetchAgentScan(refresh: boolean): Promise<Record<string, AgentScanEntry>> {
  try {
    const r = await backendFetch(`/api/agents/scan${refresh ? "?refresh=1" : ""}`, {
      credentials: "include",
    });
    if (!r.ok) return {};
    return (await r.json()) as Record<string, AgentScanEntry>;
  } catch {
    return {};
  }
}

interface InstallApi {
  installProvider?: (toolKey: string) => Promise<{ success?: boolean; error?: string }>;
}

export function AgentsSection() {
  const { tiles, loading } = useProvidersConfig();
  const [scan, setScan] = useState<Record<string, AgentScanEntry>>({});
  const [scanLoading, setScanLoading] = useState(true);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installError, setInstallError] = useState<Record<string, string>>({});
  const installingRef = useRef<Set<string>>(new Set());

  const refreshScan = async (force = false) => {
    if (force) setScanLoading(true);
    const s = await fetchAgentScan(force);
    setScan(s);
    setScanLoading(false);
  };

  useEffect(() => {
    void refreshScan(false);
  }, []);

  const handleInstall = async (specId: string) => {
    if (installingRef.current.has(specId)) return;
    installingRef.current.add(specId);
    setInstalling(new Set(installingRef.current));
    setInstallError((m) => {
      const next = { ...m };
      delete next[specId];
      return next;
    });

    const api = (window as unknown as { electronAPI?: InstallApi }).electronAPI;
    if (!api?.installProvider) {
      installingRef.current.delete(specId);
      setInstalling(new Set(installingRef.current));
      setInstallError((m) => ({ ...m, [specId]: "Restart Fleet to enable Install" }));
      return;
    }

    try {
      const result = await api.installProvider(specId);
      if (!result?.success) {
        const rawErr = result?.error ?? "Install failed";
        const err = (rawErr.split("\n")[0] ?? rawErr).slice(0, 80);
        setInstallError((m) => ({ ...m, [specId]: err }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : "Install failed";
      setInstallError((m) => ({ ...m, [specId]: msg }));
    } finally {
      installingRef.current.delete(specId);
      setInstalling(new Set(installingRef.current));
      await refreshScan(true); // bust the backend cache, reflect post-install state
    }
  };

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

  const cliTiles = tiles.filter((t) => t.spec.kind === "cli");

  return (
    <>
      <div style={sectionHeader}>CLI Agents</div>
      {cliTiles.map((t) => (
        <AgentCard
          key={t.spec.id}
          spec={t.spec}
          enabled={t.connected}
          isDefault={t.is_default}
          scan={scan[t.spec.id]}
          onChanged={() => refreshScan(true)}
          installing={installing.has(t.spec.id)}
          installError={installError[t.spec.id]}
          onInstall={() => handleInstall(t.spec.id)}
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
        Install buttons run npm install -g in the background. The Copy
        icon next to each command lets you run it manually instead.
      </div>
    </>
  );
}
