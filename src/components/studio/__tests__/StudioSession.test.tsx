import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { StudioSession } from "../StudioSession";

vi.mock("@/lib/studio-api", () => ({
  studioApi: { listModels: vi.fn(), listMessages: vi.fn(), generate: vi.fn(), cost: vi.fn(), getModel: vi.fn(), getTools: vi.fn(), getAccount: vi.fn() },
}));
import { studioApi } from "@/lib/studio-api";
const m = studioApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.listModels.mockResolvedValue([{ display_name: "Nano Banana Pro", job_set_type: "nano_banana_2", type: "image" }]);
  m.getModel.mockResolvedValue({ display_name: "Nano Banana Pro", job_set_type: "nano_banana_2", type: "image", params: [] });
  m.listMessages.mockResolvedValue([]);
  m.cost.mockResolvedValue({ credits: 2, credits_exact: 2 });
  m.generate.mockResolvedValue({ id: "j1", status: "completed", result_url: "x.png", job_set_type: "nano_banana_2" });
});
afterEach(() => cleanup());

describe("StudioSession", () => {
  it("Generate calls studioApi.generate with the prompt", async () => {
    render(<StudioSession sessionId="s1" />);
    expect(await screen.findByText("Nano Banana Pro")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Describe what to generate…"), { target: { value: "a cat" } });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(m.generate).toHaveBeenCalledWith("s1", "nano_banana_2", { prompt: "a cat" }));
  });

  it("renders the model's params and includes them in generate", async () => {
    m.getModel.mockResolvedValue({ display_name: "Nano Banana Pro", job_set_type: "nano_banana_2", type: "image",
      params: [{ name: "aspect_ratio", type: "string", default: "1:1", required: false, enum: ["1:1", "16:9"] }] });
    render(<StudioSession sessionId="s1" />);
    const sel = await screen.findByLabelText("aspect_ratio");
    fireEvent.change(sel, { target: { value: "16:9" } });
    fireEvent.change(screen.getByPlaceholderText("Describe what to generate…"), { target: { value: "a cat" } });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(m.generate).toHaveBeenCalledWith("s1", "nano_banana_2", { prompt: "a cat", aspect_ratio: "16:9" }));
  });

  it("renders an <img> for an image artifact", async () => {
    m.listMessages.mockResolvedValue([
      { role: "user", content: JSON.stringify([{ type: "text", text: "a dog" }]) },
      { role: "assistant", content: JSON.stringify([{ type: "artifact", artifact_type: "image", content: "https://x/dog.png" }]) },
    ]);
    render(<StudioSession sessionId="s1" />);
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("https://x/dog.png");
  });

  it("renders a <video> for a video artifact", async () => {
    m.listMessages.mockResolvedValue([
      { role: "user", content: JSON.stringify([{ type: "text", text: "a clip" }]) },
      { role: "assistant", content: JSON.stringify([{ type: "artifact", artifact_type: "video", content: "https://x/clip.mp4" }]) },
    ]);
    const { container } = render(<StudioSession sessionId="s1" />);
    await screen.findByText("a clip");
    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
  });
});
