/**
 * RemoteSshPanel — Remote tab of the source picker.
 *
 * MVP scope (per the user's "ilk olarak ssh bağlantısından
 * bahsediyorum sonrasında genişleteceğiz"): manage a list of saved
 * SSH targets, test the connection, browse the remote filesystem,
 * and commit a workspace path to the session as
 * `ssh://user@host:port/abs/path`.
 *
 * The path scheme is a frontend marker only — backend agent execution
 * over SSH isn't wired yet. The marker lets the rest of the app
 * recognise a remote workspace and decide what to do with it later
 * (display badge, gate certain UI, etc.) without us having to
 * retrofit those call sites today.
 *
 * Hosts persist in localStorage at "fleet:ssh-hosts" — a flat array
 * of {id, host, user, port, identity_file}. No backend storage yet;
 * the user can re-export hosts later if/when we move to the server.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight, ChevronDown, FolderOpen, Plus, Server,
  Trash2, Check, AlertCircle, Loader2, ArrowLeft,
} from "lucide-react";
import { sshTest, sshListDir, sshKnownHosts, type SshTarget, type SshDirEntry } from "@/lib/api";

interface SshHost {
  id: string;
  host: string;
  user: string;
  port: number;
  identity_file?: string;
  /** Source — "manual" was added in-app, "config" was discovered
   *  from ~/.ssh/config. Lets the UI label the latter so the user
   *  knows where it came from. Config-sourced hosts can still be
   *  edited / forgotten just like manual ones (forgetting just
   *  hides them from this list, the underlying file is untouched). */
  source?: "manual" | "config";
  /** Display label — Host alias from ssh_config when available,
   *  falls back to the host string. */
  label?: string;
}

const STORAGE_KEY        = "fleet:ssh-hosts";
const HIDDEN_CONFIG_KEY  = "fleet:ssh-hosts-hidden";

function loadHosts(): SshHost[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHosts(hosts: SshHost[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts)); } catch { /* noop */ }
}

/** Stable id for a config-sourced host so React keys stay sane and
 *  so we can remember which discovered hosts the user has hidden
 *  ("forget" on a discovered host shouldn't keep adding it back on
 *  every refresh of the SSH config). */
function configHostId(label: string, host: string, user: string, port: number): string {
  return `cfg:${label}:${user}@${host}:${port}`;
}

