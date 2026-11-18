# Vendored `tauri-runtime-wry` — Fleetify patches

This directory is a **verbatim copy of `tauri-runtime-wry` 2.11.2** from crates.io
with three changes. It exists only so we can carry them via `[patch.crates-io]`
(see the workspace root `Cargo.toml`). Everything else is upstream, unmodified.
Each change is marked in `src/lib.rs`:

1. `FLEETIFY PATCH v2`: positioned child webviews on Linux (the right-panel
   browser). See [Patch v2](#patch-v2-positioned-child-webviews-on-linux).
2. `FLEETIFY PATCH postmessage-ipc` (security): on WebKitGTK, every
   postMessage IPC request gets an origin no capability matches, so a frame
   inside the app can't use the app page's permissions. See
   [Patch postmessage-ipc](#patch-postmessage-ipc-frames-cant-use-the-app-pages-permissions).
3. `FLEETIFY PATCH ipc-free-webview` (security): the Browser panel's webview
   (label `browser-embed`) gets no Tauri IPC: no handler, none of Tauri's
   initialization scripts, and no `ipc` scheme where schemes are per webview.
   See [Patch ipc-free-webview](#patch-ipc-free-webview-the-browser-panel-gets-no-tauri-ipc).

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

# Patch ipc-free-webview: the Browser panel gets no Tauri IPC

## Why

The Browser panel is a child webview of the main window, labelled
`browser-embed` (`BROWSER_EMBED_LABEL` in `src-tauri/src/shell/ipc/mod.rs`).
It shows whatever site the user or an agent opens. Tauri 2.11.2 builds every
webview the same way, with no per-webview switch (`manager/webview.rs`,
`prepare_pending_webview` and `prepare_webview`):

- an IPC handler for postMessage requests;
- its initialization scripts, ahead of the app's: `__TAURI_INTERNALS__`, the
  `withGlobalTauri` API (`__TAURI__`), the IPC and event glue, plugin scripts,
  and `core.js`, which holds the app's invoke key;
- its `ipc` custom scheme.

The panel uses none of them:

- its one script, `SELECT_JS`, reports back by navigating to
  `https://fleet.internal/{pick|meta|read}/…`; the app's `on_navigation`
  handler reads the payload and cancels the navigation;
- the app drives it from Rust with native calls: `eval`, `navigate`,
  `set_bounds`, `close`, `clear_all_browsing_data`;
- its URL reaches the app through the native `on_page_load` handler.

The ACL already gives this webview no command: `capabilities/default.json`
applies to the main webview only, and `startup_window.rs` tests that. With
IPC gone as well, pages in the panel never get the invoke key, and nothing
they send reaches Tauri's command handling. That includes channel data
(`plugin:__TAURI_CHANNEL__|fetch`), which Tauri serves without an ACL check;
the app uses no `Channel` today.

## The change

In `src/lib.rs` (search `FLEETIFY PATCH ipc-free-webview`):

- `IPC_FREE_WEBVIEW_LABEL` (`"browser-embed"`), `IPC_FREE_SCRIPT_MARKER`
  (`"/* fleetify:browser-embed */"`) and
  `keep_script_in_ipc_free_webview(script)`, which accepts a script only if it
  starts with the marker, after any whitespace. All three sit just before
  `create_webview` and are `#[doc(hidden)] pub` for the app's tests.
- In `create_webview`, for the webview with that label (`ipc_free`):
  - no `with_ipc_handler(create_ipc_handler(…))`;
  - the initialization-script loop skips every script
    `keep_script_in_ipc_free_webview` rejects. Only the app's marked scripts
    remain; `SELECT_JS` starts with the marker line.
  - on macOS and Windows, the custom-protocol loop skips `ipc`.

What is left, per platform:

- **Linux (WebKitGTK):** custom schemes are registered once per web context,
  and the panel shares the app webview's (same data directory), so `ipc://`
  still answers there. The panel's requests have no invoke key, and Tauri
  refuses a request without the right key before it looks at the command
  (`ipc/protocol.rs`, `Webview::on_message`). wry still registers its `ipc`
  message handler and defines `window.ipc`, but with no handler it discards
  every message.
- **macOS:** wry still defines `window.ipc`, but there is no `ipc` message
  handler behind it and no `ipc` scheme.
- **Windows:** wry still defines `window.ipc` and listens for messages, but
  with no handler it discards them. With no `ipc` scheme, requests to
  `http://ipc.localhost` from the panel aren't intercepted.

The app's tests (`src-tauri/src/shell/startup_window.rs`, "The Browser panel
gets no Tauri IPC") check that the app's label and `SELECT_JS` match the
patch, run `keep_script_in_ipc_free_webview` on `SELECT_JS` and on scripts
like Tauri's, and check that `create_webview` keeps the three call sites, in
order.

# How to refresh on a Tauri bump

`[patch.crates-io]` requires this copy's version to equal the
`tauri-runtime-wry` that `tauri` depends on, otherwise Cargo silently ignores
the patch.

1. `cargo tree -i tauri-runtime-wry` — note the new version.
2. Re-copy that version's `Cargo.toml`, `build.rs`, `README.md`, `LICENSE_*`,
   and `src/` from `~/.cargo/registry/src/.../tauri-runtime-wry-<version>/`
   over this directory.
3. Re-apply the patches. Grep this repo's git history for `FLEETIFY PATCH`
   to recover the full diffs.
   - v2: search upstream for the `// only way to account for menu bar height`
     comment for the WindowChild arm.
   - postmessage-ipc: the three items go before `create_ipc_handler`, and its
     closure starts with `let request = postmessage_ipc_request(request,
     WEBKITGTK);`. First check that the new wry still tags WebKitGTK messages
     with `webview.uri()` and that Tauri still takes the request's URI as
     the origin; if either changed, re-assess rather than re-apply blindly.
   - ipc-free-webview: the three items go before `create_webview`. In
     `create_webview`, set `let ipc_free = label == IPC_FREE_WEBVIEW_LABEL;`,
     wrap the `with_ipc_handler(create_ipc_handler(…))` call in
     `if !ipc_free`, skip rejected scripts at the top of the
     `webview_attributes.initialization_scripts` loop, and skip `ipc` at the
     top of the `uri_scheme_protocols` loop outside the WebKitGTK targets.
     First check that Tauri still hands over its own scripts in
     `initialization_scripts` and registers `ipc` through
     `uri_scheme_protocols`, and that it added no other way for a webview to
     reach IPC; if it did, re-assess.
4. Update the version note in the root `Cargo.toml` patch comment.
5. `cargo test -p fleetify-app startup_window`: the postmessage-ipc and
   ipc-free-webview tests don't compile without the patches' items, and
   fail if the handler stops calling the rewrite or `create_webview` loses
   one of its three call sites.
6. Run the app and drive the right-panel browser: position/resize,
   element-select typing + cursor, close panel (no zombie frame), open the
   page inspector (no crash). Check that the app's own IPC still works on
   Linux (it goes through `ipc://`). Open a page in the Browser panel that
   shows `typeof window.__TAURI_INTERNALS__`: it must be `undefined`, and
   Select must still hand a picked element to the chat.

# How to remove (once upstream is fixed)

- **v2:** when a Tauri release positions Linux child webviews correctly
  **with working keyboard focus and cursor updates**. No application code
  changes are needed: `add_child` / `set_bounds` are already the right calls.
- **postmessage-ipc:** when wry's WebKitGTK backend reports the sending
  frame's own URL (or Tauri stops trusting the postMessage URL), and the
  app's tests are moved to whatever upstream offers.
- **ipc-free-webview:** when Tauri can build a webview with no IPC handler,
  scripts or `ipc` scheme, and the Browser panel is built that way.

Once all three are gone, delete this `vendor/` directory and the
`[patch.crates-io]` block in the root `Cargo.toml`.
