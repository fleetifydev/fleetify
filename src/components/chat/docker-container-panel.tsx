/**
 * DockerContainerPanel — the "Run in container" section of the source picker.
 *
 * This is an EXECUTION target, not a source. It renders below whichever
 * source tab is active (Local or Git) and composes with it, which is the
 * whole reason it stopped being a fourth tab: as a tab it was mutually
 * exclusive with Git by construction, so a container session on a worktree
 * was not expressible.
 *
 * Two modes:
 *   · Attach — exec into a container the user already runs. The files live
 *     inside it, so the container URL IS the project path and there is no
 *     host workspace (no branches, no worktree).
 *   · Run — Fleetify provisions a container from an image and bind-mounts
 *     the session's HOST workdir, so host git keeps working and the agent's
 *     edits land in the user's real checkout.
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
  dockerStatus, dockerContainers, dockerListDir, dockerProbeAgent, dockerImages,
  type DockerContainer, type DockerImage, type SshDirEntry,
} from "@/lib/api";
import { isHostPath, containerIdFromPath } from "@/lib/exec-target";

/** Is this list entry the container the session is attached to?
 *
 *  `docker ps` reports short ids while the session may hold a short id or a
 *  name (both come from this very picker), so match on either and by
 *  prefix in both directions — the same rule the toolbar's status chip uses. */
function isAttachedTo(c: DockerContainer, attachedId: string | null): boolean {
  if (!attachedId) return false;
  return (
    c.id === attachedId ||
    c.name === attachedId ||
    attachedId.startsWith(c.id) ||
    c.id.startsWith(attachedId)
  );
}

function buildContainerUrl(id: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `docker://${id}${cleanPath}`;
}

/** What "Run" provisions from. */
export interface RunPayload {
  source: "image" | "dockerfile" | "compose";
  /** Image name; only for `image`. */
  image?: string;
  /** Dockerfile or compose file path, relative to the project. */
  file?: string;
  /** Compose service the agent runs in. */
  service?: string;
  mountCredentials: boolean;
}

/** Provider id → the binary name that exists INSIDE a container.
 *
 *  Mirrors `services/container/providers.rs`. Two entries are not the
 *  identity you would guess: cursor's in-container binary is `agent` (the
 *  host prefers `cursor-agent`), and grok's routing id is `grok-build` while
 *  the binary is `grok`. */
const CONTAINER_BINARIES: Record<string, string> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "kimi-code": "kimi",
  "cursor-cli": "agent",
  "grok-build": "grok",
  "opencode": "opencode",
  "github-copilot": "copilot",
  "hermes-agent": "hermes",
};

/** Providers that cannot run in a container at all, with the reason. Mirrors
 *  `ContainerSupport::Unsupported` so the UI refuses before the turn does. */
const CONTAINER_UNSUPPORTED: Record<string, string> = {
  "antigravity-cli":
    "Antigravity CLI needs a terminal and writes its config next to the agent, so it can't run in a container yet.",
  "antigravity-sdk":
    "The Antigravity SDK agent runs a host Python SDK that provisions its own remote sandbox.",
};

type StatusState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "missing" }       // docker CLI not installed
  | { kind: "down"; msg: string };  // CLI present, daemon unreachable

