import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  dockerStatusMock,
  dockerContainersMock,
  dockerListDirMock,
  dockerProbeAgentMock,
  dockerImagesMock,
} = vi.hoisted(() => ({
  dockerStatusMock: vi.fn(),
  dockerContainersMock: vi.fn(),
  dockerListDirMock: vi.fn(),
  dockerProbeAgentMock: vi.fn(),
  dockerImagesMock: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    dockerStatus: dockerStatusMock,
    dockerContainers: dockerContainersMock,
    dockerListDir: dockerListDirMock,
    dockerProbeAgent: dockerProbeAgentMock,
    dockerImages: dockerImagesMock,
  };
});

import { DockerContainerPanel } from "../docker-container-panel";

const CONTAINER = {
  id: "abc123",
  name: "web",
  image: "node:20",
  status: "Up 2 hours",
  state: "running",
};

async function expandTheContainer() {
  const row = await screen.findByText("web");
  fireEvent.click(row);
  await waitFor(() => expect(dockerListDirMock).toHaveBeenCalled());
}

/** The panel is an execution target now, not a source tab, so it takes an
 *  attach handler, a run handler and the session's provider id. This wrapper
 *  keeps the tests focused on the preflight behaviour they are about. */
function Panel(props: Partial<React.ComponentProps<typeof DockerContainerPanel>> = {}) {
  return (
    <DockerContainerPanel
      onAttach={() => {}}
      onRun={() => {}}
      onClear={() => {}}
      onPickFolder={() => {}}
      onPickFile={() => Promise.resolve(null)}
      sourcePath="/home/me/proj"
      execMode="host"
      providerId="claude-code"
      {...props}
    />
  );
}

describe("DockerContainerPanel agent preflight", () => {
  beforeEach(() => {
    dockerStatusMock.mockReset().mockResolvedValue({
      installed: true,
      running: true,
      error: null,
    });
    dockerContainersMock.mockReset().mockResolvedValue({ containers: [CONTAINER] });
    dockerListDirMock.mockReset().mockResolvedValue({ path: "/", entries: [] });
    dockerImagesMock.mockReset().mockResolvedValue({ images: [] });
    dockerProbeAgentMock.mockReset();
  });

  it("warns when the agent CLI is missing from the container", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: false, path: "" });
    render(<Panel />);
    await expandTheContainer();
    await waitFor(() =>
      expect(screen.getByText(/isn.t installed in this container/i)).toBeInTheDocument()
    );
    // The probe names the binary explicitly. It used to rely on the API
    // helper's `agent = "claude"` default, which reported "not installed"
    // for a codex or cursor session in a perfectly good container.
    expect(dockerProbeAgentMock).toHaveBeenCalledWith("abc123", "claude");
  });

  it("stays quiet when the CLI is present", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: true, path: "/usr/bin/claude" });
    render(<Panel />);
    await expandTheContainer();
    await waitFor(() => expect(dockerProbeAgentMock).toHaveBeenCalled());
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument();
  });

  /// A failed probe is not evidence the CLI is missing — the daemon could
  /// be busy or the container mid-restart. Guessing "missing" would cry
  /// wolf on a perfectly good container.
  it("stays quiet when the probe itself fails", async () => {
    dockerProbeAgentMock.mockRejectedValue(new Error("daemon busy"));
    render(<Panel />);
    await expandTheContainer();
    await waitFor(() => expect(dockerProbeAgentMock).toHaveBeenCalled());
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument();
  });

  /** The warning used to hardcode "claude" for every provider, so a Codex
   *  session probed for `codex` correctly and then told the user the
   *  *claude* CLI was missing. */
  it("names the agent that is actually missing, not always claude", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: false, path: "" });
    render(<Panel providerId="codex-cli" />);
    await expandTheContainer();
    await waitFor(() => expect(screen.getByText("codex")).toBeInTheDocument());
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
  });

  it("still lets the user pick a container without the CLI — it reports, it does not veto", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: false, path: "" });
    const onPick = vi.fn();
    render(<Panel onAttach={onPick} />);
    await expandTheContainer();
    await waitFor(() =>
      expect(screen.getByText(/isn.t installed in this container/i)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTitle("Use this folder"));
    expect(onPick).toHaveBeenCalledWith("docker://abc123/");
  });

  /** The bug the default hid: every session probed for `claude`, so picking
   *  a container for a Codex session reported the CLI missing even when
   *  codex was installed. cursor is the sharpest case — its in-container
   *  binary is `agent`, not the host's `cursor-agent`. */
  it("probes the session's own agent binary, not always claude", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: true, path: "/usr/bin/codex" });
    render(<Panel providerId="codex-cli" />);
    await expandTheContainer();
    await waitFor(() =>
      expect(dockerProbeAgentMock).toHaveBeenCalledWith("abc123", "codex")
    );
  });

  it("maps cursor to its in-container binary rather than the host shim name", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: true, path: "/usr/bin/agent" });
    render(<Panel providerId="cursor-cli" />);
    await expandTheContainer();
    await waitFor(() =>
      expect(dockerProbeAgentMock).toHaveBeenCalledWith("abc123", "agent")
    );
  });

  /** Two agents genuinely cannot run in a container. Saying so in the picker
   *  beats letting the first turn fail with an opaque error. */
  it("refuses an unsupported agent up front, with the reason", () => {
    render(<Panel providerId="antigravity-sdk" />);
    expect(screen.getByText(/can't run in a container/i)).toBeInTheDocument();
    expect(screen.getByText(/remote sandbox/i)).toBeInTheDocument();
  });
});

