/**
 * HeroCard — Spotlight billboard for the featured plugin.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ SPOTLIGHT · TAG                                         │
 *   │ Plugin name                                  ┌──┐       │
 *   │ description                                  │  │       │
 *   │ [Install]  [View details →]                  └──┘       │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Uses the plugin's actual manifest content as hero text instead of
 * fake editorial copy ("Ship faster with X" was templated and
 * read as marketing fluff). Soft radial accent + 96px logo tile.
 */
import { Package } from "lucide-react";
import type { CatalogPlugin } from "@/types/plugin";
import { pluginLabel } from "@/types/plugin";
import { usePluginStore } from "@/stores/plugin-store";

export function HeroCard({
  plugin, onOpen, onInstall,
}: {
  plugin: CatalogPlugin;
  onOpen: () => void;
  onInstall?: () => void;
}) {
  const installed = usePluginStore(s =>
    s.installs.some(i => i.plugin_name === plugin.manifest.name),
  );
  const primaryTag = plugin.manifest.tags?.[0];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", gap: 24,
        padding: "28px 30px",
        background: "linear-gradient(135deg, var(--sidebar) 0%, var(--c-srf) 100%)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 14,
        overflow: "hidden",
        cursor: "pointer",
        transition: "border-color 0.12s, transform 0.12s",
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--c-brd)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--sidebar-border)"; }}
    >
      {/* Soft accent glow behind the logo */}
      <div style={{
        position: "absolute",
        right: -40, top: -40,
        width: 280, height: 280,
        background: "radial-gradient(circle, rgba(124,93,255,0.18) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <div style={{ flex: 1, minWidth: 0, position: "relative", zIndex: 1 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 10, fontWeight: 600,
          letterSpacing: "0.12em",
          color: "var(--c-ghost)",
          textTransform: "uppercase",
          marginBottom: 10,
        }}>
          <span>Spotlight</span>
          {primaryTag && (
            <>
              <span style={{ opacity: 0.4 }}>·</span>
              <span style={{ color: "#a78bfa" }}>{primaryTag}</span>
            </>
          )}
        </div>
        <h2 style={{
          margin: 0, padding: 0,
          fontSize: 26, fontWeight: 600,
          lineHeight: 1.15,
          color: "var(--c-high)",
          letterSpacing: "-0.015em",
          marginBottom: 10,
        }}>
          {pluginLabel(plugin.manifest)}
        </h2>
        <p style={{
          margin: 0, padding: 0,
          fontSize: 13, color: "var(--c-dim)",
          lineHeight: 1.55,
          maxWidth: 540,
          marginBottom: 18,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {plugin.manifest.description}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={e => {
              e.stopPropagation();
              // Same dialog handles fresh install AND add-scope —
              // MarketplacePage looks up existingInstall by name and
              // hands it to InstallDialog as a prop.
              if (!onInstall) { onOpen(); return; }
              onInstall();
            }}
            style={{
              padding: "7px 16px",
              background: "var(--c-high)",
              color: "var(--card)",
              border: "none",
              borderRadius: 7,
              fontSize: 12, fontWeight: 600,
              cursor: "pointer",
              transition: "opacity 0.12s",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "0.88"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
          >
            {installed ? "Add scope" : "Install"}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onOpen(); }}
            style={{
              padding: "7px 14px",
              background: "transparent",
              color: "var(--c-med)",
              border: "1px solid var(--sidebar-border)",
              borderRadius: 7,
              fontSize: 12, fontWeight: 500,
              cursor: "pointer",
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
              (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
            }}
          >
            View details →
          </button>
        </div>
      </div>

      {/* Big logo tile */}
      <div style={{
        width: 104, height: 104, flexShrink: 0,
        borderRadius: 22,
        background: "#ffffff",
        border: "1px solid var(--sidebar-border)",
        display: "flex", alignItems: "center", justifyContent: "center",
        position: "relative", zIndex: 1,
        boxShadow: "0 10px 30px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.04) inset",
      }}>
        {plugin.manifest.icon ? (
          <img
            src={plugin.manifest.icon}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: 60, height: 60, objectFit: "contain" }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <Package size={44} style={{ color: "#333" }} />
        )}
      </div>
    </div>
  );
}
