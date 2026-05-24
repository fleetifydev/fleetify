import { GitHubIntegrationTile } from "./integrations/github-integration-tile";

export function IntegrationsSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{
        fontSize: 13, color: "var(--c-low)",
        marginBottom: 16, lineHeight: 1.55,
      }}>
        Connect external services Fleetify can act on for you.
      </div>
      <GitHubIntegrationTile />
      {/* Future: GitLabTile, LinearTile, SlackTile, ... */}
    </div>
  );
}
