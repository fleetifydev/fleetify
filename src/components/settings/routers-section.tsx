/**
 * Routers section — Settings → Routers tab body.
 *
 * Layout:
 *   - Master toggle ("Use intelligent routing for Fleet Hub")
 *   - Decision Router dropdown (always Built-in + any connected router
 *     that supports the decision capability)
 *   - Proxy Gateway dropdown (None/Direct + any connected proxy)
 *   - Inline RouterConfigPanel when the user picks a router that needs
 *     credentials, or clicks "Edit" on an already-connected one.
 *
 * State machine:
 *   - The two dropdowns reflect either (a) the backend's active selection
 *     or (b) the user's pending selection for a router they're configuring.
 *   - Picking an *already-connected* router fires `routers.setActive`
 *     immediately and clears any pending state.
 *   - Picking a *not-yet-connected* router promotes it to the pending
 *     slot for that category and the config panel slides in below.
 *   - Successful connect → setActive → refresh → pending cleared.
 *   - Cancel → pending cleared, dropdown snaps back to the active router.
 */
import { useCallback, useState } from "react";
import type { RouterTile } from "@/lib/routers-api";
import { useRouterConfig } from "@/hooks/use-router-config";
import { MasterToggle } from "./routers/master-toggle";
import { RouterDropdown } from "./routers/router-dropdown";
import { RouterConfigPanel } from "./routers/router-config-panel";

type Category = "decision" | "proxy";

interface RouterMeta {
  docsUrl?: string;
  managedBaseUrl?: string;
}

// Per-router presentation hints. The catalog (id list, names, capabilities,
// modes) lives in the backend; this map just adds renderer-only metadata
// (docs link, what URL "Managed" means).
const ROUTER_META: Record<string, RouterMeta> = {
  notdiamond: {
    docsUrl: "https://app.notdiamond.ai/api-keys",
    managedBaseUrl: "https://api.notdiamond.ai",
  },
  weave: {
    docsUrl: "https://router.workweave.ai/dashboard",
    managedBaseUrl: "https://router.workweave.ai",
  },
  litellm: {
    docsUrl: "https://docs.litellm.ai/docs/proxy/quick_start",
  },
};

function defaultDecisionId(tiles: RouterTile[]): string {
  return tiles.find((t) => t.active_for_decision)?.id ?? "builtin";
}

function defaultProxyId(tiles: RouterTile[]): string {
  return tiles.find((t) => t.active_for_proxy)?.id ?? "none-proxy";
}

