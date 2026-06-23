import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSessionGitContext } from "../use-session-git-context";

const getWorkingDiff = vi.fn();
const win = () => window as unknown as Record<string, unknown>;

beforeEach(() => {
  getWorkingDiff.mockReset();
  win().electronAPI = { getWorkingDiff };
});
afterEach(() => { delete win().electronAPI; });

it("does not fetch while disabled", () => {
  renderHook(() => useSessionGitContext("/p/dis", false));
  expect(getWorkingDiff).not.toHaveBeenCalled();
});

it("returns branch + the live working-tree diff when enabled", async () => {
  getWorkingDiff.mockResolvedValue({ branch: "feat/x", plus: 3, minus: 1 });
  const { result } = renderHook(() => useSessionGitContext("/p/a", true));
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(result.current).toEqual({ branch: "feat/x", plus: 3, minus: 1 });
});

it("stays null when the shell bridge is unavailable", () => {
  delete win().electronAPI;
  const { result } = renderHook(() => useSessionGitContext("/p/none", true));
  expect(result.current).toBeNull();
});
