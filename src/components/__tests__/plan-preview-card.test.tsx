import { it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanPreviewCard } from "@/components/dashboard/fleet-panel/plan-preview-card";

it("removes a row and confirms only the remaining dispatches", () => {
  const onConfirm = vi.fn();
  render(
    <PlanPreviewCard
      dispatches={[
        { target_id: "a", task: "do a" },
        { target_id: "b", task: "do b" },
      ]}
      summary="two tasks"
      onConfirm={onConfirm}
      onCancel={() => {}}
      titleFor={(id) => id}
    />,
  );
  // Drop the first row, then dispatch the rest.
  fireEvent.click(screen.getAllByLabelText("Remove dispatch")[0]);
  fireEvent.click(screen.getByText(/Dispatch all/i));
  expect(onConfirm).toHaveBeenCalledWith([{ target_id: "b", task: "do b" }]);
});

it("shows the summary and no confirm button for an empty plan", () => {
  render(
    <PlanPreviewCard
      dispatches={[]}
      summary="no agent fits"
      onConfirm={() => {}}
      onCancel={() => {}}
      titleFor={(id) => id}
    />,
  );
  expect(screen.getByText("no agent fits")).toBeInTheDocument();
  expect(screen.queryByText(/Dispatch all/i)).toBeNull();
});
