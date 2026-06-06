import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ModelBrowser } from "../ModelBrowser";

vi.mock("@/lib/studio-api", () => ({
  studioApi: { listModels: vi.fn(), getModel: vi.fn(), getTools: vi.fn(), getAccount: vi.fn() },
}));
import { studioApi } from "@/lib/studio-api";
const mocked = studioApi as unknown as { listModels: ReturnType<typeof vi.fn>; getModel: ReturnType<typeof vi.fn>; };

beforeEach(() => { mocked.listModels.mockReset(); mocked.getModel.mockReset(); });
afterEach(() => cleanup());

describe("ModelBrowser", () => {
  it("lists image models on mount and shows params when a model is clicked", async () => {
    mocked.listModels.mockResolvedValue([{ display_name: "Nano Banana Pro", job_set_type: "nano_banana_2", type: "image" }]);
    mocked.getModel.mockResolvedValue({ display_name: "Nano Banana Pro", job_set_type: "nano_banana_2", type: "image", params: [{ name: "aspect_ratio", type: "string", default: "1:1", required: false, enum: ["1:1", "16:9"] }] });
    render(<ModelBrowser />);
    const btn = await screen.findByText("Nano Banana Pro");
    expect(mocked.listModels).toHaveBeenCalledWith("image");
    fireEvent.click(btn);
    expect(await screen.findByText("aspect_ratio")).toBeTruthy();
  });

  it("switches to the video tab and refetches", async () => {
    mocked.listModels.mockResolvedValue([]);
    render(<ModelBrowser />);
    fireEvent.click(screen.getByText("Video"));
    // last call should be for video
    expect(mocked.listModels).toHaveBeenLastCalledWith("video");
  });
});
