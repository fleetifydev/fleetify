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
});