/* ─── Run-from-image layout + gating ───────────────────────────────
 *
 * The action was reported as "doesn't work when you type an image name".
 * It was not broken — it needs something to MOUNT, and the reason sat two
 * rows above the button styled like a field hint, so a filled-in image with
 * a dead button read as a bug. These pin the reason next to the action.  */
describe("DockerContainerPanel run-from-image", () => {
  // The panel probes the daemon before it renders anything, so the mode
  // tabs only exist after that resolves.
  const openRunMode = async () => {
    const tab = await screen.findByText(/start one from an image/i);
    fireEvent.click(tab);
  };
  const typeImage = (v: string) => {
    fireEvent.change(screen.getByPlaceholderText("node:22"), { target: { value: v } });
  };

  it("blocks the run and says why when there is nothing to mount", async () => {
    render(<Panel sourcePath={null} />);
    await openRunMode();
    typeImage("node:22");

    const btn = screen.getByRole("button", { name: /run in this image/i });
    expect(btn).toBeDisabled();
    // The reason must be adjacent to the action, not buried under the input.
    expect(screen.getByText(/pick a folder or repo first/i)).toBeInTheDocument();
  });

  it("blocks the run when no image is typed, and says that instead", async () => {
    render(<Panel sourcePath="/home/me/proj" />);
    await openRunMode();
    expect(screen.getByRole("button", { name: /run in this image/i })).toBeDisabled();
    expect(screen.getByText(/enter an image/i)).toBeInTheDocument();
  });

  it("runs once both an image and a host source are present", async () => {
    const onRun = vi.fn();
    render(<Panel sourcePath="/home/me/proj" onRun={onRun} />);
    await openRunMode();
    typeImage("  node:22  ");

    const btn = screen.getByRole("button", { name: /run in this image/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    // Trimmed, and the credential opt-in defaults OFF — it carries a host
    // login across the boundary, so it is never implicit.
    expect(onRun).toHaveBeenCalledWith({
      source: "image",
      image: "node:22",
      file: undefined,
      service: undefined,
      mountCredentials: false,
    });
  });

  it("passes the credential opt-in through only when the user ticks it", async () => {
    const onRun = vi.fn();
    render(<Panel sourcePath="/home/me/proj" onRun={onRun} />);
    await openRunMode();
    typeImage("node:22");
    // A radio pair, not a lone tick-box: the safe option is selected by
    // default and visible, so the user can see what they are trading away.
    expect(screen.getByRole("radio", { name: /sign in inside the container/i }))
      .toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /mount my .* login/i }));
    fireEvent.click(screen.getByRole("button", { name: /run in this image/i }));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ source: "image", image: "node:22", mountCredentials: true }),
    );
  });

  /** An attach session's project path IS the container, so there is no host
   *  directory to bind-mount — running from an image would mount nothing. */
  it("refuses to mount a container path", async () => {
    render(<Panel sourcePath="docker://abc123/work" />);
    await openRunMode();
    typeImage("node:22");
    expect(screen.getByRole("button", { name: /run in this image/i })).toBeDisabled();
  });

  /** Selection has to be visible on the whole row, not just a dot — the
   *  card is the target, so the card is what shows state. */
  it("marks the selected credential option and clears the other", async () => {
    render(<Panel sourcePath="/home/me/proj" />);
    await openRunMode();
    const safe = screen.getByRole("radio", { name: /sign in inside the container/i });
    const mount = screen.getByRole("radio", { name: /mount my .* login/i });
    expect(safe).toHaveAttribute("aria-checked", "true");
    expect(mount).toHaveAttribute("aria-checked", "false");

    fireEvent.click(mount);
    expect(mount).toHaveAttribute("aria-checked", "true");
    expect(safe).toHaveAttribute("aria-checked", "false");
  });

  /* ── Run recipes: Dockerfile & Compose ─────────────────────────── */

  it("shows the folder browser inside run mode, so setup never leaves the tab", async () => {
    const onPickFolder = vi.fn();
    render(<Panel sourcePath={null} onPickFolder={onPickFolder} />);
    await openRunMode();
    fireEvent.click(screen.getByTestId("pick-folder-row"));
    expect(onPickFolder).toHaveBeenCalled();
  });

  it("runs the project's own Dockerfile, picked with the OS dialog", async () => {
    const onRun = vi.fn();
    const onPickFile = vi.fn().mockResolvedValue("docker/Dockerfile.dev");
    render(<Panel onRun={onRun} onPickFile={onPickFile} />);
    await openRunMode();
    fireEvent.click(screen.getByRole("radio", { name: "Dockerfile" }));
    fireEvent.click(screen.getByTestId("pick-dockerfile-row"));
    expect(onPickFile).toHaveBeenCalledWith("dockerfile");
    // The resolved (relative-ised) path lands on the row and in the payload.
    await waitFor(() =>
      expect(screen.getByText("docker/Dockerfile.dev")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /build & run/i }));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ source: "dockerfile", file: "docker/Dockerfile.dev" }),
    );
  });

  /** Nothing picked is a valid state — the backend defaults to
   *  ./Dockerfile — and the row says so instead of blocking. */
  it("lets Dockerfile mode run with the default file", async () => {
    const onRun = vi.fn();
    render(<Panel onRun={onRun} />);
    await openRunMode();
    fireEvent.click(screen.getByRole("radio", { name: "Dockerfile" }));
    expect(screen.getByText(/Dockerfile in the project folder/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /build & run/i }));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ source: "dockerfile", file: undefined }),
    );
  });

  it("runs a compose service, and never claims a credential mount for it", async () => {
    const onRun = vi.fn();
    const onPickFile = vi.fn().mockResolvedValue("compose.yaml");
    render(<Panel onRun={onRun} onPickFile={onPickFile} />);
    await openRunMode();
    fireEvent.click(screen.getByRole("radio", { name: "Compose" }));
    // Compose owns the service's mounts — the credential cards must be
    // replaced by the explanation, not just disabled.
    expect(screen.queryByRole("radio", { name: /mount my .* login/i })).not.toBeInTheDocument();
    expect(screen.getByText(/owns the service/i)).toBeInTheDocument();
    // …and there is no separate folder row: the compose file's own
    // directory IS the project directory, so a second control could only
    // agree with the file or contradict it.
    expect(screen.queryByTestId("pick-folder-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pick-compose-row"));
    expect(onPickFile).toHaveBeenCalledWith("compose");
    await waitFor(() => expect(screen.getByText("compose.yaml")).toBeInTheDocument());
    fireEvent.change(
      screen.getByPlaceholderText(/single-service file picks itself/i),
      { target: { value: "web" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /start the stack/i }));
    expect(onRun).toHaveBeenCalledWith({
      source: "compose",
      image: undefined,
      file: "compose.yaml",
      service: "web",
      mountCredentials: false,
    });
  });

  /** With no folder, compose's only way to get one is the file pick — the
   *  blocker must say that, not "pick a folder" (there is no folder row). */
  it("compose without a folder asks for the file, not a folder", async () => {
    render(<Panel sourcePath={null} />);
    await openRunMode();
    fireEvent.click(screen.getByRole("radio", { name: "Compose" }));
    expect(screen.getByRole("button", { name: /start the stack/i })).toBeDisabled();
    expect(screen.getByText(/choose a compose file first/i)).toBeInTheDocument();
  });

  /** Cancelling an attach has to say what it does — and the handler behind
   *  it now resets the docker:// project path too, which was the actual
   *  bug: exec fields alone let the marker re-derive attach at create. */
  it("labels the clear action Detach for an attached session", async () => {
    render(<Panel execMode="docker-attach" sourcePath="docker://abc123/work" />);
    expect(await screen.findByText(/detach container/i)).toBeInTheDocument();
    expect(screen.queryByText(/run locally/i)).not.toBeInTheDocument();
  });

  it("keeps the Run locally label for a provisioned session", async () => {
    render(<Panel execMode="docker-run" />);
    expect(await screen.findByText(/run locally/i)).toBeInTheDocument();
  });

  /** Re-opening the tab used to show a flat list with no memory of the
   *  pick — nothing said which container the session was already on. */
  it("marks the attached container in the list", async () => {
    render(<Panel execMode="docker-attach" sourcePath="docker://abc123/work" />);
    expect(await screen.findByText("Attached")).toBeInTheDocument();
  });

  it("marks nothing when the session runs on the host", async () => {
    render(<Panel execMode="host" sourcePath="/home/me/proj" />);
    // Wait for the list to load, then confirm no badge appeared.
    await waitFor(() => expect(dockerContainersMock).toHaveBeenCalled());
    expect(screen.queryByText("Attached")).not.toBeInTheDocument();
  });

  /* ── Local images shortcut ─────────────────────────────────────── */

  it("lists images already on the machine and fills the field on click", async () => {
    dockerImagesMock.mockResolvedValue({
      images: [
        { name: "node:22", size: "1.1GB", id: "aaa" },
        { name: "typesense/typesense:29.0", size: "180MB", id: "bbb" },
      ],
    });
    render(<Panel />);
    await openRunMode();
    const list = await screen.findByTestId("local-image-list");
    expect(list).toHaveTextContent("node:22");
    fireEvent.click(screen.getByText("typesense/typesense:29.0"));
    expect(screen.getByPlaceholderText("node:22")).toHaveValue("typesense/typesense:29.0");
  });

  it("typing filters the local list without limiting what can be typed", async () => {
    dockerImagesMock.mockResolvedValue({
      images: [
        { name: "node:22", size: "1.1GB", id: "aaa" },
        { name: "alpine:3", size: "8MB", id: "ccc" },
      ],
    });
    render(<Panel />);
    await openRunMode();
    await screen.findByTestId("local-image-list");
    fireEvent.change(screen.getByPlaceholderText("node:22"), { target: { value: "alp" } });
    expect(screen.queryByText("node:22", { selector: "span" })).not.toBeInTheDocument();
    expect(screen.getByText("alpine:3")).toBeInTheDocument();
    // A name that is on no list still runs — the list is a shortcut.
    fireEvent.change(screen.getByPlaceholderText("node:22"), { target: { value: "ghcr.io/x/y:1" } });
    expect(screen.getByRole("button", { name: /run in this image/i })).toBeEnabled();
  });
});