export function RoutersSection() {
  const { tiles, masterEnabled, setMasterEnabled, setActive, refresh, loading } =
    useRouterConfig();

  // Pending selection per category. `null` means "no override — dropdown
  // mirrors the backend's active router". A non-null value means the user
  // picked a router that needs setup, and the config panel below is open
  // for it.
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [pendingProxy, setPendingProxy] = useState<string | null>(null);

  // Whether the user clicked "Edit" on the currently-active router. Lets
  // them rotate the API key without disconnecting first.
  const [editingDecision, setEditingDecision] = useState<boolean>(false);
  const [editingProxy, setEditingProxy] = useState<boolean>(false);

  const handleDropdownChange = useCallback(
    async (category: Category, newId: string) => {
      const tile = tiles.find((t) => t.id === newId);
      if (!tile) return;
      const needsSetup = tile.modes.length > 0 && !tile.connected;
      if (needsSetup) {
        // Promote to pending; config panel will render below.
        if (category === "decision") {
          setPendingDecision(newId);
          setEditingDecision(false);
        } else {
          setPendingProxy(newId);
          setEditingProxy(false);
        }
      } else {
        // Already connected (or immortal default) — flip the backend
        // active selection right away.
        await setActive(category, newId);
        if (category === "decision") {
          setPendingDecision(null);
          setEditingDecision(false);
        } else {
          setPendingProxy(null);
          setEditingProxy(false);
        }
      }
    },
    [tiles, setActive],
  );

  const handleConfigSaved = useCallback(
    async (category: Category) => {
      // The config panel already called setActive on success. Just refresh
      // the tile list so connected/active flags pick up the new state, and
      // clear pending so the dropdown sticks to the now-active router.
      await refresh();
      if (category === "decision") {
        setPendingDecision(null);
        setEditingDecision(false);
      } else {
        setPendingProxy(null);
        setEditingProxy(false);
      }
    },
    [refresh],
  );

  const cancelPending = useCallback((category: Category) => {
    if (category === "decision") {
      setPendingDecision(null);
      setEditingDecision(false);
    } else {
      setPendingProxy(null);
      setEditingProxy(false);
    }
  }, []);

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

  const decisionOptions = tiles.filter((t) =>
    t.capabilities.includes("decision"),
  );
  const proxyOptions = tiles.filter((t) => t.capabilities.includes("proxy"));

  const activeDecisionId = defaultDecisionId(tiles);
  const activeProxyId = defaultProxyId(tiles);

  // The dropdown's currently-displayed value — pending takes precedence
  // so the user sees what they picked, even before saving.
  const selectedDecisionId = pendingDecision ?? activeDecisionId;
  const selectedProxyId = pendingProxy ?? activeProxyId;

  // Resolve the tiles for the config panels (when shown).
  const decisionConfigTile =
    (pendingDecision ?? (editingDecision ? activeDecisionId : null)) !== null
      ? tiles.find(
          (t) => t.id === (pendingDecision ?? activeDecisionId),
        )
      : null;
  const proxyConfigTile =
    (pendingProxy ?? (editingProxy ? activeProxyId : null)) !== null
      ? tiles.find(
          (t) => t.id === (pendingProxy ?? activeProxyId),
        )
      : null;

  // Filter: don't show config panel for routers that don't take credentials.
  const showDecisionConfig =
    !!decisionConfigTile && decisionConfigTile.modes.length > 0;
  const showProxyConfig =
    !!proxyConfigTile && proxyConfigTile.modes.length > 0;

  const sameService = selectedDecisionId === selectedProxyId;

  return (
    <div
      data-testid="routers-section"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div
        style={{
          fontSize: 13,
          color: "var(--c-low)",
          marginBottom: 2,
          lineHeight: 1.55,
        }}
      >
        Pick which decision and proxy router Fleet uses when intelligent
        routing is enabled. Routers needing an API key open a configuration
        form inline after selection. The Built-in router is always available
        as a fallback.
      </div>

      <MasterToggle enabled={masterEnabled} onChange={setMasterEnabled} />

      {!masterEnabled && (
        <div
          data-testid="routers-disabled-banner"
          style={{
            fontSize: 12,
            color: "#fde68a",
            background: "rgba(251,191,36,0.08)",
            border: "1px solid rgba(251,191,36,0.25)",
            borderRadius: 8,
            padding: "10px 12px",
            lineHeight: 1.55,
          }}
        >
          Intelligent routing is disabled. Fleet Hub will use your
          manually-selected agent for each session.
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <RouterDropdown
            label="Decision Router"
            testId="decision-router-select"
            options={decisionOptions}
            value={selectedDecisionId}
            onChange={(id) => void handleDropdownChange("decision", id)}
          />
          {!showDecisionConfig &&
            decisionConfigTile === null &&
            activeDecisionId !== "builtin" && (
              <button
                type="button"
                onClick={() => setEditingDecision(true)}
                style={editLinkStyle}
                data-testid="decision-edit"
              >
                Edit credentials
              </button>
            )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <RouterDropdown
            label="Proxy Gateway"
            testId="proxy-gateway-select"
            options={proxyOptions}
            value={selectedProxyId}
            onChange={(id) => void handleDropdownChange("proxy", id)}
          />
          {!showProxyConfig &&
            proxyConfigTile === null &&
            activeProxyId !== "none-proxy" && (
              <button
                type="button"
                onClick={() => setEditingProxy(true)}
                style={editLinkStyle}
                data-testid="proxy-edit"
              >
                Edit credentials
              </button>
            )}
        </div>
      </div>

      {sameService && selectedDecisionId !== "builtin" && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--c-dim)",
            marginTop: -4,
            lineHeight: 1.5,
          }}
        >
          Decisions are made in-line — no extra network hop.
        </div>
      )}

      {showDecisionConfig && decisionConfigTile && (
        <RouterConfigPanel
          tile={decisionConfigTile}
          category="decision"
          docsUrl={ROUTER_META[decisionConfigTile.id]?.docsUrl}
          managedBaseUrl={ROUTER_META[decisionConfigTile.id]?.managedBaseUrl}
          onSaved={() => handleConfigSaved("decision")}
          onCancel={() => cancelPending("decision")}
        />
      )}

      {showProxyConfig && proxyConfigTile && (
        <RouterConfigPanel
          tile={proxyConfigTile}
          category="proxy"
          docsUrl={ROUTER_META[proxyConfigTile.id]?.docsUrl}
          managedBaseUrl={ROUTER_META[proxyConfigTile.id]?.managedBaseUrl}
          onSaved={() => handleConfigSaved("proxy")}
          onCancel={() => cancelPending("proxy")}
        />
      )}
    </div>
  );
}

const editLinkStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: 11.5,
  color: "var(--c-low)",
  textDecoration: "underline",
  cursor: "pointer",
  fontFamily: "inherit",
};
