import { describe, it, expect } from "vitest";
import { buildSelectionPersist } from "@/components/onboarding/provider-selection";

describe("buildSelectionPersist", () => {
  const all = ["claude-code", "codex-cli", "openai", "ollama", "cursor-cli"];
  const cliAgentIds = ["claude-code", "codex-cli", "cursor-cli"]; // backend CLI kinds

  it("maps every provider id to its selected state (selected true, rest false)", () => {
    const { connected } = buildSelectionPersist(all, ["claude-code", "openai"], cliAgentIds);
    expect(connected).toEqual({
      "claude-code": true,
      "codex-cli": false,
      openai: true,
      ollama: false,
      "cursor-cli": false,
    });
  });

  it("includes only the selected CLI agents in enabledAgents", () => {
    const { enabledAgents } = buildSelectionPersist(all, ["claude-code", "openai", "cursor-cli"], cliAgentIds);
    expect(enabledAgents.sort()).toEqual(["claude-code", "cursor-cli"]);
  });

  it("returns an empty enabledAgents list when no CLI agent is selected", () => {
    const { enabledAgents } = buildSelectionPersist(all, ["openai", "ollama"], cliAgentIds);
    expect(enabledAgents).toEqual([]);
  });

  it("keeps ollama-cloud connected when selected, independent of the local ollama row", () => {
    // ollama-cloud is the hosted API sibling of the local `ollama` daemon.
    // Selecting one must not drag the other along, and the cloud row — being
    // kind:"api", not a CLI agent — never lands in enabledAgents.
    const withCloud = [...all, "ollama-cloud"];
    const cloudOnly = buildSelectionPersist(withCloud, ["ollama-cloud"], cliAgentIds);
    expect(cloudOnly.connected["ollama-cloud"]).toBe(true);
    expect(cloudOnly.connected.ollama).toBe(false);
    expect(cloudOnly.enabledAgents).toEqual([]);

    const localOnly = buildSelectionPersist(withCloud, ["ollama"], cliAgentIds);
    expect(localOnly.connected["ollama-cloud"]).toBe(false);
    expect(localOnly.connected.ollama).toBe(true);
  });
});
