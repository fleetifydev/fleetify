/**
 * BrowseTab — App-Store-style Discover surface.
 *
 *   Search (⌘K wired to focus)
 *   Hero spotlight
 *   Editor's picks       — horizontal scroll, narrow cards
 *   Build with code      — 3-col grid, wide cards
 *   Explore more         — 2-col grid, list cards
 *
 * Search mode short-circuits the curated layout into a flat results grid.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { usePluginStore } from "@/stores/plugin-store";
import type { CatalogPlugin, Provides } from "@/types/plugin";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import {
  PROVIDES_ORDER, PROVIDES_LABEL_EN, manifestProvides,
} from "@/types/plugin";
import { HeroCard } from "./HeroCard";
import { NarrowCard } from "./NarrowCard";
import { WideCard } from "./WideCard";
import { ListCard } from "./ListCard";

interface Props {
  onOpenDetail: (source_id: string, plugin_path: string) => void;
  onQuickInstall: (plugin: CatalogPlugin) => void;
}

export function BrowseTab({ onOpenDetail, onQuickInstall }: Props) {
  const catalog = usePluginStore(s => s.catalog);
  const sources = usePluginStore(s => s.sources);
  const loadingCatalog = usePluginStore(s => s.loadingCatalog);
  const loadingSources = usePluginStore(s => s.loadingSources);
  const refreshSources = usePluginStore(s => s.refreshSources);
  const error = usePluginStore(s => s.error);

  useEffect(() => {
    if (sources.length === 0 && !loadingSources) refreshSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [query, setQuery] = useState("");
  // Active content-type filters — OR semantics ("MCP or Skills").
  // Empty set means "no category filter applied" and the curated
  // discover layout takes over. Any selection switches to a flat
  // results grid, matching the search-mode behaviour.
  const [selectedProvides, setSelectedProvides] = useState<Set<Provides>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // Per-category counts across the FULL catalog — fixed even when a
  // filter is active so chips don't shuffle as the user selects them
  // (a count that changes with each click feels like quicksand). Spec
  // ``docs/provides.md`` example uses the same total-count behaviour.
  const providesCounts = useMemo(() => {
    const counts: Record<Provides, number> = {
      mcp: 0, skills: 0, prompts: 0,
      hooks: 0, subagents: 0, workflows: 0,
    };
    for (const p of catalog) {
      for (const v of manifestProvides(p.manifest)) counts[v]++;
    }
    return counts;
  }, [catalog]);

  // Filter is entirely client-side. Catalog is fetched once on mount
  // (MarketplacePage handles that) and refreshed only on explicit user
  // action, so every keystroke / chip click here just walks the
  // in-memory list — no network, no debounce, no mid-typing spinner.
  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hasCatFilter = selectedProvides.size > 0;
    if (!q && !hasCatFilter) return catalog;
    return catalog.filter(p => {
      const m = p.manifest;
      if (q) {
        const blob = (
          m.name + " " +
          (m.display_name ?? "") + " " +
          (m.description ?? "") + " " +
          (m.tags ?? []).join(" ")
        ).toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (hasCatFilter) {
        const prov = manifestProvides(m);
        // OR across selected categories — `[mcp, skills]` selected
        // means "anything with mcp OR skills". AND-style filtering
        // (must have ALL of them) is rarely what users want for a
        // 6-bucket taxonomy; if a power-user need surfaces later we
        // can add a modifier key to toggle the semantics.
        if (!prov.some(v => selectedProvides.has(v))) return false;
      }
      return true;
    });
  }, [catalog, query, selectedProvides]);

  // ⌘K / Ctrl-K to focus search. Real keyboard binding, not just a hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hero = useMemo(() => {
    const featured = catalog.filter(p => p.featured);
    return featured[0] ?? catalog[0] ?? null;
  }, [catalog]);

  const editorsPicks = useMemo(() => {
    return catalog.filter(p => p.featured && p !== hero).slice(0, 8);
  }, [catalog, hero]);

  // Build with code: tag-driven thematic shelf. Excludes anything
  // already rendered above so the user doesn't see the same plugin
  // appear in three sections.
  const buildWithCode = useMemo(() => {
    const above = new Set<CatalogPlugin>([...editorsPicks, ...(hero ? [hero] : [])]);
    const codeTags = new Set(["productivity", "infrastructure", "dev", "data"]);
    return catalog
      .filter(p => !above.has(p))
      .filter(p => p.manifest.tags?.some(t => codeTags.has(t)))
      .slice(0, 6);
  }, [catalog, hero, editorsPicks]);

  const exploreMore = useMemo(() => {
    const above = new Set<CatalogPlugin>([...editorsPicks, ...buildWithCode, ...(hero ? [hero] : [])]);
    return catalog.filter(p => !above.has(p));
  }, [catalog, hero, editorsPicks, buildWithCode]);

  // Any active filter (search OR category) collapses the curated
  // hero/picks/explore layout into a single flat result grid. Same
  // pattern Mac App Store / VS Code Marketplace use: the moment the
  // user narrows the list at all, the editorialised layout gets out
  // of the way.
  const searching = query.trim().length > 0 || selectedProvides.size > 0;

  const toggleProvide = (v: Provides) => {
    setSelectedProvides(prev => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
  };
  const clearProvides = () => setSelectedProvides(new Set());

  if (sources.length === 0 && loadingSources) {
    return <CenteredHint icon={<Loader2 size={12} className="spin" />} text="Loading sources…" />;
  }
  if (sources.length === 0 && !loadingSources) {
    return (
      <CenteredHint
        text="No marketplace sources yet."
        detail="Open Sources to add one — point it at any GitHub repo with a marketplace.json."
      />
    );
  }

  return (
    <div>
      {/* Search */}
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        padding: "8px 12px",
        background: "var(--c-srf)",
        border: "1px solid var(--c-brd)",
        borderRadius: 8,
        marginBottom: 22,
      }}>
        <Search size={12} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search plugins, skills, MCPs…"
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            color: "var(--c-high)", fontSize: 12,
          }}
        />
        <kbd style={{
          fontSize: 10, color: "var(--c-ghost)",
          fontFamily: "var(--font-mono)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 3, padding: "1px 5px",
        }}>{formatShortcut(["Mod", "K"])}</kbd>
      </div>

      {/* Category filter strip. Chips render in the order defined by
          PROVIDES_ORDER (matches docs/provides.md) so the layout is
          stable across reloads regardless of which categories the
          catalog happens to populate. A chip whose count is zero is
          rendered dimmed and disabled — leaves the affordance visible
          (so the user understands the full taxonomy) without letting
          them filter to an empty result set. */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 6,
        marginBottom: 22, alignItems: "center",
      }}>
        {PROVIDES_ORDER.map(v => {
          const count = providesCounts[v];
          const active = selectedProvides.has(v);
          const disabled = count === 0;
          return (
            <FilterPill
              key={v}
              label={PROVIDES_LABEL_EN[v]}
              count={count}
              active={active}
              disabled={disabled}
              onClick={() => !disabled && toggleProvide(v)}
            />
          );
        })}
        {selectedProvides.size > 0 && (
          <button
            onClick={clearProvides}
            style={{
              marginLeft: 4,
              padding: "3px 8px",
              fontSize: 11, color: "var(--c-dim)",
              background: "transparent",
              border: "1px dashed var(--c-brd)",
              borderRadius: 99,
              cursor: "pointer",
            }}
          >Clear</button>
        )}
      </div>

      {error && (
        <div style={{
          padding: "9px 12px",
          background: "rgba(248,113,113,0.08)",
          border: "1px solid rgba(248,113,113,0.40)",
          borderRadius: 8, fontSize: 12, color: "#f87171",
          marginBottom: 18,
        }}>{error}</div>
      )}

      {loadingCatalog && catalog.length === 0 && (
        <CenteredHint icon={<Loader2 size={12} className="spin" />} text="Loading catalog…" />
      )}

      {/* Filtered mode — flat list of matches, curated sections
          suppressed. Triggered by either text search OR an active
          category chip. The title reflects which kind of filter is
          driving the narrowing so the empty-state hint can be
          specific. */}
      {searching && (
        <Section
          title={query.trim().length > 0 ? "Results" : "Filtered"}
          count={filteredCatalog.length}
        >
          <Grid2Col>
            {filteredCatalog.map(p => (
              <ListCard
                key={k(p)}
                plugin={p}
                onClick={() => onOpenDetail(p.source_id, p.path)}
                onInstall={() => onQuickInstall(p)}
              />
            ))}
          </Grid2Col>
          {filteredCatalog.length === 0 && !loadingCatalog && (
            <CenteredHint
              text="No plugins match your filter."
              detail={
                query.trim().length > 0
                  ? "Try a different keyword or clear category filters."
                  : "Try a different category combination or clear the filter."
              }
            />
          )}
        </Section>
      )}

      {/* Discover mode */}
      {!searching && hero && (
        <div style={{ marginBottom: 28 }}>
          <HeroCard
            plugin={hero}
            onOpen={() => onOpenDetail(hero.source_id, hero.path)}
            onInstall={() => onQuickInstall(hero)}
          />
        </div>
      )}

      {!searching && editorsPicks.length > 0 && (
        <Section title="Editor's picks" subtitle="Hand-picked plugins worth trying.">
          <HorizScroll>
            {editorsPicks.map(p => (
              <NarrowCard
                key={k(p)}
                plugin={p}
                onClick={() => onOpenDetail(p.source_id, p.path)}
                onInstall={() => onQuickInstall(p)}
              />
            ))}
          </HorizScroll>
        </Section>
      )}

      {!searching && buildWithCode.length > 0 && (
        <Section title="Build with code" subtitle="Streamline your development workflow.">
          <Grid3Col>
            {buildWithCode.map(p => (
              <WideCard
                key={k(p)}
                plugin={p}
                onClick={() => onOpenDetail(p.source_id, p.path)}
                onInstall={() => onQuickInstall(p)}
              />
            ))}
          </Grid3Col>
        </Section>
      )}

      {!searching && exploreMore.length > 0 && (
        <Section title="Explore more" subtitle="Everything else in the catalog.">
          <Grid2Col>
            {exploreMore.map(p => (
              <ListCard
                key={k(p)}
                plugin={p}
                onClick={() => onOpenDetail(p.source_id, p.path)}
                onInstall={() => onQuickInstall(p)}
              />
            ))}
          </Grid2Col>
        </Section>
      )}
    </div>
  );
}

