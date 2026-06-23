import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelChip } from "../chat-input";

vi.mock("@/components/ui/provider-logo", () => ({ ProviderLogo: () => <span data-testid="logo" /> }));

it("renders logo + model label + effort, and is the model dropdown trigger", () => {
  render(<ModelChip modelLabel="Opus 4.8" effort="high" tool="claude-code" open={false} onToggle={() => {}} />);
  expect(screen.getByTestId("logo")).toBeTruthy();
  expect(screen.getByText("Opus 4.8")).toBeTruthy();
  expect(screen.getByText(/high/i)).toBeTruthy();           // effortLabel("high")
  expect(screen.getByRole("button")).toHaveAttribute("data-model-trigger", "1");
});
