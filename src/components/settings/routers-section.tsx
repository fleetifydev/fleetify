/**
 * Routers section — Settings → Routers tab body.
 *
 * Visual model: two lists of cards under "Decision Router" and "Proxy
 * Gateway" headings. Each card knows its own state (active / connected /
 * disconnected) and exposes its actions directly — no separate dropdown,
 * no separate active-selector summary, no modal. The active router in
 * each category is the one with a filled green radio dot and an "active"
 * pill.
 *
 * Built-in (decision) and None / Direct (proxy) cards never disappear:
 * they're the immortal fallbacks the orchestrator always has registered.
 */
import type { RouterTile } from "@/lib/routers-api";
import { useRouterConfig } from "@/hooks/use-router-config";
import { MasterToggle } from "./routers/master-toggle";
import { RouterCard } from "./routers/router-card";

interface RouterMeta {
  description: string;
  docsUrl?: string;
  managedBaseUrl?: string;
}

// Per-router presentation hints. The catalog (id list, names, capabilities,
// modes) lives in the backend; this map adds renderer-only copy + the docs
// link + which URL "Managed" mode means for the user.
const ROUTER_META: Record<string, RouterMeta> = {
  builtin: {
    description:
      "Offline, deterministic router. Heuristic complexity classifier picks an agent + tier from the capability matrix. Always available as a fallback.",
  },
  notdiamond: {
    description:
      "ML-based per-prompt model recommendation. Built for autonomous coding agents.",
    docsUrl: "https://app.notdiamond.ai/api-keys",
    managedBaseUrl: "https://api.notdiamond.ai",
  },
  weave: {
    description:
      "Cost-optimizing proxy with built-in routing decisions. Same key powers both Decision and Proxy capabilities when used together.",
    docsUrl: "https://router.workweave.ai/dashboard",
    managedBaseUrl: "https://router.workweave.ai",
  },
  litellm: {
    description:
      "Self-hosted gateway with fallback chains and budget controls. Point Fleet at your LiteLLM proxy URL.",
    docsUrl: "https://docs.litellm.ai/docs/proxy/quick_start",
  },
  "none-proxy": {
    description:
      "No proxy — bridges hit provider URLs directly. The default for Day-1 installs.",
  },
};

const sectionHeader: React.CSSProperties = {
  fontSize: 11,
  color: "var(--c-low)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  marginBottom: 2,
};

export function RoutersSection() {
  const { tiles, masterEnabled, setMasterEnabled, refresh, loading } =
    useRouterConfig();

  if (loading) {
    return (
      <div
        data-testid="routers-section-loading"
        style={{ padding: 4, color: "var(--c-dim)", fontSize: 12.5 }}
      >
        Loading routers…
      </div>
    );
  }

  const decisionRouters: RouterTile[] = tiles.filter((t) =>
    t.capabilities.includes("decision"),
  );
  const proxyRouters: RouterTile[] = tiles.filter((t) =>
    t.capabilities.includes("proxy"),
  );

  return (
    <div
      data-testid="routers-section"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div
        style={{
          fontSize: 13,
          color: "var(--c-low)",
          lineHeight: 1.55,
        }}
      >
        Pick which router Fleet uses to choose the agent + model
        (decision) and to proxy outbound requests (proxy). Connecting a
        router stores its API key in the OS keychain — only the active
        router runs on each turn, the others stay available for instant
        switching.
      </div>

      <MasterToggle enabled={masterEnabled} onChange={setMasterEnabled} />

      {!masterEnabled && (
        <div
          data-testid="routers-disabled-banner"
          style={{
            // Amber warning that stays legible across every theme: the text
            // is mixed toward --c-high (dark in light themes, light in dark
            // themes) so it never washes out the way a fixed pale-yellow
            // (#fde68a) did on light backgrounds. Background + border tint the
            // card amber while inheriting the active theme's surface/border.
            fontSize: 12,
            color: "color-mix(in srgb, #d97706 62%, var(--c-high))",
            background: "color-mix(in srgb, #f59e0b 14%, var(--card))",
            border: "1px solid color-mix(in srgb, #f59e0b 45%, var(--c-brd))",
            borderRadius: 8,
            padding: "10px 12px",
            lineHeight: 1.55,
          }}
        >
          Intelligent routing is disabled. Fleet Hub will use your
          manually-selected agent for each session. Routers below can still
          be configured ahead of time.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={sectionHeader}>Decision Router</div>
        {decisionRouters.map((t) => (
          <RouterCard
            key={`dec-${t.id}`}
            tile={t}
            category="decision"
            meta={ROUTER_META[t.id] ?? { description: "" }}
            onChanged={refresh}
          />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={sectionHeader}>Proxy Gateway</div>
        {proxyRouters.map((t) => (
          <RouterCard
            key={`prx-${t.id}`}
            tile={t}
            category="proxy"
            meta={ROUTER_META[t.id] ?? { description: "" }}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  );
}