const k = (p: CatalogPlugin) => `${p.source_id}:${p.path}:${p.manifest.name}`;

/* ── Section primitive ─────────────────────────────────────────── */
function Section({
  title, subtitle, count, children,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{
        marginBottom: 12,
      }}>
        <h2 style={{
          margin: 0, padding: 0,
          fontSize: 10.5, fontWeight: 600,
          color: "var(--c-ghost)",
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          display: "flex", alignItems: "baseline", gap: 8,
        }}>
          <span>{title}</span>
          {count !== undefined && (
            <span style={{
              fontWeight: 500, letterSpacing: 0, textTransform: "none",
              fontFamily: "var(--font-mono)",
            }}>{count}</span>
          )}
        </h2>
        {subtitle && (
          <div style={{
            marginTop: 4,
            fontSize: 11.5, color: "var(--c-low)",
            lineHeight: 1.4,
          }}>{subtitle}</div>
        )}
      </div>
      {children}
    </section>
  );
}

function HorizScroll({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="scroll-subtle"
      style={{
        display: "grid",
        gridAutoFlow: "column",
        gridAutoColumns: "230px",
        gap: 10,
        overflowX: "auto",
        paddingBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function Grid3Col({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      gap: 10,
    }}>{children}</div>
  );
}

function Grid2Col({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      gap: 10,
    }}>{children}</div>
  );
}

