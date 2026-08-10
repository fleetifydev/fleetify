import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  dockerStatusMock,
  dockerContainersMock,
  dockerListDirMock,
  dockerProbeAgentMock,
} = vi.hoisted(() => ({
  dockerStatusMock: vi.fn(),
  dockerContainersMock: vi.fn(),
  dockerListDirMock: vi.fn(),
  dockerProbeAgentMock: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    dockerStatus: dockerStatusMock,
    dockerContainers: dockerContainersMock,
    dockerListDir: dockerListDirMock,
    dockerProbeAgent: dockerProbeAgentMock,
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
    dockerProbeAgentMock.mockReset();
  });

  it("warns when the agent CLI is missing from the container", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: false, path: "" });
    render(<Panel />);
    await expandTheContainer();
    await waitFor(() =>
      expect(screen.getByText(/claude CLI is not installed/i)).toBeInTheDocument()
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

  it("still lets the user pick a container without the CLI — it reports, it does not veto", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: false, path: "" });
    const onPick = vi.fn();
    render(<Panel onAttach={onPick} />);
    await expandTheContainer();
    await waitFor(() =>
      expect(screen.getByText(/claude CLI is not installed/i)).toBeInTheDocument()
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
    expect(screen.getByText(/nothing to mount/i)).toBeInTheDocument();
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
    expect(onRun).toHaveBeenCalledWith("node:22", false);
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
    expect(onRun).toHaveBeenCalledWith("node:22", true);
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
});
