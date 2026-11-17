import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { ChangelogBody } from "../ChangelogBody";
import { OverviewBody } from "../PluginDetailPage";

// A plugin's README and CHANGELOG are third-party markdown. An image in them
// would load straight into the WebView: a tracking pixel, or a request to a
// host on the user's network. Only data: images and a few well-known image
// hosts load on their own; any other https: image waits for a click; other
// schemes and relative paths show their alt text.

const renderers: Array<[string, (md: string) => ReactElement]> = [
  ["README", (md) => <OverviewBody readme={md} description="" />],
  ["changelog without versions", (md) => <ChangelogBody changelog={md} />],
  [
    "changelog entry",
    (md) => <ChangelogBody changelog={`## [1.0.0] - 2026-01-01\n\n### Added\n\n- ${md}\n`} />,
  ],
];

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe.each(renderers)("%s images", (_name, renderMarkdown) => {
  it("renders an image from an allowed host", () => {
    render(renderMarkdown("![build status](https://img.shields.io/badge/build-passing-green)"));
    const img = screen.getByRole("img", { name: "build status" });
    expect(img).toHaveAttribute("src", "https://img.shields.io/badge/build-passing-green");
  });

  it("asks before loading an image from any other host", () => {
    render(renderMarkdown("![diagram](https://images.example.net/d.png)"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load image from images.example.net" }));

    const img = screen.getByRole("img", { name: "diagram" });
    expect(img).toHaveAttribute("src", "https://images.example.net/d.png");
    expect(screen.queryByRole("button", { name: /Load image from/ })).toBeNull();
  });

  it("shows only the alt text for http: and relative images", () => {
    for (const md of ["![plain http](http://example.org/a.png)", "![relative](./docs/a.png)", "![rooted](/a.png)"]) {
      render(renderMarkdown(md));
      expect(document.querySelector("img")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText(md.slice(2, md.indexOf("]")))).toBeInTheDocument();
      cleanup();
    }
  });

  it("renders a data: image", () => {
    render(renderMarkdown(`![dot](${PIXEL})`));
    expect(screen.getByRole("img", { name: "dot" })).toHaveAttribute("src", PIXEL);
  });
});
