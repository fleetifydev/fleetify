import { describe, it, expect } from "vitest";
import { resolveStripSelection, shouldAutoNextRound, isEmptyDiffBlocked, prAffordancesEnabled, resolveGithubConnected, isAuthFailureCode } from "../branch-strip";
import type { PRStatus } from "@/lib/git-api";

/** Minimal PRStatus fixture — only the fields the strip selection reads. */
const mkPr = (over: Partial<PRStatus> & { number: number; headRefName: string }): PRStatus => ({
  url: `https://github.com/o/r/pull/${over.number}`,
  state: "OPEN",
  mergeable: "MERGEABLE",
  isDraft: false,
  baseRefName: "main",
  checks: { passing: 1, failing: 0, pending: 0, total: 1 },
  commentsCount: 0,
  ...over,
});

describe("resolveStripSelection", () => {
  // The hazard the task guards against: a worktree session whose repo has a
  // FOREIGN open PR (#9) sitting first in the store (newest), plus the
  // session's OWN open PR (#7). The repo-wide fallback would retarget #9;
  // worktree mode must collapse the selection to #7 and hide the switcher.
  const ownPr = mkPr({ number: 7, headRefName: "fleet/foo-abc123" });
  const foreignPr = mkPr({ number: 9, headRefName: "other/thing-deadbeef" });

  it("worktree: binds to the branch's OWN open PR even when a foreign PR is first/selected", () => {
    const r = resolveStripSelection({
      isWorktree: true,
      pr: ownPr,
      branchOpenPr: ownPr,
      // Repo-wide derivation already (wrongly) resolved to the foreign #9.
      effectiveSelectedNumber: 9,
      selectedIsBranchPr: false,
      selectedRepoPr: foreignPr,
      // Foreign-PR detail poll is short-circuited in worktree mode, but even
      // if it leaked a value the override must ignore it.
      foreignPr,
    });
    expect(r.showSwitcher).toBe(false);
    expect(r.effSelectedNumber).toBe(7);
    expect(r.effSelectedIsBranchPr).toBe(true);
    expect(r.effSelectedPr).toBe(ownPr);
    expect(r.effSelectedPr?.number).toBe(7);
    // The merge-cluster gate must point at the OWN pr, never the foreign one.
    expect(r.effSelectedRepoPr).toBe(ownPr);
    expect(r.effSelectedRepoPr?.number).not.toBe(9);
  });

  it("worktree with NO own PR yet: number falls back to pr, switcher hidden, nothing foreign", () => {
    const r = resolveStripSelection({
      isWorktree: true,
      pr: null,
      branchOpenPr: null,
      effectiveSelectedNumber: 9, // foreign-only repo state
      selectedIsBranchPr: false,
      selectedRepoPr: foreignPr,
      foreignPr,
    });
    expect(r.showSwitcher).toBe(false);
    // No own PR → no merge target at all (never the foreign one).
    expect(r.effSelectedNumber).toBeNull();
    expect(r.effSelectedPr).toBeNull();
    expect(r.effSelectedRepoPr).toBeNull();
    expect(r.effSelectedIsBranchPr).toBe(true);
  });

  it("worktree: an OPEN draft own PR drives the cluster (branchOpenPr = the draft)", () => {
    const draftOwn = mkPr({ number: 7, headRefName: "fleet/foo-abc123", isDraft: true });
    const r = resolveStripSelection({
      isWorktree: true,
      pr: draftOwn,
      branchOpenPr: draftOwn, // OPEN (draft is still OPEN) → in the gate
      effectiveSelectedNumber: null,
      selectedIsBranchPr: false,
      selectedRepoPr: null,
      foreignPr: null,
    });
    expect(r.showSwitcher).toBe(false);
    expect(r.effSelectedNumber).toBe(7);
    expect(r.effSelectedPr).toBe(draftOwn);
    expect(r.effSelectedRepoPr).toBe(draftOwn);
  });

  it("worktree: a CLOSED/MERGED own PR is NOT a merge-cluster gate (effSelectedRepoPr null)", () => {
    // A merged branch PR isn't OPEN, so branchOpenPr is null. The cluster
    // gate must be null so the MERGED state's Sync-main pair renders instead
    // of a dead Open·#N + Merge pair — same invariant as off-worktree, where
    // selectedRepoPr comes from the OPEN-only openPrsList.
    const mergedOwn = mkPr({ number: 7, headRefName: "fleet/foo-abc123", state: "MERGED" });
    const r = resolveStripSelection({
      isWorktree: true,
      pr: mergedOwn,
      branchOpenPr: null, // MERGED is not OPEN
      effectiveSelectedNumber: 9,
      selectedIsBranchPr: false,
      selectedRepoPr: foreignPr, // repo has a foreign open PR
      foreignPr,
    });
    expect(r.showSwitcher).toBe(false);
    // effSelectedNumber may still be the merged PR's number (feeds nothing
    // visible — switcher hidden), but the cluster gate must be null and the
    // foreign PR must never leak through.
    expect(r.effSelectedRepoPr).toBeNull();
    expect(r.effSelectedPr).toBe(mergedOwn);
    expect(r.effSelectedPr?.number).not.toBe(9);
  });

  // ── Off-worktree: the existing repo-wide selection MUST be byte-identical ──
  it("non-worktree: preserves the repo-wide foreign selection unchanged", () => {
    const r = resolveStripSelection({
      isWorktree: false,
      pr: ownPr,
      branchOpenPr: ownPr,
      effectiveSelectedNumber: 9,
      selectedIsBranchPr: false,
      selectedRepoPr: foreignPr,
      foreignPr,
    });
    // Switcher shows whenever there's a selected number (the component also
    // gates on openPrsList.length > 0, unchanged).
    expect(r.showSwitcher).toBe(true);
    expect(r.effSelectedNumber).toBe(9);
    expect(r.effSelectedIsBranchPr).toBe(false);
    // selectedPr for a foreign selection is the foreign-poll result.
    expect(r.effSelectedPr).toBe(foreignPr);
    expect(r.effSelectedRepoPr).toBe(foreignPr);
  });

  it("non-worktree: a branch-own selection resolves selectedPr to pr (not foreignPr)", () => {
    const r = resolveStripSelection({
      isWorktree: false,
      pr: ownPr,
      branchOpenPr: ownPr,
      effectiveSelectedNumber: 7,
      selectedIsBranchPr: true,
      selectedRepoPr: ownPr,
      foreignPr: null,
    });
    expect(r.showSwitcher).toBe(true);
    expect(r.effSelectedNumber).toBe(7);
    expect(r.effSelectedIsBranchPr).toBe(true);
    expect(r.effSelectedPr).toBe(ownPr);
    expect(r.effSelectedRepoPr).toBe(ownPr);
  });

  it("non-worktree with no selection: showSwitcher false (no number to show)", () => {
    const r = resolveStripSelection({
      isWorktree: false,
      pr: null,
      branchOpenPr: null,
      effectiveSelectedNumber: null,
      selectedIsBranchPr: false,
      selectedRepoPr: null,
      foreignPr: null,
    });
    expect(r.showSwitcher).toBe(false);
    expect(r.effSelectedNumber).toBeNull();
    expect(r.effSelectedPr).toBeNull();
    expect(r.effSelectedRepoPr).toBeNull();
  });
});

