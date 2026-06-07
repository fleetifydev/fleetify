/**
 * Settings → Studio → Providers — lists studio tools (e.g. Higgsfield) and
 * their current installation / auth state, with a Refresh button.
 *
 * Data source: `studioApi.getTools()` → StudioToolStatus[]
 * Rendered inside the Studio mode of ProvidersSection.
 */
import { useState, useEffect, useCallback } from "react";
import { studioApi, type StudioToolStatus } from "@/lib/studio-api";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";

type LoadState = "loading" | "error" | "done";

export function StudioProvidersSection() {
  const [tools, setTools] = useState<StudioToolStatus[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  const fetch = useCallback(() => {
    setLoadState("loading");
    studioApi
      .getTools()
      .then((t) => {
        setTools(t);
        setLoadState("done");
      })
      .catch(() => {
        setLoadState("error");
      });
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  if (loadState === "loading") {
    return (
      <div style={{ fontSize: 13, color: "var(--c-low)", padding: "12px 2px" }}>
        Checking…
      </div>
    );
  }

  if (loadState === "error" || tools.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "var(--c-low)", padding: "12px 2px" }}>
        No studio providers found.{" "}
        <button
          onClick={fetch}
          style={{
            background: "none",
            border: "none",
            color: "var(--c-low)",
            fontSize: 13,
            cursor: "pointer",
            padding: 0,
            fontFamily: "inherit",
            textDecoration: "underline",
          }}
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {tools.map((t) => (
        <ToolCard key={t.id} tool={t} onRefresh={fetch} />
      ))}
    </div>
  );
}

function ToolCard({ tool: t, onRefresh }: { tool: StudioToolStatus; onRefresh: () => void }) {
  return (
    <div
      style={{
        border: "1px solid var(--c-brd)",
        borderRadius: 10,
        background: "var(--card)",
        overflow: "hidden",
      }}
    >
      {/* Header row — logo + name + status pill + refresh */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
        }}
      >
        <ProviderLogo tool={t.id} size={20} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>
            {t.display_name}
          </div>
          <StatusLine tool={t} />
        </div>
        {t.installed && t.authenticated && (
          <ConnectionStatusPill status="connected" />
        )}
        <button
          onClick={onRefresh}
          style={{
            background: "none",
            border: "1px solid var(--c-brd)",
            borderRadius: 6,
            color: "var(--c-low)",
            fontSize: 12,
            cursor: "pointer",
            padding: "4px 10px",
            fontFamily: "inherit",
            transition: "border-color 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--c-high)";
            e.currentTarget.style.borderColor = "var(--c-brd2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--c-low)";
            e.currentTarget.style.borderColor = "var(--c-brd)";
          }}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function StatusLine({ tool: t }: { tool: StudioToolStatus }) {
  if (!t.installed) {
    return (
      <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginTop: 2 }}>
        Not installed — run <code style={{ fontSize: 11, background: "var(--c-ghost)", borderRadius: 3, padding: "1px 4px" }}>{t.install_hint}</code>
      </div>
    );
  }
  if (!t.authenticated) {
    return (
      <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginTop: 2 }}>
        Installed — run <code style={{ fontSize: 11, background: "var(--c-ghost)", borderRadius: 3, padding: "1px 4px" }}>hf auth login</code> in your terminal, then Refresh.
      </div>
    );
  }
  return (
    <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginTop: 2 }}>
      Ready to use in Studio sessions.
    </div>
  );
}
