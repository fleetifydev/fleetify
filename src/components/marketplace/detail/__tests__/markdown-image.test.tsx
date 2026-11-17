import { describe, it, expect } from "vitest";
import { imageSource } from "../markdown-image";

describe("imageSource", () => {
  it("loads https: images from each allowed host", () => {
    for (const host of [
      "raw.githubusercontent.com",
      "github.com",
      "user-images.githubusercontent.com",
      "private-user-images.githubusercontent.com",
      "camo.githubusercontent.com",
      "avatars.githubusercontent.com",
      "img.shields.io",
    ]) {
      expect(imageSource(`https://${host}/a/b.png`)).toEqual({ kind: "load", src: `https://${host}/a/b.png` });
    }
  });

  it("asks before loading from any other https: host, look-alikes included", () => {
    for (const [src, host] of [
      ["https://images.example.net/d.png", "images.example.net"],
      ["https://github.com.example.net/d.png", "github.com.example.net"],
      ["https://evilgithub.com/d.png", "evilgithub.com"],
      ["https://10.0.0.1/d.png", "10.0.0.1"],
      // A listed host on another port, or with credentials, isn't the listed host.
      ["https://github.com:8443/d.png", "github.com:8443"],
      ["https://user:pw@github.com/d.png", "github.com"],
    ]) {
      expect(imageSource(src)).toEqual({ kind: "ask", src: new URL(src).href, host });
    }
  });

  it("matches hosts without regard to case", () => {
    expect(imageSource("HTTPS://IMG.Shields.IO/x.svg")).toEqual({ kind: "load", src: "https://img.shields.io/x.svg" });
  });

  it("loads data: images, and nothing else from data:", () => {
    expect(imageSource("data:image/svg+xml;base64,PHN2Zy8+")).toEqual({ kind: "load", src: "data:image/svg+xml;base64,PHN2Zy8+" });
    expect(imageSource("data:text/html;base64,PGgxPg==")).toEqual({ kind: "alt" });
  });

  it("shows the alt text for every other scheme and for relative paths", () => {
    for (const src of [
      "http://example.org/a.png",
      "ftp://example.org/a.png",
      "file:///etc/hosts",
      "javascript:alert(1)",
      "",
      "./docs/a.png",
      "/a.png",
      "a.png",
      "//cdn.example.net/a.png",
      undefined,
    ]) {
      expect(imageSource(src)).toEqual({ kind: "alt" });
    }
  });
});
