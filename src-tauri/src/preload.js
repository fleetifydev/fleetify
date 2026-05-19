// Phase 0 boot shim. Real IPC (~56 channels + 7 events backed by Tauri
// commands/events) lands in Phase 1. A Proxy returns async no-ops for any
// not-yet-implemented channel so the unchanged React renderer boots without
// `window.fleetify` / `window.electronAPI` TypeErrors.
(function () {
  var asyncNoop = function () { return Promise.resolve(undefined); };
  var evNoop = function () { return function () {}; };
  var make = function (overrides) {
    return new Proxy(overrides, {
      get: function (t, k) {
        if (k in t) return t[k];
        if (typeof k === "string" && k.indexOf("on") === 0) return evNoop;
        return asyncNoop;
      },
    });
  };

  window.fleetify = make({
    getState: function () { return Promise.resolve({ signedIn: false }); },
    getAccessToken: function () { return Promise.resolve(null); },
    onAuthEvent: evNoop,
  });

  window.electronAPI = make({
    getConfig: function () { return Promise.resolve({}); },
    setConfig: asyncNoop,
  });
})();
