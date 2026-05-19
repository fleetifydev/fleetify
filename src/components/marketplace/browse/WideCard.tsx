/**
 * WideCard — 3-col grid card (logo top, name + desc + meta below).
 *
 *   ┌──────────────────────────────┐
 *   │ [logo]                  [Get]│
 *   │                              │
 *   │ Name                         │
 *   │ Description, 2 lines max.    │
 *   │                              │
 *   │ v0.1.0 · tag                 │
 *   └──────────────────────────────┘
 *
 * Outer is a div role=button so the inner Get can be a real <button>
 * (button-in-button would be invalid HTML).
 */
import { useState } from "react";
import { Package } from "lucide-react";
import type { CatalogPlugin } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { usePluginStore } from "@/stores/plugin-store";

export function WideCard({
  plugin, onClick, onInstall,
}: {
  plugin: CatalogPlugin;
  onClick: () => void;
  onInstall?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const installed = usePluginStore(s =>
    s.installs.some(i => i.plugin_name === plugin.manifest.name),
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", flexDirection: "column",
        textAlign: "left",
        padding: "14px",
        background: hover ? "var(--c-srf)" : "var(--sidebar)",
        border: "1px solid",
        borderColor: hover ? "var(--c-brd)" : "var(--sidebar-border)",
        borderRadius: 10,
        cursor: "pointer",
        transition: "background 0.10s, border-color 0.10s",
        minHeight: 140,
      }}
    >
      {/* Top row: logo + Get */}
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div style={{
          width: 36, height: 36,
          borderRadius: 8,
          background: "#ffffff",
          border: "1px solid var(--sidebar-border)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {plugin.manifest.icon ? (
            <img
              src={plugin.manifest.icon}
              alt=""
              referrerPolicy="no-referrer"
              style={{ width: 22, height: 22, objectFit: "contain" }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <Package size={17} style={{ color: "#333" }} />
          )}
        </div>
        <button
          onClick={e => {
            e.stopPropagation();
            if (!onInstall) { onClick(); return; }
            onInstall();
          }}
          style={{
            padding: installed ? "3px 9px" : "3px 12px",
            fontSize: 11, fontWeight: 600,
            background: "var(--c-high)",
            color: "var(--card)",
            border: "none",
            borderRadius: 5,
            cursor: "pointer",
          }}
        >
          {installed ? "Add scope" : "Get"}
        </button>
      </div>

      <div style={{
        fontSize: 13, fontWeight: 500, color: "var(--c-high)",
        lineHeight: 1.3,
        marginBottom: 4,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {pluginLabel(plugin.manifest)}
      </div>
      <p style={{
        flex: 1,
        margin: 0,
        fontSize: 11.5, color: "var(--c-dim)",
        lineHeight: 1.45,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}>
        {plugin.manifest.description}
      </p>

      <div style={{
        marginTop: 10,
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 10.5, color: "var(--c-ghost)",
        fontVariantNumeric: "tabular-nums",
      }}>
        <span>v{plugin.manifest.version}</span>
        {plugin.manifest.tags?.[0] && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>{plugin.manifest.tags[0]}</span>
          </>
        )}
      </div>
    </div>
  );
}
