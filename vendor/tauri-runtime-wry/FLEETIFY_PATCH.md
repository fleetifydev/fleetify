# Vendored `tauri-runtime-wry` — Fleetify patch

This directory is a **verbatim copy of `tauri-runtime-wry` 2.11.2** from crates.io
with exactly **one** behavioural change. It exists only so we can carry that change
via `[patch.crates-io]` (see the workspace root `Cargo.toml`). Everything else is
upstream, unmodified.

## Why

On Linux, Tauri creates a `WebviewKind::WindowChild` (what `window.add_child(...)`
produces — our right-panel embedded browser) by packing it into the main window's
**vertical `gtk::Box`** via `build_gtk(default_vbox)`:

```rust
WebviewKind::WindowChild => {
  let vbox = window.default_vbox().unwrap();
  webview_builder.build_gtk(vbox)        // ← stacks full-width, ignores bounds
}
```

A child packed into that `GtkBox` is laid out top-to-bottom and expands to fill —
so it renders **full-width below the main content** regardless of the `(x, y, w, h)`
we ask for, and wry's `set_bounds` becomes a **no-op** for it (`x11` data is unset
and the parent is a `GtkBox`, not a `GtkFixed`). Net effect: the embedded browser
cannot be placed in the right panel; it appears at the bottom of the window. macOS
and Windows are unaffected because they use the positioned `build_as_child` path.

Upstream, still open at time of writing:
- https://github.com/tauri-apps/tauri/issues/13071
- https://github.com/tauri-apps/tauri/issues/10420

## The change

`src/lib.rs`, the `WebviewKind::WindowChild` arm for non-Windows/macOS/iOS/Android
now routes genuine `add_child` children to the positioned `build_as_child` path
(wry `new_as_child` → an X11 child window whose `set_bounds` actually moves and
resizes it), while leaving the window's own content webview on upstream's vbox
path:

```rust
WebviewKind::WindowChild => {
  use raw_window_handle::HasWindowHandle as _;
  if window.window_handle().is_ok() {
    webview_builder.build_as_child(&window)      // realized window → embedded browser
  } else {
    let vbox = window.default_vbox().unwrap();    // not realized → window content webview
    webview_builder.build_gtk(vbox)               // == upstream behaviour
  }
}
```

### Why the `window_handle()` guard is load-bearing

Under the `unstable` feature (which we enable for `add_child`), Tauri creates the
**window's own content webview as a `WebviewKind::WindowChild` too** — not just
real `add_child` children (see the `create_window` path that selects
`WindowChild` under `cfg(feature = "unstable")`). That content webview is built
*while the window is still being created*, before it has a native handle. A naive
`build_as_child` there fails with `HandleError::Unavailable` ("the underlying
handle is not available") and the app comes up with a blank main window.

`window.window_handle().is_ok()` distinguishes the two cases cleanly:
- **unavailable** → the window's content webview during creation → keep the vbox
  path (byte-for-byte upstream behaviour, main window renders normally).
- **available** → a child added after the window exists (our embedded browser) →
  positioned child webview.

The `x11` feature is on by default here, so `build_as_child` → `new_as_child` →
`new_x11` is compiled (not the `UnsupportedWindowHandle` stub).

### Why this is safe for Fleetify specifically

- We **force `GDK_BACKEND=x11`** (`src-tauri/src/lib.rs`), so the app always runs
  under X11 / XWayland and `build_as_child` (X11-only) has a valid window handle.
- We ship **no GTK menu bar** (custom in-app title bar), so the upstream
  "only way to account for menu bar height" rationale for using the vbox does not
  apply to us.
- Our renderer drives the webview rect every frame (`workspace-panel.tsx`
  `syncBounds`), so we don't depend on vbox auto-resize.

Only `WindowChild` is changed. `WindowContent` (the main app webview) still uses
`build_gtk(default_vbox)` and fills the window as before.

## How to refresh on a Tauri bump

`[patch.crates-io]` requires this copy's version to equal the `tauri-runtime-wry`
that `tauri` depends on, otherwise Cargo silently ignores the patch.

1. `cargo tree -i tauri-runtime-wry` — note the new version.
2. Re-copy that version's `Cargo.toml`, `build.rs`, `README.md`, `LICENSE_*`,
   and `src/` from `~/.cargo/registry/src/.../tauri-runtime-wry-<version>/` over
   this directory.
3. Re-apply the one-line change above (search for the
   `// only way to account for menu bar height` comment).
4. Update the version note in the root `Cargo.toml` patch comment.
5. `cargo check -p fleetify` and run the app to confirm the right-panel browser
   still positions correctly.

## How to remove (once upstream is fixed)

When a Tauri release positions Linux child webviews correctly, delete this
`vendor/` directory and the `[patch.crates-io]` block in the root `Cargo.toml`.
No application code changes are needed — `add_child` / `set_bounds` are already
the right calls.
