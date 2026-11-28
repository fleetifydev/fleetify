import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { refreshAgentScanOnFocus, useAgentScanStore } from "@/stores/agent-scan-store";
import { AgentCard } from "./agents/agent-card";

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

interface InstallApi {
  installProvider?: (toolKey: string) => Promise<{ success?: boolean; error?: string }>;
}

export function AgentsSection() {
  const { tiles, loading } = useProvidersConfig();
  const scan = useAgentScanStore((s) => s.scan);
  const scanStatus = useAgentScanStore((s) => s.status);
  const refreshing = useAgentScanStore((s) => s.refreshing);
  const refresh = useAgentScanStore((s) => s.refresh);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installError, setInstallError] = useState<Record<string, string>>({});
  const installingRef = useRef<Set<string>>(new Set());

  // A refresh keeps the cards mounted (and expanded, with any open sign-in
  // dialog): the store swaps the scan in place.
  const refreshScan = (force = false) => refresh(force);

  useEffect(() => {
    void refreshScan(false);
    // Signing in happens in a terminal or the browser too: re-check on focus.
    return refreshAgentScanOnFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (loading || scanStatus === "idle" || scanStatus === "loading") {
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
  const scanFailed = scanStatus === "error";

  return (
    <>
      <div style={{ ...sectionHeader, display: "flex", alignItems: "center", gap: 8 }}>
        CLI Agents
        {refreshing && <Loader2 size={11} className="spin" aria-label="Checking agents" />}
      </div>
      {scanFailed && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--c-med)",
            marginBottom: 10,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          Couldn't check which agents are installed and signed in.
          <button
            type="button"
            onClick={() => void refreshScan(true)}
            style={{
              fontFamily: "inherit",
              fontSize: 12,
              cursor: "pointer",
              background: "transparent",
              border: "1px solid var(--c-brd)",
              borderRadius: 6,
              padding: "3px 9px",
              color: "var(--c-med)",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <RotateCw size={11} /> Retry
          </button>
        </div>
      )}
      {cliTiles.map((t) => (
        <AgentCard
          key={t.spec.id}
          spec={t.spec}
          enabled={t.connected}
          isDefault={t.is_default}
          scan={scan[t.spec.id]}
          scanFailed={scanFailed}
          onChanged={() => void refreshScan(true)}
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
