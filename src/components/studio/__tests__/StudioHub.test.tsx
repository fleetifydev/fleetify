import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StudioHub } from "../StudioHub";
import { useAppStore } from "@/stores/app-store";

vi.mock("@/lib/studio-api", () => ({
  studioApi: {
    getTools: vi.fn(),
    getAccount: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    getModel: vi.fn(),
  },
}));
import { studioApi } from "@/lib/studio-api";
const mocked = studioApi as unknown as {
  getTools: ReturnType<typeof vi.fn>; getAccount: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>; getModel: ReturnType<typeof vi.fn>;
};
const tool = (over: Partial<{installed: boolean; authenticated: boolean}> = {}) =>
  ([{ id: "higgsfield", display_name: "Higgsfield", install_hint: "npm install -g @higgsfield/cli", installed: true, authenticated: false, ...over }]);

beforeEach(() => { mocked.getTools.mockReset(); mocked.getAccount.mockReset(); mocked.listModels.mockResolvedValue([]); });
afterEach(() => { cleanup(); useAppStore.setState({ sidebarCollapsed: false }); });

describe("StudioHub", () => {
  it("renders the Studio heading and the Higgsfield card", async () => {
    mocked.getTools.mockResolvedValue(tool());
    render(<StudioHub />);
    expect(await screen.findByText("Studio")).toBeTruthy();
    expect(await screen.findByText("Higgsfield")).toBeTruthy();
  });

  it("shows a 'Show sidebar' button when sidebar is collapsed (non-Windows)", async () => {
    mocked.getTools.mockResolvedValue(tool());
    useAppStore.setState({ sidebarCollapsed: true });
    render(<StudioHub />);
    expect(await screen.findByTitle("Show sidebar")).toBeTruthy();
  });

  it("shows the install hint when hf is not installed", async () => {
    mocked.getTools.mockResolvedValue(tool({ installed: false, authenticated: false }));
    render(<StudioHub />);
    expect(await screen.findByText(/npm install -g @higgsfield\/cli/)).toBeTruthy();
  });

  it("prompts to connect when installed but not authenticated", async () => {
    mocked.getTools.mockResolvedValue(tool({ installed: true, authenticated: false }));
    render(<StudioHub />);
    expect(await screen.findByText(/hf auth login/)).toBeTruthy();
  });

  it("shows credits when connected", async () => {
    mocked.getTools.mockResolvedValue(tool({ installed: true, authenticated: true }));
    mocked.getAccount.mockResolvedValue({ email: "a@b.com", credits: 7, subscription_plan_type: "free" });
    render(<StudioHub />);
    expect(await screen.findByText(/7 credits · free/)).toBeTruthy();
  });
});
