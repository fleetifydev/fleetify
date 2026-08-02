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
    render(<DockerContainerPanel onPick={() => {}} />);
    await expandTheContainer();
    await waitFor(() =>
      expect(screen.getByText(/claude CLI is not installed/i)).toBeInTheDocument()
    );
    expect(dockerProbeAgentMock).toHaveBeenCalledWith("abc123");
  });

  it("stays quiet when the CLI is present", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: true, path: "/usr/bin/claude" });
    render(<DockerContainerPanel onPick={() => {}} />);
    await expandTheContainer();
    await waitFor(() => expect(dockerProbeAgentMock).toHaveBeenCalled());
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument();
  });

  /// A failed probe is not evidence the CLI is missing — the daemon could
  /// be busy or the container mid-restart. Guessing "missing" would cry
  /// wolf on a perfectly good container.
  it("stays quiet when the probe itself fails", async () => {
    dockerProbeAgentMock.mockRejectedValue(new Error("daemon busy"));
    render(<DockerContainerPanel onPick={() => {}} />);
    await expandTheContainer();
    await waitFor(() => expect(dockerProbeAgentMock).toHaveBeenCalled());
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument();
  });

  it("still lets the user pick a container without the CLI — it reports, it does not veto", async () => {
    dockerProbeAgentMock.mockResolvedValue({ present: false, path: "" });
    const onPick = vi.fn();
    render(<DockerContainerPanel onPick={onPick} />);
    await expandTheContainer();
    await waitFor(() =>
      expect(screen.getByText(/claude CLI is not installed/i)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTitle("Use this folder"));
    expect(onPick).toHaveBeenCalledWith("docker://abc123/");
  });
});