/** Category filter chip — sits at the top of the Discover surface,
 *  one per `Provides` value. Renders three visual states: inactive
 *  (default), active (selected by the user, drives filteredCatalog),
 *  and disabled (no plugin in the catalog provides this category, so
 *  selecting it would yield an empty result). The disabled state
 *  stays visible so users see the full taxonomy at a glance. */
function FilterPill({
  label, count, active, disabled, onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 10px",
        fontSize: 11.5,
        fontWeight: active ? 600 : 500,
        color: disabled
          ? "var(--c-ghost)"
          : active ? "var(--card)" : "var(--c-high)",
        background: disabled
          ? "transparent"
          : active
            ? "var(--c-high)"
            : hover ? "var(--c-srf)" : "var(--sidebar)",
        border: "1px solid",
        borderColor: disabled
          ? "var(--sidebar-border)"
          : active ? "var(--c-high)" : "var(--c-brd)",
        borderRadius: 99,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "background 0.10s, color 0.10s, border-color 0.10s",
      }}
    >
      <span>{label}</span>
      <span style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        fontWeight: 500,
        // Inverted contrast pair when active so the count keeps its
        // readability against the filled chip background.
        color: active ? "var(--card)" : "var(--c-ghost)",
        opacity: active ? 0.75 : 1,
      }}>{count}</span>
    </button>
  );
}

function CenteredHint({
  icon, text, detail,
}: { icon?: React.ReactNode; text: string; detail?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "60px 20px", gap: 6,
      color: "var(--c-low)",
    }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
        {icon}
        <span>{text}</span>
      </div>
      {detail && (
        <div style={{
          fontSize: 11.5, color: "var(--c-ghost)",
          maxWidth: 380, textAlign: "center", lineHeight: 1.5,
        }}>{detail}</div>
      )}
    </div>
  );
}
