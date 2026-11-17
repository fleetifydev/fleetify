import { describe, it, expect } from "vitest";
import { showsLogoGallery } from "@/lib/dev-gallery";

describe("showsLogoGallery", () => {
  it("is off outside a dev build, whatever the hash", () => {
    // A release build must never swap the app for the dev gallery, even if
    // a link or a drop sets #logos.
    expect(showsLogoGallery("#logos", false)).toBe(false);
    expect(showsLogoGallery("", false)).toBe(false);
  });

  it("shows the gallery in a dev build for #logos only", () => {
    expect(showsLogoGallery("#logos", true)).toBe(true);
    expect(showsLogoGallery("#logo", true)).toBe(false);
    expect(showsLogoGallery("#logos-x", true)).toBe(false);
    expect(showsLogoGallery("", true)).toBe(false);
  });
});
