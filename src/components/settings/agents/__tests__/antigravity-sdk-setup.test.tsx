import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("button", { name: /^Setup$/ })).not.toBeInTheDocument();
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