function loadHiddenConfigIds(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_CONFIG_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveHiddenConfigIds(ids: Set<string>) {
  try { localStorage.setItem(HIDDEN_CONFIG_KEY, JSON.stringify(Array.from(ids))); } catch { /* noop */ }
}

function buildRemoteUrl(host: SshHost, path: string): string {
  const port = host.port === 22 ? "" : `:${host.port}`;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `ssh://${host.user}@${host.host}${port}${cleanPath}`;
}

export function RemoteSshPanel({
  onPick,
}: {
  /** Called when the user commits a remote workspace path. The string
   *  is in `ssh://user@host:port/abs/path` form, ready to drop into
   *  session.project_path. The caller is responsible for closing the
   *  picker popover and patching the session. */
  onPick: (remoteUrl: string) => void;
}) {
  const [manualHosts, setManualHosts] = useState<SshHost[]>(() => loadHosts());
  const [configHosts, setConfigHosts] = useState<SshHost[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => loadHiddenConfigIds());
  const [adding, setAdding] = useState<boolean>(false);
  const [openHostId, setOpenHostId] = useState<string | null>(null);

  // Pull discovered hosts from the user's ~/.ssh/config on mount.
  // Failure is silent (returns []) so a missing or unreadable file
  // doesn't break the panel.
  useEffect(() => {
    let cancelled = false;
    sshKnownHosts().then(r => {
      if (cancelled) return;
      const mapped: SshHost[] = r.hosts.map(h => ({
        id: configHostId(h.label, h.host, h.user, h.port),
        host: h.host,
        user: h.user,
        port: h.port,
        identity_file: h.identity_file ?? undefined,
        source: "config",
        label: h.label,
      }));
      setConfigHosts(mapped);
    }).catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  // Final list = manual hosts first, then any discovered hosts the
  // user hasn't hidden, with manual entries winning when the same
  // user@host:port appears in both places (so a manual override of
  // a config alias keeps its custom identity_file).
  const hosts = useMemo(() => {
    const seen = new Set(manualHosts.map(h => `${h.user}@${h.host}:${h.port}`));
    const filteredConfig = configHosts.filter(h =>
      !hiddenIds.has(h.id) && !seen.has(`${h.user}@${h.host}:${h.port}`)
    );
    return [...manualHosts, ...filteredConfig];
  }, [manualHosts, configHosts, hiddenIds]);

  const setAndPersist = useCallback((next: SshHost[]) => {
    setManualHosts(next);
    saveHosts(next);
  }, []);

  const forgetHost = useCallback((host: SshHost) => {
    if (host.source === "config") {
      const next = new Set(hiddenIds);
      next.add(host.id);
      setHiddenIds(next);
      saveHiddenConfigIds(next);
    } else {
      setAndPersist(manualHosts.filter(x => x.id !== host.id));
    }
    if (openHostId === host.id) setOpenHostId(null);
  }, [hiddenIds, manualHosts, openHostId, setAndPersist]);

  const empty = hosts.length === 0 && !adding;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Saved hosts — flat list, same row chrome as the Local /
          Git tabs use elsewhere in the picker. */}
      {hosts.length > 0 && (
        <div style={{ padding: 4, display: "flex", flexDirection: "column", gap: 2 }}>
          {hosts.map(h => (
            <HostRow
              key={h.id}
              host={h}
              open={openHostId === h.id}
              onToggle={() => setOpenHostId(openHostId === h.id ? null : h.id)}
              onDelete={() => forgetHost(h)}
              onPick={(absPath) => onPick(buildRemoteUrl(h, absPath))}
            />
          ))}
        </div>
      )}

      {/* Add-host form — sits flush against the section above so it
          reads as part of the same chrome. */}
      {adding && (
        <div>
          <AddHostForm
            onCancel={() => setAdding(false)}
            onSave={(h) => {
              const id = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
              setAndPersist([...manualHosts, { id, source: "manual", ...h }]);
              setOpenHostId(id);
              setAdding(false);
            }}
          />
        </div>
      )}

      {/* Add row — same height + chrome as the host rows so the
          list reads as one continuous block. */}
      {!adding && (
        <div style={{
          padding: 4,
          borderTop: empty ? "none" : "1px solid var(--c-brd, rgba(255,255,255,0.05))",
        }}>
          <button
            onClick={() => setAdding(true)}
            onMouseDown={e => e.preventDefault()}
            style={{
              width: "100%", textAlign: "left",
              display: "flex", alignItems: "center", gap: 9,
              padding: empty ? "7px 9px" : "6px 9px",
              background: "transparent",
              border: "none", outline: "none", cursor: "pointer",
              borderRadius: 5,
              color: "var(--c-fg)",
              fontFamily: "var(--font-sans)",
              transition: "background 0.12s",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.045))"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <Plus size={11} style={{ color: "var(--c-dim)", flexShrink: 0 }} strokeWidth={2} />
            <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>
                {empty ? "Connect a remote machine" : "Add SSH host"}
              </span>
              {empty && (
                <span style={{ fontSize: 10.5, color: "var(--c-dim)" }}>
                  Point Fleet at a project that lives off your laptop
                </span>
              )}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── HostRow — list row, no individual border ────────────────────
   Earlier shape gave every host its own bordered card, which made
   the panel look like a stack of pills. New shape is a flat list:
   single-line row with hover background, subtle dim subtitle ONLY
   when there's something non-default to surface (custom port or
   identity file). Source ("config") is a quiet dim suffix on the
   subtitle, no loud pill. */
function HostRow({
  host, open, onToggle, onDelete, onPick,
}: {
  host: SshHost;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onPick: (absPath: string) => void;
}) {
  // Primary line — alias if the user gave it one, else user@host.
  // The alias is the friendlier label and matches what they'd type
  // into ssh on the command line.
  const hasAlias = !!(host.label && host.label !== host.host);
  const primary  = hasAlias ? host.label! : `${host.user}@${host.host}`;

  // Subtitle — only renders when there's non-default info worth
  // showing (custom port, identity file, or alias subtitle).
  // "Default port" with nothing else was visual noise.
  const subtitleParts: string[] = [];
  if (hasAlias) subtitleParts.push(`${host.user}@${host.host}${host.port !== 22 ? `:${host.port}` : ""}`);
  else if (host.port !== 22) subtitleParts.push(`port ${host.port}`);
  if (host.identity_file) subtitleParts.push(host.identity_file);
  const subtitle = subtitleParts.join(" · ");

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      borderRadius: 5,
      background: open ? "var(--c-srf, rgba(255,255,255,0.045))" : "transparent",
      transition: "background 0.12s",
    }}>
      <button
        onClick={onToggle}
        onMouseDown={e => e.preventDefault()}
        style={{
          display: "flex", alignItems: "center", gap: 9,
          width: "100%", textAlign: "left",
          padding: subtitle ? "6px 9px" : "7px 9px",
          background: "transparent",
          border: "none", outline: "none", cursor: "pointer",
          color: "var(--c-fg, #e6e6e6)",
          fontFamily: "var(--font-sans)",
          borderRadius: 5,
          transition: "background 0.12s",
        }}
        onMouseEnter={e => {
          if (open) return;
          (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.045))";
        }}
        onMouseLeave={e => {
          if (open) return;
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: "var(--c-dim, #7a7a7a)",
          flexShrink: 0,
        }} />
        <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <span style={{
            fontSize: 12.5, fontWeight: 500,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            color: "var(--c-fg, #e6e6e6)",
          }}>
            {primary}
          </span>
          {(subtitle || host.source === "config") && (
            <span style={{
              fontSize: 10.5, color: "var(--c-dim)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {subtitle}
              {subtitle && host.source === "config" && (
                <span style={{ color: "var(--c-ghost, #6a6a6a)" }}> · </span>
              )}
              {host.source === "config" && (
                <span style={{ color: "var(--c-ghost, #6a6a6a)" }}>from ssh config</span>
              )}
            </span>
          )}
        </span>
        {open
          ? <ChevronDown size={11} style={{ color: "var(--c-ghost, #6a6a6a)", flexShrink: 0 }} />
          : <ChevronRight size={11} style={{ color: "var(--c-ghost, #6a6a6a)", flexShrink: 0 }} />}
      </button>
      {open && (
        <HostDetail
          host={host}
          onDelete={onDelete}
          onPick={onPick}
        />
      )}
    </div>
  );
}

/* ─── HostDetail — connection test, then a tiny ls-based browser ─── */
type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok" }
  | { kind: "error"; msg: string };

function HostDetail({
  host, onDelete, onPick,
}: {
  host: SshHost;
  onDelete: () => void;
  onPick: (absPath: string) => void;
}) {
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  const target: SshTarget = useMemo(() => ({
    host: host.host, user: host.user, port: host.port,
    identity_file: host.identity_file ?? null,
  }), [host]);

  const runTest = useCallback(async () => {
    setTest({ kind: "running" });
    try {
      const r = await sshTest(target);
      setTest(r.ok ? { kind: "ok" } : { kind: "error", msg: r.error ?? "Connection failed" });
    } catch (e) {
      setTest({ kind: "error", msg: e instanceof Error ? e.message : "Connection failed" });
    }
  }, [target]);

  // Auto-test on first expand so the user gets immediate feedback.
  useEffect(() => { void runTest(); }, [runTest]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      padding: "0 9px 9px", gap: 8,
    }}>
      {/* Status row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "7px 9px",
        borderRadius: 5,
        background:
          test.kind === "ok" ? "rgba(74,222,128,0.08)"
          : test.kind === "error" ? "rgba(248,113,113,0.08)"
          : "var(--c-srf, rgba(255,255,255,0.04))",
        border: "1px solid " +
          (test.kind === "ok" ? "rgba(74,222,128,0.24)"
           : test.kind === "error" ? "rgba(248,113,113,0.30)"
           : "var(--c-brd, rgba(255,255,255,0.08))"),
        fontSize: 11.5,
        color: "var(--c-fg, #e6e6e6)",
      }}>
        {test.kind === "running"
          ? <Loader2 size={12} style={{ color: "var(--c-dim)", animation: "spin 0.9s linear infinite" }} />
          : test.kind === "ok"
            ? <Check size={12} style={{ color: "rgb(74,222,128)" }} />
            : test.kind === "error"
              ? <AlertCircle size={12} style={{ color: "rgb(248,113,113)" }} />
              : <Server size={12} style={{ color: "var(--c-dim)" }} />}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {test.kind === "running" && "Testing connection…"}
          {test.kind === "ok"      && "Connected"}
          {test.kind === "error"   && (test.msg || "Connection failed")}
          {test.kind === "idle"    && "Ready"}
        </span>
        <button
          onClick={runTest}
          onMouseDown={e => e.preventDefault()}
          disabled={test.kind === "running"}
          style={{
            padding: "2px 8px",
            fontSize: 10.5, fontWeight: 600,
            color: "var(--c-fg, #e6e6e6)",
            background: "transparent",
            border: "1px solid var(--c-brd, rgba(255,255,255,0.16))",
            borderRadius: 4,
            cursor: test.kind === "running" ? "default" : "pointer",
            outline: "none",
          }}
        >
          Re-test
        </button>
      </div>

      {/* Browser — mounted only when we know the connection works.
          Failed tests get a hint instead so the user can fix the
          form before trying again. */}
      {test.kind === "ok" && (
        <RemoteBrowser host={host} target={target} onPick={onPick} />
      )}

      {/* Footer — delete host */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={onDelete}
          onMouseDown={e => e.preventDefault()}
          title="Forget this host"
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "3px 8px",
            background: "transparent",
            border: "none", outline: "none", cursor: "pointer",
            borderRadius: 4,
            color: "var(--c-dim)",
            fontSize: 10.5,
            transition: "color 0.12s",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "rgb(248,113,113)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; }}
        >
          <Trash2 size={11} />
          Forget host
        </button>
      </div>
    </div>
  );
}

/* ─── RemoteBrowser — tiny ls-based directory navigator ─────────── */
function RemoteBrowser({
  host, target, onPick,
}: {
  host: SshHost;
  target: SshTarget;
  onPick: (absPath: string) => void;
}) {
  void host;
  const [path, setPath] = useState<string>("~");
  const [entries, setEntries] = useState<SshDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true); setErr(null);
    try {
      const r = await sshListDir({ ...target, path: p });
      setEntries(r.entries);
      setPath(r.path || p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to list directory");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => { void load("~"); }, [load]);

  const goUp = useCallback(() => {
    // Resolve "../" relative to the current displayed path. We can't
    // do path.dirname here because path may be "~" or "." on first
    // load; in that case ask the remote to evaluate `..` from the
    // current cwd of `~`.
    const next = path === "~" || path === "." || path === ""
      ? "~/.."
      : `${path.replace(/\/+$/, "")}/..`;
    void load(next);
  }, [path, load]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      borderRadius: 5,
      background: "var(--c-srf2, rgba(255,255,255,0.03))",
      border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
      overflow: "hidden",
    }}>
      {/* Path bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 8px",
        borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
        background: "var(--c-srf, rgba(255,255,255,0.03))",
      }}>
        <button
          onClick={goUp}
          onMouseDown={e => e.preventDefault()}
          title="Up"
          disabled={loading}
          style={{
            padding: 2, background: "transparent", border: "none", outline: "none",
            cursor: "pointer", color: "var(--c-dim)",
          }}
        >
          <ArrowLeft size={11} />
        </button>
        <span style={{
          flex: 1,
          fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)",
          color: "var(--c-fg, #e6e6e6)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {path}
        </span>
        <button
          onClick={() => onPick(path)}
          onMouseDown={e => e.preventDefault()}
          title="Use this folder"
          disabled={loading || !!err}
          style={{
            padding: "2px 8px",
            fontSize: 10.5, fontWeight: 600,
            color: "#0a0a0a",
            background: "var(--c-fg, #e6e6e6)",
            border: "none", borderRadius: 4,
            cursor: loading || !!err ? "default" : "pointer",
            outline: "none",
            opacity: loading || !!err ? 0.5 : 1,
          }}
        >
          Use folder
        </button>
      </div>

      {/* Entries */}
      <div style={{ maxHeight: 220, overflowY: "auto" }}>
        {loading && (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--c-dim)", display: "flex", gap: 6, alignItems: "center" }}>
            <Loader2 size={11} style={{ animation: "spin 0.9s linear infinite" }} />
            Loading…
          </div>
        )}
        {!loading && err && (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "rgb(248,113,113)" }}>
            {err}
          </div>
        )}
        {!loading && !err && entries.length === 0 && (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--c-dim)" }}>
            Empty
          </div>
        )}
        {!loading && !err && entries.map(e => (
          <button
            key={e.name}
            onClick={() => {
              if (e.type === "folder") {
                const next = path === "" || path === "." || path === "~"
                  ? `${path}/${e.name}`.replace(/^\.\//, "")
                  : `${path.replace(/\/+$/, "")}/${e.name}`;
                void load(next);
              }
            }}
            onMouseDown={ev => ev.preventDefault()}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", textAlign: "left",
              padding: "5px 9px",
              background: "transparent",
              border: "none", outline: "none",
              cursor: e.type === "folder" ? "pointer" : "default",
              color: "var(--c-fg, #e6e6e6)",
              fontFamily: "var(--font-sans)",
              fontSize: 11.5,
            }}
            onMouseEnter={ev => {
              if (e.type === "folder") (ev.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.05))";
            }}
            onMouseLeave={ev => { (ev.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <FolderOpen size={11} style={{
              color: e.type === "folder" ? "var(--c-fg, #e6e6e6)" : "var(--c-dim)",
              opacity: e.type === "folder" ? 1 : 0.4,
              flexShrink: 0,
            }} />
            <span style={{
              flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: e.type === "folder" ? "var(--c-fg, #e6e6e6)" : "var(--c-dim)",
            }}>
              {e.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── AddHostForm — minimal in-popover form, no boxed chrome ──
   Inline rows with label-on-left so it reads as part of the popover
   instead of a modal-within-a-modal. The earlier centered-label
   form looked like an OS dialog dropped inside the picker, which
   the user flagged as "kopuk". */
function AddHostForm({
  onCancel, onSave,
}: {
  onCancel: () => void;
  onSave: (h: Omit<SshHost, "id">) => void;
}) {
  const [hostInput, setHostInput] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [identityFile, setIdentityFile] = useState("");

  const canSave = hostInput.trim().length > 0 && user.trim().length > 0;
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      // No card chrome — inherits the popover's surface so the form
      // visually belongs to it. The action bar at the bottom carries
      // a single hairline separator instead of a full border.
    }}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <Field label="Host">
          <input
            autoFocus
            value={hostInput}
            onChange={e => setHostInput(e.target.value)}
            onClick={e => e.stopPropagation()}
            spellCheck={false} autoComplete="off"
            placeholder="example.com or 10.0.0.5"
            style={inputStyle}
          />
        </Field>
        <Field label="User">
          <input
            value={user}
            onChange={e => setUser(e.target.value)}
            onClick={e => e.stopPropagation()}
            spellCheck={false} autoComplete="off"
            placeholder="ubuntu"
            style={inputStyle}
          />
        </Field>
        <Field label="Port">
          <input
            value={port}
            onChange={e => setPort(e.target.value.replace(/[^\d]/g, ""))}
            onClick={e => e.stopPropagation()}
            spellCheck={false} autoComplete="off"
            inputMode="numeric"
            placeholder="22"
            style={inputStyle}
          />
        </Field>
        <Field label="Key file" hint="optional">
          <input
            value={identityFile}
            onChange={e => setIdentityFile(e.target.value)}
            onClick={e => e.stopPropagation()}
            spellCheck={false} autoComplete="off"
            placeholder="~/.ssh/id_ed25519"
            style={inputStyle}
          />
        </Field>
      </div>
      <div style={{
        display: "flex", justifyContent: "flex-end", gap: 6,
        padding: "7px 10px",
        borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
      }}>
        <button
          onClick={onCancel}
          onMouseDown={e => e.preventDefault()}
          style={{
            padding: "4px 10px",
            fontSize: 11.5, fontWeight: 500,
            color: "var(--c-dim)",
            background: "transparent",
            border: "none",
            borderRadius: 4,
            cursor: "pointer", outline: "none",
            fontFamily: "var(--font-sans)",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--c-fg, #e6e6e6)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; }}
        >Cancel</button>
        <button
          onClick={() => {
            if (!canSave) return;
            onSave({
              host: hostInput.trim(),
              user: user.trim(),
              port: parseInt(port || "22", 10) || 22,
              identity_file: identityFile.trim() || undefined,
            });
          }}
          onMouseDown={e => e.preventDefault()}
          disabled={!canSave}
          style={{
            padding: "4px 12px",
            fontSize: 11.5, fontWeight: 600,
            color: "#0a0a0a",
            background: "var(--c-fg, #e6e6e6)",
            border: "none", borderRadius: 4,
            cursor: canSave ? "pointer" : "default",
            opacity: canSave ? 1 : 0.4,
            outline: "none",
            fontFamily: "var(--font-sans)",
          }}
        >Save host</button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{
      display: "grid",
      gridTemplateColumns: "70px 1fr",
      alignItems: "center",
      gap: 10,
      padding: "5px 10px",
      borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.04))",
    }}>
      <span style={{
        display: "flex", alignItems: "center", gap: 5,
        fontSize: 11.5, fontWeight: 500,
        color: "var(--c-dim, #9a9a9a)",
      }}>
        {label}
        {hint && (
          <span style={{ fontSize: 9.5, color: "var(--c-ghost, #6a6a6a)", fontWeight: 400 }}>
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--c-fg, #e6e6e6)",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5, lineHeight: 1.4,
  outline: "none",
};
