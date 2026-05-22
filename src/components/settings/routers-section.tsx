/**
 * Routers section — Settings → Routers tab body.
 *
 * Composes the master toggle, the active-selectors summary, and the
 * per-router tiles. Lives at the same path depth as integrations-section
 * (its sibling) so the Settings page can mount it the same way.
 *
 * The `none-proxy` tile is intentionally skipped from the rendered
 * grid — it represents the implicit "no proxy / direct gateway" default
 * and is already covered by the ActiveSelectors summary line above.
 */
import { useRouterConfig } from "@/hooks/use-router-config";
import { MasterToggle } from "./routers/master-toggle";
import { ActiveSelectors } from "./routers/active-selectors";
import { BuiltinRouterTile } from "./routers/builtin-router-tile";
import { NotDiamondTile } from "./routers/notdiamond-tile";
import { WeaveTile } from "./routers/weave-tile";
import { LiteLLMTile } from "./routers/litellm-tile";

export function RoutersSection() {
  const {
    tiles,
    masterEnabled,
    setMasterEnabled,
    setActive,
    refresh,
    loading,
  } = useRouterConfig();

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

  const tileFor = (id: string) => tiles.find((t) => t.id === id);
  const onActivate = (
    category: "decision" | "proxy",
    id: string,
  ) => {
    void setActive(category, id);
  };

  const builtin = tileFor("builtin");
  const notdiamond = tileFor("notdiamond");
  const weave = tileFor("weave");
  const litellm = tileFor("litellm");

  return (
    <div
      data-testid="routers-section"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div
        style={{
          fontSize: 13,
          color: "var(--c-low)",
          marginBottom: 4,
          lineHeight: 1.55,
        }}
      >
        Pick which decision/proxy router Fleet uses when intelligent routing
        is enabled. The built-in router is always available as a fallback.
      </div>

      <MasterToggle enabled={masterEnabled} onChange={setMasterEnabled} />

      <ActiveSelectors tiles={tiles} />

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

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {builtin && (
          <BuiltinRouterTile
            meta={builtin}
            onActivate={(c) => onActivate(c, "builtin")}
          />
        )}
        {notdiamond && (
          <NotDiamondTile
            meta={notdiamond}
            onUpdate={refresh}
            onActivate={(c) => onActivate(c, "notdiamond")}
          />
        )}
        {weave && (
          <WeaveTile
            meta={weave}
            onUpdate={refresh}
            onActivate={(c) => onActivate(c, "weave")}
          />
        )}
        {litellm && (
          <LiteLLMTile
            meta={litellm}
            onUpdate={refresh}
            onActivate={(c) => onActivate(c, "litellm")}
          />
        )}
      </div>
    </div>
  );
}
