"""Fleetify sidecar wrapper around `google.antigravity` (the Python SDK).

Protocol
--------

Stdin: ONE JSON object terminated by `\n`. Shape:

    {
        "prompt": str,                          # required — the user turn
        "model": str | null,                    # optional — SDK model id
                                                #   ("gemini-3.5-flash",
                                                #    "claude-sonnet-4-6", ...).
                                                #   When null/missing, the SDK
                                                #   uses its built-in default.
        "api_key": str | null,                  # optional — GEMINI_API_KEY
                                                #   override; falls back to the
                                                #   `GEMINI_API_KEY` env var.
        "conversation_id": str | null,          # optional — resume an existing
                                                #   `Conversation` UUID.
        "workspaces": [str, ...] | null,        # optional — list of dirs the
                                                #   agent may read/write under.
                                                #   Defaults to [cwd].
        "app_data_dir": str | null,             # optional — override the SDK's
                                                #   per-instance scratch dir.
        "mode": "chat" | "accept_edits" | "autonomous",  # optional — tool autonomy:
                                                #   "chat" → reads allowed,
                                                #     writes + shell denied.
                                                #     The default for new
                                                #     sessions; agent can
                                                #     suggest code but can't
                                                #     apply it.
                                                #   "accept_edits" → reads +
                                                #     writes allowed; shell
                                                #     still denied.
                                                #   "autonomous" → all tools
                                                #     allowed without prompts.
                                                #   Anything unrecognised
                                                #     (older callers sending
                                                #     "default" / "") falls
                                                #     through to "chat".
        "system_instructions": str | null,      # optional — LocalAgentConfig system prompt
        "mcp_servers": [                         # optional — transport-tagged servers
            {"name": str, "transport": "stdio", "command": str, "args": [str]} |
            {"name": str, "transport": "sse"|"http", "url": str, "headers": {str: str}}
        ] | null,
    }

Stdout: NEWLINE-DELIMITED JSON events. One event per line. Examples:

    {"type": "init", "model": "gemini-3.5-flash"}
    {"type": "delta", "text": "Hi "}
    {"type": "delta", "text": "there!"}
    {"type": "thinking", "text": "..."}
    {"type": "tool_start", "tool_id": "...", "name": "...", "input": {...}}
    {"type": "tool_end", "tool_id": "...", "output": "...", "is_error": false}
    {"type": "conversation_id", "id": "<uuid>"}
    {"type": "usage", "input_tokens": 123, "output_tokens": 45}
    {"type": "done"}
    {"type": "error", "message": "..."}

The Rust bridge (`bridges/antigravity_sdk.rs`) parses each line, maps to
`BridgeEvent`, and forwards via the existing chat WS channel. The
sidecar exits as soon as the SDK turn finishes — one process per turn.

Why a separate process per turn (not a long-lived daemon)
---------------------------------------------------------

The SDK's `LocalAgentConfig` snapshots model / api_key / conversation_id
at construction time. Changing the model mid-session means a fresh
`Agent(config)`, which means a fresh process is the simplest unit. Cost
is the Python interpreter startup (~80ms) — negligible next to the
SDK's HTTPS round-trip to Google's backend.

Python resolution
-----------------

Phase 1 ships system-Python only. The bridge tries (in order):
  1. `FLEETIFY_EMBEDDED_PYTHON` env var — manual override for power
     users and CI runners that want to pin a specific interpreter
     without altering PATH.
  2. `python3` on PATH.
  3. `python` on PATH (Windows often resolves the launcher here).
When none is available, Settings → Agents → Antigravity SDK shows a
clean "Install Python" instruction. Future versions may add lazy
download of a per-user `python-build-standalone` distribution as an
opt-in toggle — the bridge already honours the env var, so that work
slots in without rewriting this script.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from typing import Any

# A clean error surfaces back through the JSON event stream rather
# than the bridge seeing a Python traceback (which it can't pretty-
# print). The user gets a one-line "install google-antigravity" tip.
try:
    from google.antigravity import (
        Agent,
        LocalAgentConfig,
        ModelConfig,
        ModelEntry,
        GeminiConfig,
        types as ag_types,
    )
    # `policy` and `CapabilitiesConfig` are the autonomy knobs. They
    # arrived in the SDK after the initial release; older installs may
    # not have them. Import optionally — when missing we fall back to
    # SDK defaults, which means the "mode" knob silently no-ops (the
    # bridge still works, just without autonomy control).
    try:
        from google.antigravity import policy as ag_policy  # type: ignore[attr-defined]
    except ImportError:
        ag_policy = None  # type: ignore[assignment]
except ModuleNotFoundError as exc:  # noqa: BLE001
    sys.stdout.write(
        json.dumps(
            {
                "type": "error",
                "message": (
                    "google-antigravity is not installed in this Python "
                    "interpreter. Run `pip install google-antigravity` "
                    f"(detail: {exc})."
                ),
            }
        )
        + "\n"
    )
    sys.stdout.write(json.dumps({"type": "done"}) + "\n")
    sys.exit(0)


def _emit(event: dict[str, Any]) -> None:
    """Write one JSON event to stdout + flush.

    Flushing matters: the Rust bridge reads line-by-line and dispatches
    each line to the WS as it arrives. Without an explicit flush after
    every event, Python's line buffering can hold tokens for seconds
    even though the SDK has already produced them, making streaming
    look broken.
    """
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _strip_effort_suffix(model_id: str) -> str:
    """The Fleetify picker uses ids like `gemini-3.5-flash-medium`
    (effort baked into the id). The SDK's `LocalAgentConfig(model=...)`
    accepts the BASE model name (`gemini-3.5-flash`) — effort lives on
    a separate field (`GenerationConfig.thinking_level`) that we don't
    expose to the picker yet. Strip the suffix so the SDK accepts the
    string.
    """
    for suffix in ("-thinking", "-medium", "-high", "-low"):
        if model_id.endswith(suffix):
            return model_id[: -len(suffix)]
    return model_id


def _apply_autonomy_mode(kwargs: dict[str, Any], mode: str) -> None:
    """Configure `capabilities` + `policies` on the LocalAgentConfig
    based on the autonomy mode the bridge requested.

    Three tiers, mirroring Fleetify's `Mode` enum so a user's Perms chip
    selection means the same thing whether the session targets an HTTP
    provider or the SDK:

    - `"chat"`: read tools (view_file, list_dir, grep) allowed;
      edit_file, write_file, run_command explicitly denied. The model
      sees the denials as tool errors and adapts ("I'd write but you
      have me in chat mode — here's the code instead"). Default for new
      sessions: every session gets workspace context AND read access on
      day one; the user opts up to writes / shell via the Perms chip.
    - `"accept_edits"`: read + write tools allowed (view_file, list_dir,
      grep, edit_file, write_file); shell still denied. Middle ground.
    - `"autonomous"`: write capabilities enabled, all tools auto-allowed
      via `allow_all()`. The user accepts responsibility; the renderer
      surfaces a Stop button to abort runaway loops.
    - anything else (missing field, unknown value, legacy `"default"`):
      falls through to "chat" — the safest tier that still gives the
      model context. NEVER leaves SDK defaults in place, because the
      stock `confirm_run_command` policy would hang on stdin in our
      headless sidecar.

    Both `policy` and `CapabilitiesConfig` are gated on SDK version —
    if either is missing on the installed SDK we silently no-op and
    fall back to SDK defaults. The bridge keeps working; the user just
    doesn't get tool autonomy until they upgrade the SDK.
    """
    if ag_policy is None:
        return

    CapabilitiesConfig = getattr(ag_types, "CapabilitiesConfig", None)

    if mode == "autonomous":
        # `CapabilitiesConfig()` with no args enables all writes per the
        # SDK README; we mirror that to avoid hardcoding individual
        # field names that may drift between SDK versions.
        if CapabilitiesConfig is not None:
            kwargs["capabilities"] = CapabilitiesConfig()
        # `allow_all` is the SDK's documented "unrestricted" policy.
        # Every tool call goes through without the human-in-the-loop
        # confirm prompt — matches Fleetify's Autonomous contract.
        kwargs["policies"] = [ag_policy.allow_all()]
        return

    if mode == "accept_edits":
        # Same write-capability shape as autonomous (the SDK has no
        # finer-grained switch for "edits but not shell" on
        # CapabilitiesConfig), but the policies allow-list excludes
        # run_command so the model gets a clean tool-error for shell
        # attempts and can adapt.
        if CapabilitiesConfig is not None:
            kwargs["capabilities"] = CapabilitiesConfig()
        kwargs["policies"] = [
            ag_policy.allow("view_file"),
            ag_policy.allow("list_dir"),
            ag_policy.allow("grep"),
            ag_policy.allow("edit_file"),
            ag_policy.allow("write_file"),
            ag_policy.deny("run_command"),
        ]
        return

    # "chat" — and everything we don't recognise (including legacy
    # callers still sending "default"). Read-only.
    if CapabilitiesConfig is not None:
        # Default capabilities: writes off, so edit_file / write_file
        # aren't even available for the model to call.
        kwargs["capabilities"] = CapabilitiesConfig()
    kwargs["policies"] = [
        ag_policy.allow("view_file"),
        ag_policy.allow("list_dir"),
        ag_policy.allow("grep"),
        ag_policy.deny("edit_file"),
        ag_policy.deny("write_file"),
        ag_policy.deny("run_command"),
    ]


def _patch_mcp_stdio_env() -> None:
    """Re-inject FLEETIFY_* into stdio MCP child environments.

    The SDK launches stdio MCP servers via `mcp.client.stdio` with
    `StdioServerParameters(command, args)` (env=None), so the MCP SDK uses
    `get_default_environment()`, which scrubs to a safe allowlist and DROPS
    FLEETIFY_* (verified empirically). McpStdioServer has no `env` field, so
    we patch the default-env function to re-add the trio (read from THIS
    process's env, set by the Rust bridge). Without this, fleet MCPs connect
    but have no session id -> memory/dispatch route to the wrong/no session.
    """
    try:
        import mcp.client.stdio as _mcp_stdio
    except Exception as exc:  # noqa: BLE001
        _emit({"type": "error", "message": (
            f"warning: MCP stdio module unavailable ({exc}); "
            "fleet MCP session routing may not work")})
        return
    orig = getattr(_mcp_stdio, "get_default_environment", None)
    if orig is None:
        _emit({"type": "error", "message": (
            "warning: mcp.client.stdio.get_default_environment missing on this "
            "MCP SDK version; fleet MCP session routing may not work")})
        return

    def _fleet_default_env():
        e = dict(orig())
        for k in ("FLEETIFY_SESSION_ID", "FLEETIFY_BACKEND_URL", "FLEETIFY_INTERNAL_SECRET"):
            v = os.environ.get(k)
            if v:
                e[k] = v
        return e

    _mcp_stdio.get_default_environment = _fleet_default_env


def _make_mcp_server(spec: dict[str, Any]) -> Any:
    """Build the matching SDK MCP server type from a transport-tagged spec."""
    transport = spec.get("transport")
    name = spec.get("name")
    if transport == "stdio":
        return ag_types.McpStdioServer(
            name=name,
            command=spec["command"],
            args=list(spec.get("args") or []),
        )
    if transport == "sse":
        kwargs = {"name": name, "url": spec["url"]}
        if spec.get("headers"):
            kwargs["headers"] = spec["headers"]
        return ag_types.McpSseServer(**kwargs)
    if transport == "http":
        kwargs = {"name": name, "url": spec["url"]}
        if spec.get("headers"):
            kwargs["headers"] = spec["headers"]
        return ag_types.McpStreamableHttpServer(**kwargs)
    raise ValueError(f"unknown MCP transport {transport!r} for server {name!r}")


def _build_config(req: dict[str, Any]) -> LocalAgentConfig:
    """Translate the inbound JSON request into a `LocalAgentConfig`.

    Field-by-field rather than `LocalAgentConfig(**req)` because the
    request uses our wire field names (snake_case + Fleetify-specific
    semantics) and the SDK has its own shape — keeping the translation
    explicit makes a future SDK schema change a one-spot edit.
    """
    kwargs: dict[str, Any] = {}

    raw_model = req.get("model")
    if raw_model:
        sdk_model = _strip_effort_suffix(raw_model)
        kwargs["gemini_config"] = GeminiConfig(
            api_key=req.get("api_key") or None,
            models=ModelConfig(default=ModelEntry(name=sdk_model)),
        )
    elif req.get("api_key"):
        kwargs["gemini_config"] = GeminiConfig(api_key=req["api_key"])

    if req.get("conversation_id"):
        kwargs["conversation_id"] = req["conversation_id"]
    if req.get("workspaces"):
        kwargs["workspaces"] = list(req["workspaces"])
    if req.get("app_data_dir"):
        kwargs["app_data_dir"] = req["app_data_dir"]

    sys_instr = req.get("system_instructions")
    if sys_instr:
        kwargs["system_instructions"] = sys_instr

    mcp_specs = req.get("mcp_servers")
    if mcp_specs:
        servers = []
        for spec in mcp_specs:
            try:
                servers.append(_make_mcp_server(spec))
            except Exception as exc:  # noqa: BLE001 — one bad server must not sink the turn
                _emit({"type": "error",
                       "message": f"skipping MCP server {spec.get('name')!r}: {exc}"})
        if servers:
            kwargs["mcp_servers"] = servers

    _apply_autonomy_mode(kwargs, str(req.get("mode") or "chat"))

    return LocalAgentConfig(**kwargs)


async def _run_turn(req: dict[str, Any]) -> None:
    """One-shot: open the Agent, send the prompt, stream events out,
    close cleanly. Errors are surfaced as `{type:"error"}` so the
    Rust bridge can render them as an error bubble instead of treating
    the process exit as a silent failure.
    """
    _patch_mcp_stdio_env()
    try:
        config = _build_config(req)
    except Exception as exc:  # noqa: BLE001 — surface ANY config error
        _emit({"type": "error", "message": f"config build failed: {exc}"})
        _emit({"type": "done"})
        return

    raw_model = req.get("model") or "default"
    _emit({"type": "init", "model": raw_model})

    try:
        async with Agent(config) as agent:
            # Forward the SDK's streaming iterator one chunk at a time.
            # Different SDK versions expose this differently; try the
            # canonical `chat()` first and fall back gracefully.
            response = await agent.chat(req["prompt"])

            # Token-by-token streaming via async iteration. The SDK
            # README documents `async for chunk in response: ...`;
            # each chunk is a small string (a delta). We forward each
            # one as its own `{type:"delta"}` event so the renderer's
            # 16ms-coalescing buffer can show a typewriter effect.
            had_text = False
            try:
                async for chunk in response:  # type: ignore[union-attr]
                    if not chunk:
                        continue
                    # Some SDK builds yield strings; others yield richer
                    # objects with `.text` / `.delta` attrs. Be tolerant.
                    text: str
                    if isinstance(chunk, str):
                        text = chunk
                    elif hasattr(chunk, "text"):
                        text = str(chunk.text or "")
                    elif hasattr(chunk, "delta"):
                        text = str(chunk.delta or "")
                    else:
                        text = str(chunk)
                    if text:
                        had_text = True
                        _emit({"type": "delta", "text": text})
            except TypeError:
                # `response` isn't async-iterable — fall back to the
                # single-shot `.text()` accessor. Same observable
                # behavior, just no incremental rendering.
                full = await response.text()
                if full:
                    had_text = True
                    _emit({"type": "delta", "text": full})

            # If the SDK never streamed any chunks (some early versions
            # do this for short replies), pull the aggregated text as
            # a final fallback so the user always sees a bubble.
            if not had_text:
                try:
                    full = await response.text()
                    if full:
                        _emit({"type": "delta", "text": full})
                except Exception:  # noqa: BLE001
                    pass

            # Surface the SDK-managed conversation id so the Rust
            # bridge can persist it for the next turn (via the same
            # Mutex<Option<String>> pattern the agy CLI bridge uses).
            try:
                conv = getattr(agent.conversation, "id", None) or getattr(
                    agent, "conversation_id", None
                )
                if conv:
                    _emit({"type": "conversation_id", "id": str(conv)})
            except Exception:  # noqa: BLE001
                pass

            # Optional usage stats from the SDK. Different versions
            # expose UsageMetadata differently — best-effort.
            try:
                usage = getattr(response, "usage", None) or getattr(
                    agent, "usage_metadata", None
                )
                if usage and isinstance(usage, dict):
                    _emit({"type": "usage", **usage})
                elif usage is not None:
                    _emit({"type": "usage", "raw": str(usage)})
            except Exception:  # noqa: BLE001
                pass
    except getattr(ag_types, "AntigravityValidationError", Exception) as exc:  # type: ignore[arg-type]
        # The SDK validates API key + model at Agent.__aenter__ time.
        # Surface those errors specifically so the renderer can route
        # the user back to the Settings → Agents → Antigravity SDK
        # card for fixup.
        _emit(
            {
                "type": "error",
                "message": (
                    f"Antigravity SDK validation error: {exc}. "
                    "Open Settings → Agents → Antigravity SDK and "
                    "verify your Gemini API key."
                ),
            }
        )
    except Exception as exc:  # noqa: BLE001 — anything else surfaces verbatim
        tb = traceback.format_exc(limit=4)
        _emit(
            {
                "type": "error",
                "message": f"{type(exc).__name__}: {exc}\n{tb}",
            }
        )
    finally:
        _emit({"type": "done"})


def main() -> int:
    raw = sys.stdin.readline()
    if not raw.strip():
        _emit({"type": "error", "message": "empty stdin — expected JSON request"})
        _emit({"type": "done"})
        return 0
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        _emit({"type": "error", "message": f"invalid JSON request: {exc}"})
        _emit({"type": "done"})
        return 0

    if "prompt" not in req or not isinstance(req["prompt"], str):
        _emit({"type": "error", "message": "request missing required string field `prompt`"})
        _emit({"type": "done"})
        return 0

    # Hand off the GEMINI_API_KEY via env when not provided inline,
    # matching the SDK's own resolution order so a single source of
    # truth (the Fleetify keychain) flows through cleanly.
    if req.get("api_key") and "GEMINI_API_KEY" not in os.environ:
        os.environ["GEMINI_API_KEY"] = req["api_key"]

    asyncio.run(_run_turn(req))
    return 0


if __name__ == "__main__":
    sys.exit(main())
