/**
 * DockerContainerPanel — Container tab of the source picker.
 *
 * Lists running Docker containers via the local CLI, lets the user
 * expand one and browse its filesystem, and commits a workspace
 * path as `docker://<id>/<abs/path>`. Same shape as RemoteSshPanel
 * so the picker reads as one design family across Local / Git /
 * Remote / Container.
 *
 * Note there is NO colon before the path — `buildContainerUrl`
 * concatenates a slash-prefixed path straight onto the id. An earlier
 * version of this comment claimed `docker://<id>:<abs/path>`, which no
 * code ever produced. The backend parser (`services/exec_target.rs`)
 * splits at the first slash, which is unambiguous because container ids
 * cannot contain one.
 *
 * Unlike the SSH tab, agent execution inside the container is wired:
 * the session spawns via `docker exec`. The preflight below reports
 * whether the CLI is actually installed in the target.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown, ChevronRight, FolderOpen, Loader2, AlertCircle,
  Box, ArrowLeft, RefreshCw,
} from "lucide-react";
import {
  dockerStatus, dockerContainers, dockerListDir, dockerProbeAgent,
  type DockerContainer, type SshDirEntry,
} from "@/lib/api";

function buildContainerUrl(id: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `docker://${id}${cleanPath}`;
}

type StatusState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "missing" }       // docker CLI not installed
  | { kind: "down"; msg: string };  // CLI present, daemon unreachable

export function DockerContainerPanel({
  onPick,
}: {
  onPick: (containerUrl: string) => void;
}) {
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const loadContainers = useCallback(async () => {
    setRefreshing(true); setListError(null);
    try {
      const r = await dockerContainers();
      setContainers(r.containers);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to list containers");
      setContainers([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Probe daemon, then list. Two-step so a missing/down daemon
  // surfaces a tailored message instead of a generic 4xx from
  // /containers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await dockerStatus();
      if (cancelled) return;
      if (!s.installed) { setStatus({ kind: "missing" }); return; }
      if (!s.running)   { setStatus({ kind: "down", msg: s.error ?? "Daemon is not running" }); return; }
      setStatus({ kind: "ready" });
      void loadContainers();
    })();
    return () => { cancelled = true; };
  }, [loadContainers]);

  // ── Render ───────────────────────────────────────────────────

  if (status.kind === "loading") {
    return (
      <div style={{ padding: 9, fontSize: 11.5, color: "var(--c-dim)", display: "flex", alignItems: "center", gap: 6 }}>
        <Loader2 size={11} style={{ animation: "spin 0.9s linear infinite" }} />
        Checking Docker…
      </div>
    );
  }

  if (status.kind === "missing") {
    return (
      <Hint
        title="Docker isn't installed"
        body="Install Docker Desktop (or Colima / Rancher Desktop) to use a container as your workspace."
      />
    );
  }

  if (status.kind === "down") {
    const retry = async () => {
      setStatus({ kind: "loading" });
      const s = await dockerStatus();
      if (!s.installed) setStatus({ kind: "missing" });
      else if (!s.running) setStatus({ kind: "down", msg: s.error ?? "Daemon is not running" });
      else { setStatus({ kind: "ready" }); void loadContainers(); }
    };
    return (
      <Hint
        title="Docker daemon isn't running"
        body={status.msg}
        action={{ label: "Retry", onClick: () => { void retry(); } }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Container list */}
      <div style={{
        padding: 4,
        display: "flex", flexDirection: "column", gap: 2,
        maxHeight: 280, overflowY: "auto",
      }}>
        {containers.length === 0 && !refreshing && !listError && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 9px",
            fontSize: 11.5, color: "var(--c-dim)",
          }}>
            <Box size={12} />
            No containers running.
          </div>
        )}
        {listError && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 9px",
            fontSize: 11.5, color: "rgb(248,113,113)",
          }}>
            <AlertCircle size={12} />
            {listError}
          </div>
        )}
        {containers.map(c => (
          <ContainerRow
            key={c.id}
            container={c}
            open={openId === c.id}
            onToggle={() => setOpenId(openId === c.id ? null : c.id)}
            onPick={(absPath) => onPick(buildContainerUrl(c.id, absPath))}
          />
        ))}
      </div>

      {/* Refresh row — same chrome as the Add row in the SSH panel */}
      <div style={{
        padding: 4,
        borderTop: containers.length === 0 ? "none" : "1px solid var(--c-brd, rgba(255,255,255,0.05))",
      }}>
        <button
          onClick={() => void loadContainers()}
          onMouseDown={e => e.preventDefault()}
          disabled={refreshing}
          style={{
            width: "100%", textAlign: "left",
            display: "flex", alignItems: "center", gap: 9,
            padding: "6px 9px",
            background: "transparent",
            border: "none", outline: "none",
            cursor: refreshing ? "default" : "pointer",
            borderRadius: 5,
            color: "var(--c-fg)",
            fontFamily: "var(--font-sans)",
            opacity: refreshing ? 0.6 : 1,
            transition: "background 0.12s",
          }}
          onMouseEnter={e => { if (!refreshing) (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.045))"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
        >
          {refreshing
            ? <Loader2 size={11} style={{ color: "var(--c-dim)", flexShrink: 0, animation: "spin 0.9s linear infinite" }} />
            : <RefreshCw size={11} style={{ color: "var(--c-dim)", flexShrink: 0 }} />}
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>
            {refreshing ? "Refreshing…" : "Refresh containers"}
          </span>
        </button>
      </div>
    </div>
  );
}

