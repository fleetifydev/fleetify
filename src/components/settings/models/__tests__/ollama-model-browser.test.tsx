/**
 * Behaviour tests for OllamaModelBrowser — the downloadable-model browser
 * (curated cards + free-text pull box) wired in the local-Ollama card.
 *
 * The component consumes providers.ollamaPull / ollamaPullCancel /
 * ollamaDelete and subscribes to ollama-pull-progress events. All four are
 * mocked; the progress subscription's callback is captured so a test can
 * drive a pull's progress bar deterministically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { OllamaModelBrowser } from "../ollama-model-browser";
import type { OllamaPullEvent } from "@/lib/providers-api";

const apiMock = vi.hoisted(() => ({
  ollamaPull: vi.fn(),
  ollamaPullCancel: vi.fn(),
  ollamaDelete: vi.fn(),
  onOllamaPullProgress: vi.fn(),
}));

vi.mock("@/lib/providers-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/providers-api")>(
    "@/lib/providers-api",
  );
  return {
    ...actual,
    providers: { ...actual.providers, ...apiMock },
  };
});

// Captured progress callback — set by onOllamaPullProgress's mock impl.
let progressCb: ((e: OllamaPullEvent) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  progressCb = undefined;
  apiMock.ollamaPull.mockResolvedValue({ ok: true });
  apiMock.ollamaPullCancel.mockResolvedValue({ ok: true });
  apiMock.ollamaDelete.mockResolvedValue({ ok: true });
  apiMock.onOllamaPullProgress.mockImplementation(
    (cb: (e: OllamaPullEvent) => void) => {
      progressCb = cb;
      return () => {};
    },
  );
});

describe("OllamaModelBrowser", () => {
  it("pulls a selected tag from a current curated model", async () => {
    render(<OllamaModelBrowser baseUrl={null} installed={[]} onChanged={() => {}} />);

    fireEvent.change(screen.getByLabelText("Size for qwen3.5"), {
      target: { value: "4b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download qwen3.5:4b" }));

    await waitFor(() => expect(apiMock.ollamaPull).toHaveBeenCalledWith("qwen3.5:4b", null));
  });

  it("offers a lightweight coding model in the curated list", async () => {
    render(<OllamaModelBrowser baseUrl={null} installed={[]} onChanged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Download qwen2.5-coder:0.5b" }));

    await waitFor(() => expect(apiMock.ollamaPull).toHaveBeenCalledWith("qwen2.5-coder:0.5b", null));
  });

  it("shows the thinking capability for Qwen3-VL", () => {
    render(<OllamaModelBrowser baseUrl={null} installed={[]} onChanged={() => {}} />);

    expect(screen.getByText("qwen3-vl").parentElement).toHaveTextContent(/thinking/i);
  });

  it("typing a model:tag and clicking Download starts a pull with the base URL", async () => {
    render(
      <OllamaModelBrowser
        baseUrl="http://localhost:11434"
        installed={[]}
        onChanged={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/model:tag/i);
    fireEvent.change(input, { target: { value: "llama3.2:3b" } });
    fireEvent.click(screen.getByRole("button", { name: "Download llama3.2:3b" }));
    await waitFor(() =>
      expect(apiMock.ollamaPull).toHaveBeenCalledWith(
        "llama3.2:3b",
        "http://localhost:11434",
      ),
    );
  });

  it("advances the progress bar when a progress event arrives", async () => {
    render(
      <OllamaModelBrowser
        baseUrl="http://localhost:11434"
        installed={[]}
        onChanged={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/model:tag/i), {
      target: { value: "llama3.2:3b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download llama3.2:3b" }));
    await waitFor(() => expect(apiMock.ollamaPull).toHaveBeenCalled());

    act(() => {
      progressCb?.({
        model: "llama3.2:3b",
        status: "downloading",
        completed: 42,
        total: 100,
        percent: 42,
      });
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });

  it("removes the progress UI and re-probes on a terminal success event", async () => {
    const onChanged = vi.fn();
    render(
      <OllamaModelBrowser
        baseUrl={null}
        installed={[]}
        onChanged={onChanged}
      />,
    );
    // A target not present in the curated grid, so its only Download button
    // is the free-text one.
    fireEvent.change(screen.getByPlaceholderText(/model:tag/i), {
      target: { value: "mistral-nemo:12b" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Download mistral-nemo:12b" }),
    );
    await waitFor(() => expect(apiMock.ollamaPull).toHaveBeenCalled());

    act(() => {
      progressCb?.({ model: "mistral-nemo:12b", status: "success" });
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows Delete (not Download) for an installed curated model and deletes it", async () => {
    const onChanged = vi.fn();
    // llama3.2's first size is "1b", so the default target is llama3.2:1b.
    render(
      <OllamaModelBrowser
        baseUrl="http://localhost:11434"
        installed={["llama3.2:1b"]}
        onChanged={onChanged}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Download llama3.2:1b" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete llama3.2:1b" }));
    await waitFor(() =>
      expect(apiMock.ollamaDelete).toHaveBeenCalledWith(
        "llama3.2:1b",
        "http://localhost:11434",
      ),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("replaces a curated Download with Cancel while that exact model is pulling (resolution 3)", async () => {
    render(
      <OllamaModelBrowser baseUrl={null} installed={[]} onChanged={() => {}} />,
    );
    // Pick the 3b size on the llama3.2 card so its target is llama3.2:3b.
    fireEvent.change(screen.getByLabelText("Size for llama3.2"), {
      target: { value: "3b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download llama3.2:3b" }));
    await waitFor(() =>
      expect(apiMock.ollamaPull).toHaveBeenCalledWith("llama3.2:3b", null),
    );
    // No second Download for the in-flight model; a Cancel is offered instead.
    expect(
      screen.queryByRole("button", { name: "Download llama3.2:3b" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel llama3.2:3b" }),
    ).toBeInTheDocument();
  });

  it("pulls the bare name for an embedding model with no size variants", async () => {
    render(
      <OllamaModelBrowser baseUrl={null} installed={[]} onChanged={() => {}} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Download nomic-embed-text" }),
    );
    await waitFor(() =>
      expect(apiMock.ollamaPull).toHaveBeenCalledWith("nomic-embed-text", null),
    );
  });
});
