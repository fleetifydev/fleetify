import { describe, it, expect, beforeEach } from "vitest";
import {
  useFleetStore,
  AUTO_CHAIN_CAP,
  FLEET_COST_CAP_DEFAULT,
} from "../fleet-store";

// The Fleet co-pilot's safety guarantees live in these pure store
// actions: the auto-mode chain cap (so Fleet can't loop forever) and the
// cost cap (so it pauses before overspending). chat-view's auto-fire
// eligibility is gated on exactly this state, so these tests pin the
// behaviour the live loop depends on.
const SID = "test-session";

beforeEach(() => {
  localStorage.clear();
  // Reset the slice for our session so each test starts from defaults
  // (buildDefault lazy-reads localStorage, now cleared).
  useFleetStore.setState({ sessions: {}, decisions: [], reports: [] });
});

describe("fleet-store auto-chain cap", () => {
  it("bumpAutoChain increments and returns the new depth", () => {
    const s = useFleetStore.getState();
    expect(s.bumpAutoChain(SID)).toBe(1);
    expect(s.bumpAutoChain(SID)).toBe(2);
    expect(s.bumpAutoChain(SID)).toBe(3);
    expect(useFleetStore.getState().getSession(SID).autoChainDepth).toBe(3);
  });

  it("resetAutoChain returns depth to 0 (ask/done/user-send break the chain)", () => {
    const s = useFleetStore.getState();
    s.bumpAutoChain(SID);
    s.bumpAutoChain(SID);
    s.resetAutoChain(SID);
    expect(useFleetStore.getState().getSession(SID).autoChainDepth).toBe(0);
  });

  it("depth reaches AUTO_CHAIN_CAP after exactly CAP bumps (auto-fire then stops)", () => {
    const s = useFleetStore.getState();
    let depth = 0;
    for (let i = 0; i < AUTO_CHAIN_CAP; i++) depth = s.bumpAutoChain(SID);
    expect(depth).toBe(AUTO_CHAIN_CAP);
    // The (CAP+1)-th analyze sees depth === CAP, so `depth < CAP` is false
    // → not auto-eligible → the user gets a card instead of a loop.
    expect(useFleetStore.getState().getSession(SID).autoChainDepth).toBe(AUTO_CHAIN_CAP);
  });
});

describe("fleet-store cost cap", () => {
  it("recordCost pauses the session once spend reaches the cap", () => {
    const s = useFleetStore.getState();
    s.setMode(SID, "copilot");
    expect(useFleetStore.getState().isFleetLiveFor(SID)).toBe(true);
    // Spend right up to the default cap.
    s.recordCost(SID, FLEET_COST_CAP_DEFAULT);
    const sess = useFleetStore.getState().getSession(SID);
    expect(sess.status).toBe("paused");
    expect(useFleetStore.getState().isFleetLiveFor(SID)).toBe(false);
  });

  it("raising the cap above spend resumes Fleet (paused → idle)", () => {
    const s = useFleetStore.getState();
    s.setMode(SID, "copilot");
    s.recordCost(SID, FLEET_COST_CAP_DEFAULT);
    expect(useFleetStore.getState().getSession(SID).status).toBe("paused");
    s.setCostCap(SID, FLEET_COST_CAP_DEFAULT * 2);
    const sess = useFleetStore.getState().getSession(SID);
    expect(sess.status).toBe("idle");
    expect(useFleetStore.getState().isFleetLiveFor(SID)).toBe(true);
  });

  it("resetCost clears spend and unpauses", () => {
    const s = useFleetStore.getState();
    s.setMode(SID, "auto");
    s.recordCost(SID, FLEET_COST_CAP_DEFAULT);
    expect(useFleetStore.getState().getSession(SID).status).toBe("paused");
    s.resetCost(SID);
    const sess = useFleetStore.getState().getSession(SID);
    expect(sess.costSpent).toBe(0);
    expect(sess.status).toBe("idle");
  });
});

describe("fleet-store isFleetLiveFor gating", () => {
  it("manual mode is never live", () => {
    expect(useFleetStore.getState().isFleetLiveFor(SID)).toBe(false);
  });

  it("non-manual mode under cap is live", () => {
    useFleetStore.getState().setMode(SID, "refine-only");
    expect(useFleetStore.getState().isFleetLiveFor(SID)).toBe(true);
  });
});
