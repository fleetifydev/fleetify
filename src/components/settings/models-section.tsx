/**
 * Settings → Models section. Registry-driven replacement for the legacy
 * inline ModelsSection that lived in settings-page.tsx and shipped a
 * hard-coded MODELS / PROVIDERS array.
 *
 * Layout:
 *   API Providers
 *     OpenAI, DeepSeek, Grok, NVIDIA NIM, Kimi (Moonshot),
 *     Gemini API, Perplexity — one ProviderCard each.
 *   Local Models
 *     Ollama — OllamaConfigCard.
 *
 * Default-model picker (the old "round radio" UI) is intentionally
 * dropped here — the chat composer's per-session picker is the source
 * of truth now that we have 50+ models available. `defaultProvider` /
 * `defaultModel` semantics move into Settings → Agents.
 */
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { useProviderHealth } from "@/hooks/use-provider-health";
import { ProviderCard } from "./models/provider-card";
import { OllamaConfigCard } from "./models/ollama-config-card";
import { CloudflareConfigCard } from "./models/cloudflare-config-card";

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

export function ModelsSection() {
  const { tiles, loading } = useProvidersConfig();
  // Owns launch-time Ollama scan + parallel API-provider validation.
  // ProviderCard consumes `health.providers[id]` for its pill and calls
  // `health.refresh` after Save/Disconnect so the pill updates without a
  // page reload.
  const health = useProviderHealth({ tiles });

  if (loading) {
    return (
      <div style={{ fontSize: 13, color: "var(--c-low)", padding: "20px 0" }}>
        Loading models…
      </div>
    );
  }

  const cfTile = tiles.find((t) => t.spec.id === "cloudflare-workers-ai");
  const apiTiles = tiles.filter(
    (t) => t.spec.kind === "api" && t.spec.id !== "cloudflare-workers-ai",
  );
  const localTiles = tiles.filter((t) => t.spec.kind === "local_http");

  return (
    <>
      <div style={sectionHeader}>API Providers</div>
      {apiTiles.map((t) => (
        <ProviderCard
          key={t.spec.id}
          tile={t}
          health={health.providers[t.spec.id] ?? { kind: "no_key" }}
          onHealthChange={health.refresh}
        />
      ))}

      {cfTile && (
        <CloudflareConfigCard tile={cfTile} onHealthChange={health.refresh} />
      )}

      <div style={{ ...sectionHeader, marginTop: 22 }}>Local Models</div>
      {localTiles.map((t) => (
        <OllamaConfigCard
          key={t.spec.id}
          tile={t}
          health={health.ollama}
          onInstall={health.installOllama}
          onCancelInstall={health.cancelInstall}
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
        Keys are stored in your OS keychain — never on disk, never sent to Fleetify servers.
      </div>
    </>
  );
}
