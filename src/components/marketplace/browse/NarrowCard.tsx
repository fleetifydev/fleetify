/**
 * NarrowCard — vertical layout for horizontal scroll rows.
 *
 *   ┌────────────────────────┐
 *   │ [logo] name      [Get] │
 *   │        by source       │
 *   │                        │
 *   │ description, 2 lines.  │
 *   │                        │
 *   │ version · tag          │
 *   └────────────────────────┘
 *
 * Outer surface is a div role=button so the inner Get button (which
 * calls install via stopPropagation) doesn't violate button-nesting.
 */
import { useState } from "react";
import { Package } from "lucide-react";
import type { CatalogPlugin } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { usePluginStore } from "@/stores/plugin-store";

export function NarrowCard({
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
  const sources = usePluginStore(s => s.sources);
  const source = sources.find(s => s.id === plugin.source_id);

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
        padding: "12px",
        background: hover ? "var(--c-srf)" : "var(--sidebar)",
        border: "1px solid",
        borderColor: hover ? "var(--c-brd)" : "var(--sidebar-border)",
        borderRadius: 10,
        cursor: "pointer",
        transition: "background 0.10s, border-color 0.10s",
        minHeight: 132,
      }}
    >
      {/* Header row: logo + name + Get */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        marginBottom: 8,
      }}>
        <div style={{
          width: 28, height: 28, flexShrink: 0,
          borderRadius: 6,
          background: "#ffffff",
          border: "1px solid var(--sidebar-border)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {plugin.manifest.icon ? (
            <img
              src={plugin.manifest.icon}
              alt=""
              referrerPolicy="no-referrer"
              style={{ width: 17, height: 17, objectFit: "contain" }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <Package size={13} style={{ color: "#333" }} />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12.5, fontWeight: 500, color: "var(--c-high)",
            lineHeight: 1.2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{pluginLabel(plugin.manifest)}</div>
          {source && (
            <div style={{
              fontSize: 10.5, color: "var(--c-ghost)",
              lineHeight: 1.3, marginTop: 1,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>by {source.name}</div>
          )}
        </div>
        <button
          onClick={e => {
            e.stopPropagation();
            if (!onInstall) { onClick(); return; }
            onInstall();
          }}
          style={{
            flexShrink: 0,
            padding: installed ? "3px 9px" : "3px 11px",
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

      {/* Description */}
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

      {/* Footer: component count meta */}
      <div style={{
        marginTop: 10,
        display: "flex", alignItems: "center", gap: 10,
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
