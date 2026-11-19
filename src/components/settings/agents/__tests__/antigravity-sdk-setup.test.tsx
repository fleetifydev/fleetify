import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { AntigravitySdkSetupRow } from "../antigravity-sdk-setup";

describe("AntigravitySdkSetupRow", () => {
  it("renders 'Python required' state with a Download Python link when python.installed is false", () => {
    render(
      <AntigravitySdkSetupRow
        python={{ installed: false, version: null, path: null }}
        sdkInstalled={false}
        installing={false}
        installError={null}
        onSetup={vi.fn()}
      />
    );
    expect(screen.getByText(/Python required/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Download Python/i });
    expect(link).toHaveAttribute("href", "https://www.python.org/downloads/");
    expect(screen.queryByRole("button", { name: /^Setup$/ })).not.toBeInTheDocument();
  });

  it("opens the Python download page in the system browser, not in the app's window", () => {
    // Tauri's webview refuses new windows: a `target="_blank"` link opened nothing.
    const win = window as unknown as { electronAPI?: unknown };
    const openExternal = vi.fn(() => Promise.resolve(true));
    win.electronAPI = { openExternal };
    // Sees the app code's window.open calls only: happy-dom follows a link
    // through its own window object, not the global window.open.
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      render(
        <AntigravitySdkSetupRow
          python={{ installed: false, version: null, path: null }}
          sdkInstalled={false}
          installing={false}
          installError={null}
          onSetup={vi.fn()}
        />
      );
      const link = screen.getByRole("link", { name: /Download Python/i });
      expect(link).not.toHaveAttribute("target");
      const click = createEvent.click(link);
      fireEvent(link, click);
      // Cancelled, so the webview doesn't load the page in place of the app.
      expect(click.defaultPrevented).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(openExternal).toHaveBeenCalledWith("https://www.python.org/downloads/");
    } finally {
      open.mockRestore();
      delete win.electronAPI;
    }
  });

  it("renders Setup button when Python is present but SDK is not", () => {
    const onSetup = vi.fn();
    render(
      <AntigravitySdkSetupRow
        python={{ installed: true, version: "3.12.4", path: "/usr/bin/python3" }}
        sdkInstalled={false}
        installing={false}
        installError={null}
        onSetup={onSetup}
      />
    );
    const btn = screen.getByRole("button", { name: /^Setup$/ });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("renders disabled Installing… button when installing is true", () => {
    render(
      <AntigravitySdkSetupRow
        python={{ installed: true, version: "3.12.4", path: "/usr/bin/python3" }}
        sdkInstalled={false}
        installing={true}
        installError={null}
        onSetup={vi.fn()}
      />
    );
    const btn = screen.getByRole("button", { name: /Installing…/i });
    expect(btn).toBeDisabled();
  });

  it("renders nothing extra when SDK is already installed (parent owns the all-set state)", () => {
    const { container } = render(
      <AntigravitySdkSetupRow
        python={{ installed: true, version: "3.12.4", path: "/usr/bin/python3" }}
        sdkInstalled={true}
        installing={false}
        installError={null}
        onSetup={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /^Setup$/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Python required/i)).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it("surfaces installError inline", () => {
    render(
      <AntigravitySdkSetupRow
        python={{ installed: true, version: "3.12.4", path: "/usr/bin/python3" }}
        sdkInstalled={false}
        installing={false}
        installError="pip exit code 1"
        onSetup={vi.fn()}
      />
    );
    expect(screen.getByText(/pip exit code 1/)).toBeInTheDocument();
  });
});
