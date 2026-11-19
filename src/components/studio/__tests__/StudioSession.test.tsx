import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, createEvent } from "@testing-library/react";
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

  it("Edit on a result carries its job id as the source (image-to-image)", async () => {
    m.listMessages.mockResolvedValue([
      { role: "user", content: JSON.stringify([{ type: "text", text: "a dog" }]) },
      { role: "assistant", content: JSON.stringify([{ type: "artifact", artifact_type: "image", content: "https://x/dog.png", job_id: "job-123" }]) },
    ]);
    render(<StudioSession sessionId="s1" />);
    fireEvent.click(await screen.findByText("Edit"));
    expect(await screen.findByText("Editing from this image")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Describe the edit…"), { target: { value: "make it blue" } });
    fireEvent.click(screen.getByText("Generate edit"));
    await waitFor(() =>
      expect(m.generate).toHaveBeenCalledWith("s1", "nano_banana_2", { prompt: "make it blue", image: "job-123" }),
    );
  });
});

// "Download" on a result. A remote result used to be a `download` link with
// `target="_blank"`: the webview ignores `download` for another site's file,
// and refuses the new window, so it did nothing. It now opens in the system
// browser. A file the page itself holds (a `data:` URL, or a `blob:` URL of
// the page's own origin) is still saved in place.
describe("StudioSession Download", () => {
  const win = window as unknown as {
    electronAPI?: unknown;
    happyDOM?: { setURL(url: string): void };
  };
  let openExternal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The release app's page: the embedded backend's origin.
    win.happyDOM?.setURL("http://127.0.0.1:8765/");
    openExternal = vi.fn(() => Promise.resolve(true));
    win.electronAPI = { openExternal };
  });
  afterEach(() => {
    delete win.electronAPI;
  });

  /** Renders a session whose one result is the image at `url`, and returns
   *  its Download link. */
  async function downloadLinkFor(url: string): Promise<HTMLElement> {
    vi.mocked(studioApi.listMessages).mockResolvedValue([
      { role: "user", content: JSON.stringify([{ type: "text", text: "a dog" }]) },
      { role: "assistant", content: JSON.stringify([{ type: "artifact", artifact_type: "image", content: url }]) },
    ]);
    render(<StudioSession sessionId="s1" />);
    return screen.findByRole("link", { name: "Download" });
  }

  /** Clicks `link` and reports what the app did with the click: whether it
   *  left the click to the webview (nothing cancelled it, so the webview
   *  saves the file, or loads the link in place of the app), and the
   *  `window.open` calls the app's code made. happy-dom follows a link
   *  through its own window object, not the global `window.open`, so the
   *  stub sees app code only. */
  function click(link: HTMLElement): { leftToWebview: boolean; windowOpens: unknown[][] } {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      const event = createEvent.click(link);
      fireEvent(link, event);
      return { leftToWebview: !event.defaultPrevented, windowOpens: [...open.mock.calls] };
    } finally {
      open.mockRestore();
    }
  }

  it("opens a remote result in the system browser, never a new window", async () => {
    const link = await downloadLinkFor("https://cdn.example.com/jobs/j1/dog.png");
    expect(link).toHaveAttribute("href", "https://cdn.example.com/jobs/j1/dog.png");
    expect(link).not.toHaveAttribute("target");
    expect(click(link)).toEqual({ leftToWebview: false, windowOpens: [] });
    expect(openExternal).toHaveBeenCalledWith("https://cdn.example.com/jobs/j1/dog.png");
  });

  it.each([
    ["a data: URL", "data:image/png;base64,iVBORw0KGgo="],
    ["a blob: URL of the page's origin", "blob:http://127.0.0.1:8765/5b1f0c2e-42"],
  ])("saves %s in place", async (_kind, url) => {
    const link = await downloadLinkFor(url);
    expect(link).toHaveAttribute("download");
    expect(link).not.toHaveAttribute("target");
    expect(click(link)).toEqual({ leftToWebview: true, windowOpens: [] });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("neither saves nor opens a blob: URL of another origin", async () => {
    const link = await downloadLinkFor("blob:https://elsewhere.example/5b1f0c2e-42");
    expect(link).not.toHaveAttribute("download");
    expect(link).not.toHaveAttribute("target");
    expect(click(link)).toEqual({ leftToWebview: false, windowOpens: [] });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
