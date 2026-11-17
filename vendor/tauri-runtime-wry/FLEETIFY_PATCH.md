# Vendored `tauri-runtime-wry` — Fleetify patches

This directory is a **verbatim copy of `tauri-runtime-wry` 2.11.2** from crates.io
with two changes. It exists only so we can carry them via `[patch.crates-io]`
(see the workspace root `Cargo.toml`). Everything else is upstream, unmodified.
Each change is marked in `src/lib.rs`:

1. `FLEETIFY PATCH v2`: positioned child webviews on Linux (the right-panel
   browser). See [Patch v2](#patch-v2-positioned-child-webviews-on-linux).
2. `FLEETIFY PATCH postmessage-ipc` (security): on WebKitGTK, every
   postMessage IPC request gets an origin no capability matches, so a frame
   inside the app can't use the app page's permissions. See
   [Patch postmessage-ipc](#patch-postmessage-ipc-frames-cant-use-the-app-pages-permissions).

# Patch v2: positioned child webviews on Linux

## Why

On Linux, Tauri creates a `WebviewKind::WindowChild` (what `window.add_child(...)`
produces — our right-panel embedded browser) by packing it into the main window's
**vertical `gtk::Box`** via `build_gtk(default_vbox)`. A child packed into that
`GtkBox` is laid out top-to-bottom and expands to fill — so it renders
**full-width below the main content** regardless of the `(x, y, w, h)` we ask
for, and wry's `set_bounds` becomes a **no-op** for it. The embedded browser
cannot be placed in the right panel. macOS and Windows are unaffected (they use
positioned native child views).

Upstream, still open at time of writing:
- https://github.com/tauri-apps/tauri/issues/13071
- https://github.com/tauri-apps/tauri/issues/10420

### Patch v1 (removed) and why it was wrong

v1 routed `add_child` children to wry's `build_as_child` path: a **raw X11 child
window** (`XCreateSimpleWindow`) wrapped in a foreign `GdkWindow` inside a fake
toplevel `gtk::Window`. Positioning worked, but the webview lived **outside
GDK's pointer/focus tracking**, which broke three things at the root:

1. **Keyboard**: under Wayland/Mutter, X input focus stays on the app toplevel
   and nothing ever moves it to the raw child — GTK routed every key press to
   the main webview. Clicks reached the embed (X delivers pointer events by
   position), typing never did.
2. **Cursor**: WebKit's hover-cursor updates go through
   `gdk_window_set_cursor`, which only pushes the change to the device when GDK
   believes the pointer is over that window. GDK never tracked the foreign
   hierarchy, so cursor writes degraded to attribute-only `XDefineCursor` calls
   that XWayland renders **only on a real crossing** — the cursor stayed stuck
   (crosshair after element-select) until the mouse left and re-entered.
3. **Stability**: routine GDK X calls (`XTranslateCoordinates` for popups /
   inspector windows) raced the half-foreign construct and died with fatal
   `BadWindow` errors, killing the whole app.

## The change (v2)

Positioned children go into the window's **own GTK widget tree** — one real
toplevel, everything GDK-tracked, no X11 reparenting:

```
window → default_vbox → GtkOverlay
                          ├─ content webview   (overlay main child, auto-sized)
                          └─ GtkFixed "fleet-embed-fixed"  (pass-through layer)
                               └─ embedded webview(s) at absolute (x, y)
```

Three pieces in `src/lib.rs`:

1. **`WebviewKind::WindowChild` arm** (search `FLEETIFY PATCH v2`):
   - handle **unavailable** → the window's own content webview during creation
     → built into a fresh `GtkOverlay` packed into the vbox (the overlay's main
     child auto-sizes exactly like upstream's direct vbox packing). Wrapping at
     creation time matters: adding the overlay later would mean reparenting a
     *live* WebKitWebView, which loses its GL context and freezes the app.
   - handle **available** → a genuine `add_child` child (the embedded browser)
     → `build_gtk(&fixed)` into the shared `GtkFixed` layer
     (`fleet_embed_fixed_layer`), created on first use inside the overlay with
     `set_overlay_pass_through(true)` so empty areas of the layer don't eat the
     content webview's input. wry has first-class `GtkFixed` support: initial
     bounds via `fixed.put()`, later `set_bounds` via `size_allocate`.

2. **`fleet_sync_fixed_child`** (called from the `SetBounds` / `SetSize` /
   `SetPosition` handlers): mirrors each bounds change into the `GtkFixed`
   child properties (`move_` + `set_size_request`) so a container relayout
   (window resize) doesn't snap the webview back to stale coordinates. Skips
   the `move_` when coordinates are unchanged — `gtk_fixed_move` queue-resizes
   unconditionally and the renderer pushes bounds from a per-frame loop.

3. **`WebviewMessage::Close`**: destroys the gtk widget explicitly. Dropping
   the wrapper only destroys when the last clone dies; a clone held anywhere
   left a zombie webview painted over the app whose half-dead windows turned
   later GDK X calls into fatal `BadWindow` errors.

The `window_handle()` guard is load-bearing for the same reason as v1: under
the `unstable` feature the window's own content webview is *also* created as a
`WindowChild`, before the window has a native handle. That timing difference is
what distinguishes the two cases.

Companion app-side change (`src-tauri/src/lib.rs` `setup()`): a non-fatal X
error handler (`XSetErrorHandler`) — GDK's default aborts the process on any
async X error; teardown races on already-dead windows are logged and survived
instead.

Only `WindowChild` is changed. `WindowContent` (the non-`unstable` main webview
path) is byte-for-byte upstream.

# Patch postmessage-ipc: frames can't use the app page's permissions

## Why

Tauri 2.11.2 accepts IPC two ways: the `ipc://` custom protocol, and wry's
postMessage channel (`window.ipc.postMessage`, on WebKitGTK
`window.webkit.messageHandlers.ipc`). On WebKitGTK the postMessage channel
can't tell frames apart:

1. **wry tags every message with the main frame's URL.** wry 0.55's WebKitGTK
   backend builds each request with `webview.uri()`, whichever frame posted it
   (`src/webkitgtk/mod.rs`, `attach_ipc_handler`).
2. **Tauri takes that URL as the origin and checks only the invoke key.**
   `ipc/protocol.rs` (`handle_ipc_message`) uses the request's URI as the
   origin; `Webview::on_message` compares the key, then resolves the ACL for
   that origin.
3. **The key isn't a secret from pages.** Tauri injects `ipc-protocol.js`,
   which holds the app's one invoke key, into every webview it builds, the
   right-panel browser included, so a page loaded there can capture it.
4. **So a frame gets the app page's permissions.** A cross-origin frame
   inside the main webview (the Preview pane, showing a project's dev server
   or any typed URL) that holds the key can post a request for any command
   the app page has: since the release grant, every app command, `pty_spawn`
   included.

macOS and Windows are not affected: wry reports the sending frame's own URL
on macOS (`WKScriptMessage.frameInfo`), and WebView2 tags messages with the
top document's URL, where frames can't post. The `ipc://` path isn't either:
its requests carry the sending frame's own `Origin`, which the ACL refuses.

## The change

In `src/lib.rs` (search `FLEETIFY PATCH postmessage-ipc`):

- `postmessage_ipc_request(request, webkitgtk)`: on WebKitGTK it replaces the
  request's URI with `POSTMESSAGE_IPC_ORIGIN`
  (`http://postmessage-ipc.invalid/`) and leaves the message alone; elsewhere
  it returns the request unchanged. `WEBKITGTK` says which builds rewrite.
- `create_ipc_handler` passes every request through it before handing it to
  Tauri.

No capability matches that origin and `.invalid` never resolves, so Tauri
refuses every command such a request asks for, with its usual "not allowed"
error through the caller's error callback. The app's own IPC keeps working
through `ipc://`. All three are `#[doc(hidden)] pub` so the app's tests
(`src-tauri/src/shell/startup_window.rs`, "IPC from frames inside the app")
can check the rewrite, check the origin against the app's real ACL, and check
that `create_ipc_handler` still calls it.

**Rewritten, not dropped:** `ipc-protocol.js` moves a page to postMessage for
good after one failed custom-protocol request. A dropped message would leave
the caller's promise pending forever; a refusal surfaces as an error.

# How to refresh on a Tauri bump

`[patch.crates-io]` requires this copy's version to equal the
`tauri-runtime-wry` that `tauri` depends on, otherwise Cargo silently ignores
the patch.

1. `cargo tree -i tauri-runtime-wry` — note the new version.
2. Re-copy that version's `Cargo.toml`, `build.rs`, `README.md`, `LICENSE_*`,
   and `src/` from `~/.cargo/registry/src/.../tauri-runtime-wry-<version>/`
   over this directory.
3. Re-apply both patches. Grep this repo's git history for `FLEETIFY PATCH`
   to recover the full diffs.
   - v2: search upstream for the `// only way to account for menu bar height`
     comment for the WindowChild arm.
   - postmessage-ipc: the three items go before `create_ipc_handler`, and its
     closure starts with `let request = postmessage_ipc_request(request,
     WEBKITGTK);`. First check that the new wry still tags WebKitGTK messages
     with `webview.uri()` and that Tauri still takes the request's URI as
     the origin; if either changed, re-assess rather than re-apply blindly.
4. Update the version note in the root `Cargo.toml` patch comment.
5. `cargo test -p fleetify-app startup_window`: the postmessage-ipc tests
   don't compile without the patch's items and fail if the handler stops
   calling the rewrite.
6. Run the app and drive the right-panel browser: position/resize,
   element-select typing + cursor, close panel (no zombie frame), open the
   page inspector (no crash). Check that the app's own IPC still works on
   Linux (it goes through `ipc://`).

# How to remove (once upstream is fixed)

- **v2:** when a Tauri release positions Linux child webviews correctly
  **with working keyboard focus and cursor updates**. No application code
  changes are needed: `add_child` / `set_bounds` are already the right calls.
- **postmessage-ipc:** when wry's WebKitGTK backend reports the sending
  frame's own URL (or Tauri stops trusting the postMessage URL), and the
  app's tests are moved to whatever upstream offers.

Once both are gone, delete this `vendor/` directory and the
`[patch.crates-io]` block in the root `Cargo.toml`.