export function DockerContainerPanel({
  onAttach,
  onRun,
  onClear,
  onPickFolder,
  onPickFile,
  sourcePath,
  execMode,
  providerId,
}: {
  /** Attach to an existing container: hands back `docker://<id>/<path>`. */
  onAttach: (containerUrl: string) => void;
  /** Provision around the current source path. `source` picks the recipe:
   *  a named image, the project's Dockerfile, or a compose service. */
  onRun: (payload: RunPayload) => void;
  /** Open the OS folder dialog and set the session's project path WITHOUT
   *  closing the picker — run mode needs a folder to mount, and bouncing
   *  the user back to the Local tab to get one lost them mid-setup. */
  onPickFolder: () => void;
  /** Open the OS FILE dialog for a Dockerfile / compose file. Resolves to
   *  the path to store (relative to the project when inside it) or null on
   *  cancel. Picking may also set the project folder — the file's location
   *  is the source of truth for where the project is when none was chosen. */
  onPickFile: (kind: "dockerfile" | "compose") => Promise<string | null>;
  /** Back to running on this machine. */
  onClear: () => void;
  /** The session's current host path. Run mode needs one to mount. */
  sourcePath: string | null;
  execMode: "host" | "docker-attach" | "docker-run";
  /** Canonical provider id, so the preflight probes the RIGHT binary
   *  instead of always asking about `claude`. */
  providerId: string;
}) {
  const [mode, setMode] = useState<"attach" | "run">(
    execMode === "docker-run" ? "run" : "attach",
  );
  const [image, setImage] = useState("");
  const [runSource, setRunSource] = useState<"image" | "dockerfile" | "compose">("image");
  const [buildFile, setBuildFile] = useState("");
  const [composeService, setComposeService] = useState("");
  const [mountCredentials, setMountCredentials] = useState(false);
  // The binary to probe for inside the container. Mirrors
  // `services/container/providers.rs` — kept in sync deliberately: probing
  // for `claude` on a codex session reports "not installed" for a container
  // that is perfectly fine.
  const agentBinary = CONTAINER_BINARIES[providerId] ?? providerId;
  // The container this session is currently attached to, so the list can
  // mark it. Re-opening the tab used to show a flat list with no memory of
  // the pick — nothing said which container the session was already on.
  const attachedId =
    execMode === "docker-attach" ? containerIdFromPath(sourcePath) : null;
  // Images already on this machine, for the run-from-image shortcut list.
  // Best-effort: on any failure the field still takes a typed name.
  const [localImages, setLocalImages] = useState<DockerImage[]>([]);
  useEffect(() => {
    let cancelled = false;
    void dockerImages().then(r => { if (!cancelled) setLocalImages(r.images); });
    return () => { cancelled = true; };
  }, []);
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

  // Refuse before anything else — including the daemon probe. Whether an
  // agent can run in a container at all has nothing to do with Docker being
  // up, and making the user start Docker just to be told "not supported"
  // is the wrong order.
  const unsupported = CONTAINER_UNSUPPORTED[providerId];
  if (unsupported) {
    return <Hint title="This agent can't run in a container" body={unsupported} />;
  }

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
      {/* ── Mode switch ── */}
      <div style={{
        display: "flex", gap: 4, padding: "6px 8px",
        borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.05))",
      }}>
        <ModeTab active={mode === "attach"} onClick={() => setMode("attach")}>
          Attach to a container
        </ModeTab>
        <ModeTab active={mode === "run"} onClick={() => setMode("run")}>
          Start one from an image
        </ModeTab>
        {execMode !== "host" && (
          <button
            onClick={onClear}
            onMouseDown={e => e.preventDefault()}
            title={execMode === "docker-attach"
              ? "Stop using this container — pick a folder to work in instead"
              : "Run on this machine instead"}
            style={{
              marginLeft: "auto", background: "transparent", border: "none",
              color: "var(--c-dim)", fontSize: 11, cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {execMode === "docker-attach" ? "Detach container" : "Run locally"}
          </button>
        )}
      </div>

      {mode === "run" ? (
        <RunFromImage
          sourcePath={sourcePath}
          image={image}
          setImage={setImage}
          runSource={runSource}
          setRunSource={setRunSource}
          buildFile={buildFile}
          setBuildFile={setBuildFile}
          composeService={composeService}
          setComposeService={setComposeService}
          mountCredentials={mountCredentials}
          setMountCredentials={setMountCredentials}
          providerId={providerId}
          localImages={localImages}
          onRun={onRun}
          onPickFolder={onPickFolder}
          onPickFile={onPickFile}
        />
      ) : (
      <>
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
            attached={isAttachedTo(c, attachedId)}
            onToggle={() => setOpenId(openId === c.id ? null : c.id)}
            onPick={(absPath) => onAttach(buildContainerUrl(c.id, absPath))}
            agentBinary={agentBinary}
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
      </>
      )}
    </div>
  );
}

