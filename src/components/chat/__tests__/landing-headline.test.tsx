import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LandingHeadline } from "../chat-view";

describe("LandingHeadline", () => {
  it("renders the fixed Talk to Fleetify headline", () => {
    render(<LandingHeadline />);
    expect(screen.getByText("Talk to Fleetify")).toBeTruthy();
  });
});
