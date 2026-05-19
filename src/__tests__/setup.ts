/**
 * Renderer-test setup. Pulls in @testing-library/jest-dom's matchers
 * (`toBeInTheDocument`, `toHaveTextContent`, …) and ensures the DOM
 * is cleaned between tests so listeners from one test don't leak into
 * the next.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