/* ─── ModeTab — attach vs provision ────────────────────────────── */
function ModeTab({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      onMouseDown={e => e.preventDefault()}
      style={{
        background: active ? "var(--c-srf, rgba(255,255,255,0.06))" : "transparent",
        border: "none", outline: "none", cursor: "pointer",
        borderRadius: 5, padding: "4px 8px",
        fontSize: 11.5, fontWeight: active ? 600 : 500,
        color: active ? "var(--c-fg)" : "var(--c-dim)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {children}
    </button>
  );
}

/* ─── RunFromImage — provision a container around the current source ───
 *
 * Three recipes. Image and Dockerfile operate around a HOST folder (the
 * mount / build context), so they show the folder row. Compose does NOT:
 * the compose file's own directory *is* the project directory — that is
 * docker compose's default — so the file picker is the single source of
 * truth there, and a second folder control could only agree with it or
 * contradict it. Files are picked with the OS dialog, not typed: a typed
 * relative path was the most error-prone control in the panel. */
function RunFromImage({
  sourcePath, image, setImage,
  runSource, setRunSource, buildFile, setBuildFile,
  composeService, setComposeService,
  mountCredentials, setMountCredentials, providerId, localImages, onRun, onPickFolder, onPickFile,
}: {
  sourcePath: string | null;
  image: string;
  setImage: (v: string) => void;
  runSource: "image" | "dockerfile" | "compose";
  setRunSource: (v: "image" | "dockerfile" | "compose") => void;
  buildFile: string;
  setBuildFile: (v: string) => void;
  composeService: string;
  setComposeService: (v: string) => void;
  mountCredentials: boolean;
  setMountCredentials: (v: boolean) => void;
  providerId: string;
  /** Images already on this machine — a shortcut, not the only source. */
  localImages: DockerImage[];
  onRun: (payload: RunPayload) => void;
  onPickFolder: () => void;
  onPickFile: (kind: "dockerfile" | "compose") => Promise<string | null>;
}) {
  const hasHostSource = isHostPath(sourcePath);
  const agentBinary = CONTAINER_BINARIES[providerId] ?? providerId;
  // What is stopping the run, if anything — rendered NEXT TO the button.
  // Compose without a folder can only get one through the file pick, so
  // that is what its blocker asks for.
  const blocker =
    runSource === "compose" && !hasHostSource ? "Choose a compose file first."
    : !hasHostSource ? "Pick a folder or repo first."
    : runSource === "image" && !image.trim() ? "Enter an image."
    : null;

  const folderLeaf = sourcePath && hasHostSource
    ? sourcePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || sourcePath
    : null;

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", minWidth: 0,
    background: "var(--c-srf, rgba(255,255,255,0.045))",
    border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
    borderRadius: 5, padding: "6px 8px",
    color: "var(--c-fg)", fontSize: 12,
    fontFamily: "var(--font-mono, monospace)", outline: "none",
  };
  const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 500 };

  const pickFile = (kind: "dockerfile" | "compose") => {
    void onPickFile(kind).then(v => { if (v != null) setBuildFile(v); });
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      {/* ── Recipe ── */}
      <div role="radiogroup" aria-label="Container source" style={{ display: "flex", gap: 4 }}>
        {([
          ["image", "Image"],
          ["dockerfile", "Dockerfile"],
          ["compose", "Compose"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={runSource === key}
            onClick={() => { setRunSource(key); setBuildFile(""); }}
            onMouseDown={e => e.preventDefault()}
            style={{
              flex: 1,
              background: runSource === key ? "var(--c-srf, rgba(255,255,255,0.08))" : "transparent",
              border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
              borderRadius: 5, padding: "5px 0",
              fontSize: 11.5, fontWeight: runSource === key ? 600 : 500,
              color: runSource === key ? "var(--c-fg)" : "var(--c-dim)",
              cursor: "pointer", fontFamily: "var(--font-sans)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Folder to work on — the mount (image) / mount + build context
            (dockerfile). Compose has no row here on purpose: its file IS
            the location, picked below. ── */}
      {runSource !== "compose" && (
        <PickRow
          testId="pick-folder-row"
          icon={<FolderOpen size={13} style={{ color: "var(--c-dim)", flexShrink: 0 }} />}
          title={folderLeaf ?? "Browse local folder"}
          subtitle={hasHostSource
            ? "Mounted into the container — branches and worktrees keep working."
            : "Pick the folder the container will work on."}
          onClick={onPickFolder}
          hoverTitle={hasHostSource ? "Change the project folder" : "Pick the folder the container works on"}
        />
      )}

      {runSource === "image" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span style={labelStyle}>Image</span>
            <input
              value={image}
              onChange={e => setImage(e.target.value)}
              placeholder="node:22"
              spellCheck={false}
              style={fieldStyle}
            />
          </label>
          {/* Images already on this machine. Typing filters the list; a
              click fills the field. Anything not listed still works — the
              typed name is what runs, this is only the shortcut. */}
          {(() => {
            const q = image.trim().toLowerCase();
            const shown = localImages
              .filter(i => !q || i.name.toLowerCase().includes(q))
              .slice(0, 8);
            if (shown.length === 0) return null;
            if (shown.length === 1 && shown[0]?.name === image.trim()) return null;
            return (
              <div
                data-testid="local-image-list"
                style={{
                  display: "flex", flexDirection: "column", gap: 1,
                  maxHeight: 132, overflowY: "auto",
                  border: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
                  borderRadius: 5, padding: 2,
                }}
              >
                <span style={{ fontSize: 10, color: "var(--c-ghost, #6a6a6a)", padding: "2px 6px" }}>
                  On this machine
                </span>
                {shown.map(img => (
                  <button
                    key={img.id + img.name}
                    type="button"
                    onClick={() => setImage(img.name)}
                    onMouseDown={e => e.preventDefault()}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      width: "100%", minWidth: 0, textAlign: "left",
                      padding: "4px 6px", borderRadius: 4,
                      background: "transparent", border: "none",
                      cursor: "pointer", color: "var(--c-fg)",
                      fontFamily: "var(--font-sans)",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.05))"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                  >
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 11.5,
                      fontFamily: "var(--font-mono, monospace)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {img.name}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 10, color: "var(--c-dim)" }}>
                      {img.size}
                    </span>
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {runSource === "dockerfile" && (
        <PickRow
          testId="pick-dockerfile-row"
          icon={<Box size={13} style={{ color: "var(--c-dim)", flexShrink: 0 }} />}
          title={buildFile || "Choose Dockerfile…"}
          subtitle={buildFile
            ? "Built with your project folder as the context."
            : "Nothing picked — ./Dockerfile in the project folder is used."}
          onClick={() => pickFile("dockerfile")}
          onClear={buildFile ? () => setBuildFile("") : undefined}
          hoverTitle="Choose the Dockerfile to build"
        />
      )}

      {runSource === "compose" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <PickRow
            testId="pick-compose-row"
            icon={<Box size={13} style={{ color: "var(--c-dim)", flexShrink: 0 }} />}
            title={buildFile || "Choose compose file…"}
            subtitle={
              hasHostSource
                ? `Project: ${folderLeaf}${buildFile ? "" : " — ./docker-compose.yml is used"}`
                : "Its folder becomes the project folder."
            }
            onClick={() => pickFile("compose")}
            onClear={buildFile ? () => setBuildFile("") : undefined}
            hoverTitle="Choose the docker-compose file"
          />
          <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span style={labelStyle}>Service</span>
            <input
              value={composeService}
              onChange={e => setComposeService(e.target.value)}
              placeholder="left empty, a single-service file picks itself"
              spellCheck={false}
              style={fieldStyle}
            />
            <span style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.4 }}>
              {agentBinary} runs inside this service. Fleetify starts the stack and never tears
              it down — deleting the session leaves it running.
            </span>
          </label>
        </div>
      )}

      {/* Credentials — compose owns the service's mounts, so the scoped
          credential mount cannot be applied there and offering it would
          claim a bridge that never happens. */}
      {runSource !== "compose" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span style={labelStyle}>Credentials</span>
          <CredentialOption
            selected={!mountCredentials}
            onSelect={() => setMountCredentials(false)}
            title="Sign in inside the container"
            detail="Nothing leaves this machine. You log the agent in once, in the container."
          />
          <CredentialOption
            selected={mountCredentials}
            onSelect={() => setMountCredentials(true)}
            title={`Mount my ${providerId} login`}
            detail="Shares only this agent's own credential folder — never your home or SSH keys."
            warn
          />
        </div>
      ) : (
        <span style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.45 }}>
          Your compose file owns the service&rsquo;s mounts, so credentials can&rsquo;t be
          mounted here — set the agent&rsquo;s API key in Fleetify, or sign in inside the
          service.
        </span>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <button
          disabled={!!blocker}
          onClick={() =>
            onRun({
              source: runSource,
              image: runSource === "image" ? image.trim() : undefined,
              file:
                runSource !== "image" && buildFile.trim()
                  ? buildFile.trim()
                  : undefined,
              service:
                runSource === "compose" && composeService.trim()
                  ? composeService.trim()
                  : undefined,
              mountCredentials: runSource === "compose" ? false : mountCredentials,
            })
          }
          onMouseDown={e => e.preventDefault()}
          style={{
            flexShrink: 0,
            background: blocker ? "transparent" : "var(--c-srf, rgba(255,255,255,0.08))",
            border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
            borderRadius: 5, padding: "5px 12px",
            fontSize: 12, fontWeight: 500,
            color: blocker ? "var(--c-dim)" : "var(--c-fg)",
            cursor: blocker ? "not-allowed" : "pointer",
            opacity: blocker ? 0.6 : 1,
            fontFamily: "var(--font-sans)",
          }}
        >
          {runSource === "image" ? "Run in this image"
            : runSource === "dockerfile" ? "Build & run"
            : "Start the stack"}
        </button>
        {blocker && (
          <span style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.35, minWidth: 0 }}>
            {blocker}
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── PickRow — one "choose a thing via OS dialog" row ─────────────── */
function PickRow({
  icon, title, subtitle, onClick, onClear, hoverTitle, testId,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  /** Present only when something is picked — resets back to the default. */
  onClear?: () => void;
  hoverTitle: string;
  testId?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 4, minWidth: 0 }}>
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        onMouseDown={e => e.preventDefault()}
        title={hoverTitle}
        style={{
          flex: 1, display: "flex", alignItems: "center", gap: 8,
          minWidth: 0, textAlign: "left",
          padding: "7px 9px", borderRadius: 6,
          background: "transparent",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          cursor: "pointer", color: "var(--c-fg)",
          fontFamily: "var(--font-sans)",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.04))"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        {icon}
        <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <span style={{
            fontSize: 12, fontWeight: 500,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontFamily: "var(--font-mono, monospace)",
          }}>
            {title}
          </span>
          <span style={{
            fontSize: 11, color: "var(--c-dim)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {subtitle}
          </span>
        </span>
      </button>
      {onClear && (
        <button
          type="button"
          aria-label="Reset to default"
          onClick={onClear}
          onMouseDown={e => e.preventDefault()}
          style={{
            flexShrink: 0, width: 26, borderRadius: 6,
            background: "transparent",
            border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
            color: "var(--c-dim)", cursor: "pointer", fontSize: 12,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** One selectable credential strategy.
 *
 *  The whole row is the target and the whole row shows selection — a bordered
 *  card plus a filled radio — rather than a bare checkbox with a label
 *  floating beside it. At 340px a tick-box reads as decoration; a card reads
 *  as a choice. */
function CredentialOption({
  selected, onSelect, title, detail, warn,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  /** Tint the selected state amber — this option carries a host login into
   *  the container, and the selected state is exactly when to say so. */
  warn?: boolean;
}) {
  const accent = warn ? "var(--c-warn, #d9a441)" : "var(--c-acc, rgba(var(--fg-rgb),0.55))";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      onMouseDown={e => e.preventDefault()}
      style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        width: "100%", minWidth: 0, textAlign: "left",
        padding: "7px 9px", borderRadius: 6,
        background: selected
          ? `color-mix(in srgb, ${accent} 10%, transparent)`
          : "transparent",
        border: `1px solid ${selected ? `color-mix(in srgb, ${accent} 55%, transparent)` : "var(--c-brd, rgba(255,255,255,0.08))"}`,
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        color: "var(--c-fg)",
        transition: "background 0.12s, border-color 0.12s",
      }}
      onMouseEnter={e => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "var(--c-srf, rgba(255,255,255,0.04))";
      }}
      onMouseLeave={e => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {/* Radio dot. flexShrink:0 keeps it circular when the label wraps. */}
      <span
        aria-hidden
        style={{
          flexShrink: 0, marginTop: 2,
          width: 12, height: 12, borderRadius: "50%",
          border: `1px solid ${selected ? accent : "rgba(var(--fg-rgb),0.32)"}`,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          transition: "border-color 0.12s",
        }}
      >
        {selected && (
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
        )}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.4 }}>{detail}</span>
      </span>
    </button>
  );
}

/* ─── ContainerRow — one row per running container ─────────────── */
function ContainerRow({
  container, open, attached, onToggle, onPick, agentBinary,
}: {
  container: DockerContainer;
  open: boolean;
  /** This is the container the session is currently attached to. */
  attached: boolean;
  onToggle: () => void;
  onPick: (absPath: string) => void;
  /** Binary to preflight-probe for inside this container. */
  agentBinary: string;
}) {
  return (
    <div
      data-attached={attached || undefined}
      style={{
        display: "flex", flexDirection: "column",
        borderRadius: 5,
        background: open ? "var(--c-srf, rgba(255,255,255,0.045))" : "transparent",
        // The selected container reads as selected the way the credential
        // cards do: a quiet accent outline, not just a badge.
        border: attached
          ? "1px solid color-mix(in srgb, var(--c-low, #4a9) 55%, transparent)"
          : "1px solid transparent",
        transition: "background 0.12s, border-color 0.12s",
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
            display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0,
          }}>
            <span style={{
              fontSize: 12.5, fontWeight: 500,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: "var(--c-fg, #e6e6e6)",
            }}>
              {container.name || container.id.slice(0, 12)}
            </span>
            {attached && (
              <span style={{
                flexShrink: 0,
                fontSize: 9.5, fontWeight: 600, letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "1px 5px", borderRadius: 4,
                color: "var(--c-low, #4a9)",
                background: "color-mix(in srgb, var(--c-low, #4a9) 14%, transparent)",
              }}>
                Attached
              </span>
            )}
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
      {open && <ContainerBrowser container={container} onPick={onPick} agentBinary={agentBinary} />}
    </div>
  );
}

/* ─── ContainerBrowser — minimal directory navigator inside a container ─── */
function ContainerBrowser({
  container, onPick, agentBinary,
}: {
  container: DockerContainer;
  onPick: (absPath: string) => void;
  agentBinary: string;
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
    dockerProbeAgent(container.id, agentBinary)
      .then(r => { if (!cancelled) setAgentPresent(r.present); })
      .catch(() => { /* see agentPresent's comment — unknown, not missing */ });
    return () => { cancelled = true; };
  }, [container.id, agentBinary]);

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
            <code style={{ fontFamily: "var(--font-mono, monospace)" }}>{agentBinary}</code>{" "}
            isn&rsquo;t installed in this container. You can still pick a folder — install it
            there and the next turn will find it.
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
