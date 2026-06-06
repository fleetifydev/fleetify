import { describe, it, expect } from "vitest";

import {
  openPrs,
  setPrs,
  upsertPr,
  removePr,
  nextOpenAfter,
  type RepoPr,
} from "@/stores/pr-store";

const pr = (number: number, state = "OPEN", extra: Partial<RepoPr> = {}): RepoPr => ({
  number,
  state,
  headRefName: `fleet/x-${number}`,
  ...extra,
});

describe("pr-store reducer", () => {
  it("openPrs keeps only OPEN, newest first", () => {
    const list = [pr(1), pr(3, "MERGED"), pr(5), pr(2, "closed")];
    expect(openPrs(list).map((p) => p.number)).toEqual([5, 1]);
  });

  it("setPrs dedupes by number (server wins)", () => {
    const list = [pr(7), pr(7, "OPEN", { title: "dup" }), pr(8)];
    expect(setPrs([], list).map((p) => p.number)).toEqual([7, 8]);
  });

  it("upsertPr inserts new and updates existing by number", () => {
    const start = [pr(1), pr(2)];
    const inserted = upsertPr(start, pr(3));
    expect(inserted.map((p) => p.number).sort()).toEqual([1, 2, 3]);
    const updated = upsertPr(start, pr(2, "OPEN", { title: "edited" }));
    expect(updated.filter((p) => p.number === 2)).toHaveLength(1);
    expect(updated.find((p) => p.number === 2)?.title).toBe("edited");
  });

  it("removePr drops the merged PR", () => {
    expect(removePr([pr(1), pr(2)], 1).map((p) => p.number)).toEqual([2]);
  });

  it("nextOpenAfter returns the newest remaining OPEN PR, else null", () => {
    const list = [pr(10), pr(4), pr(7, "MERGED")];
    // After merging #10, the next open is #4 (7 is merged).
    expect(nextOpenAfter(list, 10)?.number).toBe(4);
    // After merging the only open one, none remain.
    expect(nextOpenAfter([pr(10), pr(7, "MERGED")], 10)).toBeNull();
  });
});
