/**
 * Offline defaults guard.
 *
 * A first launch that can't reach the model catalog takes its models from
 * defaults built into the app. The embedded catalog snapshot
 * (crates/fleetify-backend/assets/models-snapshot.json) supplies per-model
 * effort, not those model lists, but it records each provider's catalog
 * default. This test holds the built-in defaults to it:
 *
 * - Claude Code: the composer picker's fallback default, the composer's model
 *   table, the New Agent dialog's `most_capable` tier, the welcome card's
 *   labels and the /compact summariser (compactor.rs);
 * - Anthropic API: the first model of its built-in list (catalog.rs).
 *
 * Refreshing the snapshot (docs/REMOTE_MODEL_CATALOG.md §3) fails this test
 * until those follow. Only the default moves: earlier defaults keep their
 * labels for the sessions that still use them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TIER_TO_MODEL } from "@/components/agent/new-agent-dialog";
import { CLAUDE_DEFAULT_MODEL } from "@/components/chat/chat-input";
import { WELCOME_MODEL_LABELS } from "@/components/chat/chat-view";
import { buildPickerGroups, resolveStartupDefault } from "@/lib/picker-groups";

interface SnapshotModel {
  id: string;
  label: string;
  default?: boolean;
}

/** A file in the repository, as text. */
const repoFile = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const snapshot = JSON.parse(repoFile("crates/fleetify-backend/assets/models-snapshot.json")) as {
  schemaVersion: number;
  providers: Record<string, { models: SnapshotModel[] }>;
};

/** The models a provider's snapshot entry flags as its default. */
const defaultsOf = (provider: string) => snapshot.providers[provider]?.models.filter((m) => m.default) ?? [];

const claudeCodeDefaults = defaultsOf("claude-code");
const snapshotDefault: SnapshotModel = claudeCodeDefaults[0] ?? { id: "(no claude-code default)", label: "" };

describe("the built-in Claude Code default matches the catalog snapshot", () => {
  it("the snapshot flags exactly one Claude Code default", () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(claudeCodeDefaults.map((m) => m.id)).toHaveLength(1);
  });

  it("the composer picker's Claude Code fallback flags it as the default", () => {
    const claude = buildPickerGroups([], []).find((g) => g.id === "claude-code");
    const flagged = claude?.models.filter((m) => m.default) ?? [];
    expect(flagged.map((m) => m.id)).toEqual([snapshotDefault.id]);
    expect(flagged[0]?.label).toBe(snapshotDefault.label);
    // With nothing loaded, the Fleet hub seeds that same model.
    expect(resolveStartupDefault([], null)).toEqual({ tool: "claude-code", model: snapshotDefault.id });
  });

  it("the composer's Claude model table names it as the default", () => {
    expect(CLAUDE_DEFAULT_MODEL.id).toBe(snapshotDefault.id);
    expect(CLAUDE_DEFAULT_MODEL.label).toBe(snapshotDefault.label);
  });

  it("the New Agent dialog's most capable Claude Code tier is it", () => {
    expect(TIER_TO_MODEL["claude-code"]?.most_capable).toBe(snapshotDefault.id);
  });

  it("the welcome card has a label for it", () => {
    expect(WELCOME_MODEL_LABELS[snapshotDefault.id]).toBe(snapshotDefault.label);
  });

  it("the /compact summariser runs it", () => {
    const compactor = repoFile("crates/fleetify-backend/src/services/compactor.rs");
    const model = /const SUMMARIZER_MODEL: &str = "([^"]+)";/.exec(compactor)?.[1];
    expect(model, "SUMMARIZER_MODEL in compactor.rs").toBe(snapshotDefault.id);
  });
});

describe("the built-in Anthropic API default matches the catalog snapshot", () => {
  it("the Anthropic API's built-in list starts with the snapshot's anthropic default", () => {
    const anthropicDefaults = defaultsOf("anthropic");
    expect(anthropicDefaults.map((m) => m.id)).toHaveLength(1);
    const catalog = repoFile("crates/fleetify-backend/src/providers/catalog.rs");
    const list = /const ANTHROPIC_API_MODELS: &\[ModelSpec\] = &\[([\s\S]*?)\n\];/.exec(catalog)?.[1] ?? "";
    const first = /id: "([^"]+)"/.exec(list)?.[1];
    expect(first, "first model of ANTHROPIC_API_MODELS in catalog.rs").toBe(anthropicDefaults[0]?.id);
  });
});
