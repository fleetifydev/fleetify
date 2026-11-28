import { describe, expect, it } from "vitest";
import { buildColumns, layoutBranches, nodeState, TREE, type BranchInput, type TreeSession } from "../roots-layout";

const s = (id: string, project: string, state: TreeSession["state"], parentId: string | null = null, createdAt = 0): TreeSession =>
  ({ id, project, state, parentId, createdAt });

describe("nodeState", () => {
  it("treats a pending question as needs, whatever the status", () => {
    expect(nodeState("running", true, true)).toBe("needs");
    expect(nodeState("waiting", false, false)).toBe("needs");
  });
  it("flags errors as failed, streaming as working, the rest as done", () => {
    expect(nodeState("error", false, false)).toBe("failed");
    expect(nodeState("idle", false, true)).toBe("working");
    expect(nodeState("idle", false, false)).toBe("done");
  });
});

describe("buildColumns", () => {
  it("keeps a column in the order its sessions started, whatever their state, and folds finished work", () => {
    const [col] = buildColumns([s("d", "api", "done", null, 1), s("w", "api", "working", null, 2), s("n", "api", "needs", null, 3)]);
    expect(col!.rows.map(r => r.id)).toEqual(["w", "n"]);
    expect(col!.doneFolded).toBe(1);
  });

  it("does not reorder a column when a state changes, so nothing jumps", () => {
    const before = buildColumns([s("a", "api", "working", null, 1), s("b", "api", "working", null, 2)])[0]!.rows.map(r => r.id);
    const after = buildColumns([s("a", "api", "working", null, 1), s("b", "api", "needs", null, 2)])[0]!.rows.map(r => r.id);
    expect(after).toEqual(before);
  });

  it("shows finished work when the project is expanded or has nothing live", () => {
    expect(buildColumns([s("d", "api", "done", null, 1), s("w", "api", "working", null, 2)], new Set(["api"]))[0]!.rows.map(r => r.id)).toEqual(["d", "w"]);
    expect(buildColumns([s("d", "blog", "done")])[0]!.rows.map(r => r.id)).toEqual(["d"]);
  });

  it("hangs a started session under the session that started it", () => {
    const [col] = buildColumns([s("child", "api", "working", "par", 2), s("par", "api", "needs", null, 1), s("other", "api", "working", null, 3)]);
    expect(col!.rows).toEqual([
      { id: "par", state: "needs", depth: 0, parent: null },
      { id: "child", state: "working", depth: 1, parent: "par" },
      { id: "other", state: "working", depth: 0, parent: null },
    ]);
  });

  it("keeps a finished parent that still holds live work", () => {
    const [col] = buildColumns([s("par", "api", "done"), s("kid", "api", "working", "par")]);
    expect(col!.rows.map(r => [r.id, r.depth])).toEqual([["par", 0], ["kid", 1]]);
  });

  it("survives a parent_id cycle", () => {
    const [col] = buildColumns([s("a", "api", "working", "b"), s("b", "api", "working", "a")]);
    expect(col!.rows.map(r => r.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps projects in the order they started, whatever needs the user", () => {
    expect(buildColumns([s("x", "docs", "done", null, 1), s("y", "web", "working", null, 2), s("z", "api", "failed", null, 3)]).map(c => c.project)).toEqual(["docs", "web", "api"]);
  });
});

describe("layoutBranches", () => {
  const box = (w: number, h: number) => ({ w, h });
  const input: BranchInput = {
    W: 1200, H: 800, hub: box(280, 300),
    columns: [
      { project: "client-api", head: box(90, 26), rows: [{ id: "refund", depth: 0, box: box(270, 170) }, { id: "second", depth: 1, box: box(250, 110) }], fold: box(80, 24) },
      { project: "pay-sdk", head: box(70, 26), rows: [{ id: "auth", depth: 0, box: box(270, 130) }, { id: "typed", depth: 0, box: box(270, 110) }] },
      { project: "docs-site", head: box(84, 26), rows: [{ id: "links", depth: 0, box: box(270, 110) }] },
    ],
  };
  const out = layoutBranches(input);
  const hub = out.hub;

  it("keeps a project on its side when its cards change size", () => {
    const grown = layoutBranches({ ...input, columns: input.columns.map(c => c.project === "client-api" ? { ...c, rows: c.rows.map(r => ({ ...r, box: box(400, 900) })) } : c) });
    expect(grown.sides).toEqual(out.sides);
  });

  it("centres the hub and splits projects to both sides in order", () => {
    expect(hub.x + hub.w / 2).toBe(out.width / 2);
    expect(out.sides["client-api"]).toBe("left");
    expect(out.sides["pay-sdk"]).toBe("right");
    // docs-site goes to whichever side is shorter
    expect(out.sides["docs-site"]).toBe("right");
  });

  it("keeps every card off the hub and grows each side outward", () => {
    for (const [id, r] of Object.entries(out.rows)) {
      const side = id === "refund" || id === "second" ? "left" : "right";
      if (side === "left") expect(r.x + r.w).toBeLessThanOrEqual(hub.x - TREE.rootGap);
      else expect(r.x).toBeGreaterThanOrEqual(hub.x + hub.w + TREE.rootGap);
    }
    const p = out.rows.refund!, c = out.rows.second!;
    expect(p.x + p.w - (c.x + c.w)).toBe(TREE.indent);
    expect(c.y).toBe(p.y + p.h + TREE.rowGap);
  });

  it("stacks projects on a side without overlap", () => {
    const typed = out.rows.typed!, docs = out.heads["docs-site"]!;
    expect(typed.y + typed.h).toBeLessThan(docs.y);
    expect(out.height).toBeGreaterThan(out.rows.links!.y + out.rows.links!.h);
  });

  it("keeps the hub and the other side still when a card grows", () => {
    const grown = layoutBranches({ ...input, columns: input.columns.map(c => c.project === "client-api" ? { ...c, rows: c.rows.map(r => r.id === "refund" ? { ...r, box: box(270, 600) } : r) } : c) });
    expect(grown.hub).toEqual(out.hub);
    expect(grown.rows.auth).toEqual(out.rows.auth);
    expect(grown.rows.refund!.y).toBe(out.rows.refund!.y);
    expect(grown.rows.second!.y).toBeGreaterThan(out.rows.second!.y);
  });
});