/* ─── ContainerRow — one row per running container ─────────────── */
function ContainerRow({
  container, open, onToggle, onPick,
}: {
  container: DockerContainer;
  open: boolean;
  onToggle: () => void;
  onPick: (absPath: string) => void;
}) {
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
          padding: "6px 9px",
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
          background: container.state === "running" ? "rgb(74,222,128)" : "var(--c-dim, #7a7a7a)",
          flexShrink: 0,
          boxShadow: container.state === "running" ? "0 0 0 2px rgba(74,222,128,0.18)" : "none",
        }} />
        <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <span style={{
            fontSize: 12.5, fontWeight: 500,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            color: "var(--c-fg, #e6e6e6)",
          }}>
            {container.name || container.id.slice(0, 12)}
          </span>
          <span style={{
            fontSize: 10.5, color: "var(--c-dim)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {container.image}
          </span>
        </span>
        {open
          ? <ChevronDown size={11} style={{ color: "var(--c-ghost, #6a6a6a)", flexShrink: 0 }} />
          : <ChevronRight size={11} style={{ color: "var(--c-ghost, #6a6a6a)", flexShrink: 0 }} />}
      </button>
      {open && <ContainerBrowser container={container} onPick={onPick} />}
    </div>
  );
}

/* ─── ContainerBrowser — minimal directory navigator inside a container ─── */
function ContainerBrowser({
  container, onPick,
}: {
  container: DockerContainer;
  onPick: (absPath: string) => void;
}) {
  const [path, setPath] = useState<string>("/");
  const [entries, setEntries] = useState<SshDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // null = not answered yet. A failed probe stays null rather than
  // becoming false: the daemon could be busy or the container
  // mid-restart, and guessing "missing" would cry wolf on a good
  // container. The backend re-probes at spawn either way.
  const [agentPresent, setAgentPresent] = useState<boolean | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true); setErr(null);
    try {
      const r = await dockerListDir(container.id, p);
      setEntries(r.entries);
      setPath(r.path || p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to list directory");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [container.id]);

  useEffect(() => { void load("/"); }, [load]);

  useEffect(() => {
    let cancelled = false;
    setAgentPresent(null);
    dockerProbeAgent(container.id)
      .then(r => { if (!cancelled) setAgentPresent(r.present); })
      .catch(() => { /* see agentPresent's comment — unknown, not missing */ });
    return () => { cancelled = true; };
  }, [container.id]);

  const goUp = useCallback(() => {
    if (path === "/" || path === "") return;
    const trimmed = path.replace(/\/+$/, "");
    const parent = trimmed.slice(0, trimmed.lastIndexOf("/")) || "/";
    void load(parent);
  }, [path, load]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      margin: "0 9px 9px",
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
          disabled={loading || path === "/"}
          style={{
            padding: 2, background: "transparent", border: "none", outline: "none",
            cursor: path === "/" || loading ? "default" : "pointer",
            color: path === "/" ? "var(--c-ghost, #5a5a5a)" : "var(--c-dim)",
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

      {/* Preflight — reports, never vetoes. The user may well be about
          to install the CLI into this container. */}
      {agentPresent === false && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 6,
          padding: "6px 8px",
          borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          fontSize: 10.5, lineHeight: 1.45,
          color: "rgb(251,191,36)",
        }}>
          <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            The claude CLI is not installed in this container. You can still
            pick a folder, but turns will fail until you install it.
          </span>
        </div>
      )}

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
                const next = path === "/" ? `/${e.name}` : `${path.replace(/\/+$/, "")}/${e.name}`;
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

/* ─── Hint — small empty/error block reused for Docker-not-installed + daemon-down ─── */
function Hint({
  title, body, action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 5,
      padding: "10px 11px",
      fontFamily: "var(--font-sans)",
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--c-fg, #e6e6e6)" }}>
        {title}
      </div>
      <div style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.45 }}>
        {body}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          onMouseDown={e => e.preventDefault()}
          style={{
            alignSelf: "flex-start",
            marginTop: 3,
            padding: "3px 9px",
            fontSize: 10.5, fontWeight: 600,
            color: "var(--c-fg, #e6e6e6)",
            background: "transparent",
            border: "1px solid var(--c-brd, rgba(255,255,255,0.16))",
            borderRadius: 4,
            cursor: "pointer", outline: "none",
            fontFamily: "var(--font-sans)",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