describe("shouldAutoNextRound", () => {
  // The exact guard the PR poll evaluates each tick to decide whether a LIVE
  // external merge (we observed OPEN, now MERGED, on our own worktree branch)
  // should auto-advance the session to a fresh round. Pure so the branching
  // logic is unit-tested without standing up the whole electronAPI surface.
  const base = {
    isWorktree: true,
    prevState: "OPEN" as string | null,
    incomingState: "MERGED" as string | null,
    incomingHeadRef: "fleet/foo-abc123" as string | null,
    ctxBranch: "fleet/foo-abc123" as string | null,
    syncing: false,
    justMerged: false,
    isStreaming: false,
  };

  it("A — LIVE EXTERNAL MERGE: fires on OPEN→MERGED for our own branch when idle", () => {
    expect(shouldAutoNextRound(base)).toBe(true);
  });

  it("B — BOOT-INTO-MERGED: does NOT fire when there was no prior OPEN (prevState null)", () => {
    // First poll already returns MERGED; the manual "Start next round" button
    // owns this case. Auto-fire would surprise the user who just opened a
    // long-since-merged session.
    expect(shouldAutoNextRound({ ...base, prevState: null })).toBe(false);
    // Equally, a MERGED→MERGED steady state (prev already MERGED) must not fire.
    expect(shouldAutoNextRound({ ...base, prevState: "MERGED" })).toBe(false);
  });

  it("C — IDLE GATE: does NOT fire while the session is streaming", () => {
    expect(shouldAutoNextRound({ ...base, isStreaming: true })).toBe(false);
  });

  it("does NOT fire off-worktree (off-worktree keeps the Sync-main path)", () => {
    expect(shouldAutoNextRound({ ...base, isWorktree: false })).toBe(false);
  });

  it("does NOT fire when the merged PR's head ref isn't our working branch", () => {
    expect(shouldAutoNextRound({ ...base, incomingHeadRef: "other/thing-deadbeef" })).toBe(false);
  });

  it("does NOT fire when the head ref can't be matched (null ctx branch or null head)", () => {
    expect(shouldAutoNextRound({ ...base, ctxBranch: null })).toBe(false);
    expect(shouldAutoNextRound({ ...base, incomingHeadRef: null })).toBe(false);
  });

  it("does NOT fire while a sync/carve is already in flight", () => {
    expect(shouldAutoNextRound({ ...base, syncing: true })).toBe(false);
  });

  it("does NOT fire when justMerged is set (an app-merge carve is already running)", () => {
    // onMerge's own-branch path triggers the carve directly + sets justMerged;
    // the poll must not double-fire on the same MERGED observation.
    expect(shouldAutoNextRound({ ...base, justMerged: true })).toBe(false);
  });

  it("does NOT fire when the incoming PR isn't MERGED (e.g. CLOSED)", () => {
    expect(shouldAutoNextRound({ ...base, incomingState: "CLOSED" })).toBe(false);
    expect(shouldAutoNextRound({ ...base, incomingState: null })).toBe(false);
  });
});

