import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Renderer test pool. Lives alongside (not inside) the electron-test
 * config so the two suites don't share an environment — happy-dom for
 * React components vs. node for the main-process .cjs modules.
 *
 * Run with: `npx vitest run --config vitest.renderer.config.ts`.
 * The combined `npm test` script runs both pools sequentially.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "electron/**"],
    environment: "happy-dom",
    globals: false,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Pin PostHog env to empty for the whole renderer suite so tests are
    // deterministic regardless of a contributor's local `.env` (which
    // Vite would otherwise load). The posthog wrapper reads
    // `VITE_POSTHOG_KEY` at module load; forcing it empty keeps the
    // "no key → no-op" assertions valid even on a machine that has real
    // PostHog credentials configured for `npm run dev:tauri:wt`.
    env: {
      VITE_POSTHOG_KEY: "",
      VITE_POSTHOG_HOST: "",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
