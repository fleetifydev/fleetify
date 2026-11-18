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
    // The only renderer is WebView2 (Chromium/Edge) on Windows + recent
    // WKWebView on macOS — both ship modern ES. Skip legacy down-levelling
    // so output stays smaller and parses faster on low-end machines.
    target: "chrome105",
    // Don't gzip every emitted chunk just to print a size report; it adds
    // build time and the real numbers come from the visualizer / brotli at
    // ship time.
    reportCompressedSize: false,
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
          // KaTeX math rendering — large JS + (lazily fetched) font
          // payload. Only chat messages containing math touch it; isolate
          // it so it never sits in the entry or vendor-markdown chunk.
          if (id.match(/node_modules\/(katex|rehype-katex|remark-math|mdast-util-math|micromark-extension-math|hast-util-to-text)\//)) {
            return "vendor-katex";
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
    // Absolute, forward-slash root of THIS dev server (the worktree or main
    // checkout we're editing). Used to anchor the worktree watch-ignores
    // below so they only match NESTED worktrees, never the checkout itself.
    const root = process.cwd().replace(/\\/g, "/");
    return {
      port: vitePort,
      strictPort: true,
      // changeOrigin on every entry: the backend answers only requests
      // whose Host is its own (127.0.0.1:<backend port>), WebSockets too.
      proxy: {
        "/api":     { target: httpTarget, changeOrigin: true },
        "/ws":      { target: wsTarget,   ws: true, changeOrigin: true },
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
        // exclude every Cargo `target/` dir. The workspace target lives at
        // the *repo root* (`<root>/target/`), not under src-tauri/, and with
        // `local-whisper` enabled it holds the whisper-rs-sys → ggml CMake
        // build tree (~7k dirs of .o/.cmake churn). Letting chokidar recurse
        // into it adds thousands of inotify watches on build artefacts that
        // race with `cargo build`'s writes, blowing past
        // `fs.inotify.max_user_watches` → "ENOSPC: System limit for number
        // of file watchers reached" and killing the dev server. `**/target/**`
        // covers the root target, any per-crate target, and src-tauri/target.
        ignored: [
          "**/src-tauri/fleet.db",
          "**/src-tauri/fleet.db-wal",
          "**/src-tauri/fleet.db-shm",
          "**/src-tauri/fleet.db-journal",
          "**/target/**",
          // Ignore worktrees the app carves UNDER this dev server's root —
          // per-session `<project>/.fleetify-worktrees/<id>/` checkouts (which
          // a dogfooding session drops a full copy of the project into:
          // index.html, tsconfig.json, src/ — Vite would see them as "new"
          // files and force-reload mid-send, tearing down the chat WebSocket),
          // plus `.claude/worktrees/`.
          //
          // These MUST be anchored to `root`. A plain `**/.fleetify-worktrees/**`
          // glob also matches the dev server's OWN source whenever
          // `dev:tauri:wt` runs from inside a linked worktree — its absolute
          // path contains `.fleetify-worktrees/`, so Vite silently ignored
          // every source file and HMR never fired (every edit needed a manual
          // restart). Anchoring to `root` ignores only nested worktrees and
          // keeps the checkout we're actually editing watched.
          (p: string) => {
            const np = p.replace(/\\/g, "/");
            const under = (dir: string) => np === dir || np.startsWith(`${dir}/`);
            return under(`${root}/.fleetify-worktrees`) || under(`${root}/.claude/worktrees`);
          },
        ],
      },
    };
  })(),
});
