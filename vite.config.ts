import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Inject the app version as a build-time literal. Renderer code reads
  // `__APP_VERSION__` (declared via `declare const` in settings-page.tsx
  // and general/updates-card.tsx) and without this define it throws a
  // ReferenceError at runtime — which had been silently breaking the
  // Diagnostics "Copy diagnostic info" handler.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
  },
  build: {
    // Source maps are only useful in dev — shipping them with the
    // production renderer bundle bloats the asar by ~10MB and exposes
    // unminified source to anyone who pokes at devtools. Keep them off
    // for prod; vite dev still emits them automatically.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split heavy / rarely-changing vendor code into dedicated
        // chunks so:
        //   1. the entry chunk stays small (faster parse/eval on cold
        //      start),
        //   2. subsequent app-only releases don't invalidate the vendor
        //      cache in Electron's renderer cache,
        //   3. the browser can fetch vendor chunks in parallel with the
        //      entry chunk instead of one huge waterfall blob.
        // Anything not listed here stays in the default route-based
        // chunks Rollup already produces.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // React core — used everywhere, cache it hard.
          if (id.match(/node_modules\/(react|react-dom|scheduler)\//)) {
            return "vendor-react";
          }
          // Markdown rendering — used only inside chat / onboarding / git
          // dialogs. Keeping it separate lets the chat surface stream in
          // before the markdown chunk finishes parsing on first paint.
          if (id.match(/node_modules\/(react-markdown|remark-.*|rehype-.*|micromark.*|mdast-.*|hast-.*|unified|unist-.*|vfile.*|bail|trough|decode-named-character-reference|character-entities.*|trim-lines|space-separated-tokens|comma-separated-tokens|property-information|html-url-attributes|zwitch|html-void-elements|ccount|escape-string-regexp|markdown-table|longest-streak|stringify-entities)\//)) {
            return "vendor-markdown";
          }
          // Icon set — lucide-react re-exports ~1k SVGs. Tree-shaking
          // generally works but the icons we DO use still add up.
          if (id.includes("node_modules/lucide-react/")) {
            return "vendor-icons";
          }
          // CodeMirror & xterm are already imported via dynamic
          // import() inside workspace-panel / xterm-shell, so Rollup
          // emits separate chunks for them automatically — no manual
          // rule needed here.
        },
      },
    },
  },
  // Dev-server + backend ports come from env so the parallel-worktree
  // helper (`scripts/dev-tauri-wt.mjs`) can boot a second instance on
  // sibling ports without colliding with the default 3000/8765 pair.
  server: (() => {
    const vitePort = Number(process.env.VITE_PORT) || 3000;
    const backendPort = Number(process.env.FLEETIFY_BACKEND_PORT) || 8765;
    const httpTarget = `http://127.0.0.1:${backendPort}`;
    const wsTarget = `ws://127.0.0.1:${backendPort}`;
    return {
      port: vitePort,
      strictPort: true,
      proxy: {
        "/api":     { target: httpTarget, changeOrigin: true },
        "/ws":      { target: wsTarget,   ws: true },
        "/events":  { target: httpTarget, changeOrigin: true },
        "/healthz": { target: httpTarget, changeOrigin: true },
      },
      watch: {
        // SQLite + the WAL / SHM sidecars churn on every chat turn,
        // background dispatch, and telemetry flush. Without this guard,
        // Vite's chokidar watcher fires "file changed" for `fleet.db`,
        // `fleet.db-wal`, and `fleet.db-shm` every few seconds and HMR
        // does a full page reload — which remounts the entire React tree
        // mid-conversation and feels like the app is broken. We also
        // exclude the per-worktree Tauri target dirs and the Cargo build
        // artefacts which can land in src-tauri/ during `cargo tauri dev`.
        ignored: [
          "**/src-tauri/fleet.db",
          "**/src-tauri/fleet.db-wal",
          "**/src-tauri/fleet.db-shm",
          "**/src-tauri/fleet.db-journal",
          "**/src-tauri/target/**",
          "**/.claude/worktrees/**",
          // Per-session worktrees that worktree-on sessions carve at
          // `<project>/.fleetify-worktrees/<id>/`. When this repo is itself
          // opened as a session folder (dogfooding), the worktree checkout
          // drops a full copy of the project — index.html, tsconfig.json,
          // src/ — straight into Vite's watched root. Vite then sees a
          // "new" index.html + tsconfig and force-reloads the page mid-send,
          // which reads as the app crashing + restarting (and tears down the
          // chat WebSocket, so the agent reply never lands). Ignore the
          // whole worktrees tree so carving one never reloads the dev UI.
          "**/.fleetify-worktrees/**",
        ],
      },
    };
  })(),
});
