/**
 * ListCard — 2-col grid card, horizontal layout (logo · name+desc · Get).
 *
 *   ┌────────────────────────────────────────────┐
 *   │ [logo]  Name                          [Get]│
 *   │         Description text, ellipsised.      │
 *   └────────────────────────────────────────────┘
 *
 * Card surface is a div role=button (not <button>) so it can host an
 * inner <button> for the Get/Install action without nesting (which
 * would be invalid HTML and break focus + a11y).
 */
import { useState } from "react";
import { Package } from "lucide-react";
import type { CatalogPlugin } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { usePluginStore } from "@/stores/plugin-store";

export function ListCard({
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
        display: "flex", alignItems: "center", gap: 10,
        textAlign: "left",
        padding: "10px 12px",
        background: hover ? "var(--c-srf)" : "var(--sidebar)",
        border: "1px solid",
        borderColor: hover ? "var(--c-brd)" : "var(--sidebar-border)",
        borderRadius: 9,
        cursor: "pointer",
        transition: "background 0.10s, border-color 0.10s",
      }}
    >
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
          lineHeight: 1.3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          marginBottom: 2,
        }}>{pluginLabel(plugin.manifest)}</div>
        <div style={{
          fontSize: 11.5, color: "var(--c-dim)",
          lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {plugin.manifest.description}
        </div>
      </div>
      <button
        onClick={e => {
          e.stopPropagation();
          if (!onInstall) { onClick(); return; }
          onInstall();
        }}
        style={{
          flexShrink: 0,
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
  );
}
