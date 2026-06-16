import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { getMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
}));
vi.mock("@/lib/plugin-api", () => ({
  getPluginSecrets: getMock,
  setPluginSecrets: setMock,
}));

import { SecretsEditor } from "../SecretsEditor";

const requires = [
  { key: "TOKEN_A", label: "Token A", url: "https://a.example" },
  { key: "TOKEN_B", label: "Token B" },
];

beforeEach(() => {
  getMock.mockReset();
  setMock.mockReset();
  getMock.mockResolvedValue([
    { key: "TOKEN_A", label: "Token A", url: "https://a.example", set: true },
    { key: "TOKEN_B", label: "Token B", set: false },
  ]);
  setMock.mockResolvedValue([
    { key: "TOKEN_A", label: "Token A", url: "https://a.example", set: true },
    { key: "TOKEN_B", label: "Token B", set: true },
  ]);
});

describe("SecretsEditor", () => {
  it("renders one field per declared secret and marks set vs not-set", async () => {
    render(<SecretsEditor installId="p" requiresSecrets={requires} />);
    expect(screen.getByText("Token A")).toBeInTheDocument();
    expect(screen.getByText("Token B")).toBeInTheDocument();
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("p"));
    await waitFor(() => expect(screen.getByText(/saved/i)).toBeInTheDocument());
  });

  it("saves only the changed keys", async () => {
    render(<SecretsEditor installId="p" requiresSecrets={requires} />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    const inputs = screen.getAllByPlaceholderText(/TOKEN_/);
    const bInput = inputs.find(i => (i as HTMLInputElement).placeholder === "TOKEN_B")!;
    fireEvent.change(bInput, { target: { value: "newval" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith("p", { TOKEN_B: "newval" }));
  });
});
