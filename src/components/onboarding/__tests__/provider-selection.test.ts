import { describe, it, expect } from "vitest";
import { buildSelectionPersist } from "@/components/onboarding/provider-selection";

describe("buildSelectionPersist", () => {
  const all = ["claude", "codex", "openai", "ollama", "cursor"];
  const cliAgentIds = ["claude", "codex", "cursor"]; // backend CLI kinds

  it("maps every provider id to its selected state (selected true, rest false)", () => {
    const { connected } = buildSelectionPersist(all, ["claude", "openai"], cliAgentIds);
    expect(connected).toEqual({
      claude: true,
      codex: false,
      openai: true,
      ollama: false,
      cursor: false,
    });
  });

  it("includes only the selected CLI agents in enabledAgents", () => {
    const { enabledAgents } = buildSelectionPersist(all, ["claude", "openai", "cursor"], cliAgentIds);
    expect(enabledAgents.sort()).toEqual(["claude", "cursor"]);
  });

  it("returns an empty enabledAgents list when no CLI agent is selected", () => {
    const { enabledAgents } = buildSelectionPersist(all, ["openai", "ollama"], cliAgentIds);
    expect(enabledAgents).toEqual([]);
  });
});