describe("isEmptyDiffBlocked", () => {
  // The bug: a freshly-carved worktree session lives on a dedicated fleet/…
  // feature branch (NOT noGit, NOT on the default branch → isBootstrapShape
  // false) whose `{base}...HEAD` commit-range diff is 0 until the first
  // commit. The old inline gate empty-diff-blocked it and hid Create PR +
  // Review — while off-worktree bootstrap sessions (on the default branch
  // with a plannedBranch) showed them immediately. Parity: a worktree
  // session must NOT be empty-diff-blocked.
  it("worktree + empty diff: NOT blocked (the bug being fixed)", () => {
    expect(isEmptyDiffBlocked({
      isBootstrapShape: false,
      isWorktree: true,
      plus: 0,
      minus: 0,
    })).toBe(false);
  });

  it("non-worktree feature branch + empty diff: still blocked (unchanged)", () => {
    expect(isEmptyDiffBlocked({
      isBootstrapShape: false,
      isWorktree: false,
      plus: 0,
      minus: 0,
    })).toBe(true);
  });

  it("non-worktree + nonzero diff: NOT blocked", () => {
    expect(isEmptyDiffBlocked({
      isBootstrapShape: false,
      isWorktree: false,
      plus: 42,
      minus: 3,
    })).toBe(false);
  });

  it("bootstrap shape + empty diff: NOT blocked (unchanged)", () => {
    expect(isEmptyDiffBlocked({
      isBootstrapShape: true,
      isWorktree: false,
      plus: 0,
      minus: 0,
    })).toBe(false);
  });
});

describe("prAffordancesEnabled", () => {
  // The whole point of the gate: the PR affordances (Create PR, Review,
  // auto-PR, PR-status poll) require BOTH a git context AND a Fleetify
  // GitHub connection. The merge cluster + PR switcher + branchOpenPr are
  // already gated on githubConnected; these were leaking through without it.
  it("connected + git → enabled", () => {
    expect(prAffordancesEnabled(true, false)).toBe(true);
  });

  it("no GitHub connection → disabled (the leak being fixed)", () => {
    // gh may be authed on the machine independently of Settings, but without
    // the Fleetify connection the strip must show only branches.
    expect(prAffordancesEnabled(false, false)).toBe(false);
  });

  it("no git → disabled even when GitHub is connected", () => {
    expect(prAffordancesEnabled(true, true)).toBe(false);
  });

  it("neither git nor GitHub → disabled", () => {
    expect(prAffordancesEnabled(false, true)).toBe(false);
  });
});

describe("resolveGithubConnected", () => {
  // New model: githubConnected = (NOT explicitly disabled) AND
  // (Fleetify OAuth/Settings flag set OR gh CLI authed locally). Recognizing a
  // locally-authed `gh` avoids forcing a redundant second connection — the
  // backend already falls back to gh for PR ops.
  it("Fleetify flag set (no gh CLI) → connected", () => {
    expect(resolveGithubConnected({ disabled: false, flagConnected: true, ghCliAuthed: false })).toBe(true);
  });

  it("gh CLI authed alone (no Fleetify flag) → connected (the new behavior)", () => {
    expect(resolveGithubConnected({ disabled: false, flagConnected: false, ghCliAuthed: true })).toBe(true);
  });

  it("neither flag nor gh CLI → not connected", () => {
    expect(resolveGithubConnected({ disabled: false, flagConnected: false, ghCliAuthed: false })).toBe(false);
  });

  it("explicitly disabled wins even when both signals are present", () => {
    expect(resolveGithubConnected({ disabled: true, flagConnected: true, ghCliAuthed: true })).toBe(false);
  });
});

describe("isAuthFailureCode", () => {
  // The classifier that decides whether a PR-op failure means the GitHub auth
  // is genuinely dead (logged out / expired) — in which case the strip resets
  // its connection state — versus a transient blip (network/HTTP/merge-blocked)
  // that must be tolerated so a momentary failure never tears down a valid
  // connection. ONLY the three auth-failure codes return true.
  it("returns true for the three auth-failure codes", () => {
    expect(isAuthFailureCode("AUTH_FAILED")).toBe(true);
    expect(isAuthFailureCode("NO_AUTH")).toBe(true);
    expect(isAuthFailureCode("AUTH_EXPIRED")).toBe(true);
  });

  it("returns false for transient / non-auth codes", () => {
    expect(isAuthFailureCode("NETWORK")).toBe(false);
    expect(isAuthFailureCode("HTTP")).toBe(false);
    expect(isAuthFailureCode("MERGE_BLOCKED")).toBe(false);
  });

  it("returns false for undefined / null / empty (no code → not an auth failure)", () => {
    expect(isAuthFailureCode(undefined)).toBe(false);
    expect(isAuthFailureCode(null)).toBe(false);
    expect(isAuthFailureCode("")).toBe(false);
  });
});
