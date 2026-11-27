import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LandingHeadline } from "../chat-view";

describe("LandingHeadline", () => {
  it("invites the user to talk to Fleetify on the Fleet hub", () => {
    render(<LandingHeadline />);
    expect(screen.getByRole("heading").textContent).toBe("Talk to Fleetify");
  });

  it("asks what the task is on the New session screen", () => {
    render(<LandingHeadline composing />);
    expect(screen.getByRole("heading").textContent).toBe("What are we working on?");
  });
});
