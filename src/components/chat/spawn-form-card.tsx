import { useState, type CSSProperties } from "react";
import type { SpawnFormBlock, SpawnSpecDraft } from "@/types/chat";
import { spawnSession } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";

const MONO = "'SF Mono','Menlo','Monaco','Consolas',monospace";

const SURFACE: CSSProperties = {
  borderRadius: 10,
  border: "1px solid rgba(var(--fg-rgb),0.10)",
  background: "var(--chat-input-bg)",
  boxShadow: "inset 0 1px 0 rgba(var(--fg-rgb),0.04)",
  overflow: "hidden",
  marginBottom: 6,
};

const FIELD: CSSProperties = {
  width: "100%",
  height: 30,
  padding: "0 8px",
  background: "#0e0e0e",
  color: "#ececec",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 7,
  fontSize: 12.5,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

/** Inline spawn card rendered in the staff transcript from a `spawn_form`
 *  block. Spawning is fully automatic — the backend auto-fills provider,
 *  model, permission mode, and the first task — so the ONLY pending state
 *  is a missing project folder: a minimal picker (folder + Cancel/Create).
 *  Once created, a compact result card. Create POSTs the completed spec to
 *  /api/sessions/spawn (the backend re-resolves human-ish edits). */
export function SpawnFormCard({ block }: { block: SpawnFormBlock }) {
  const setActiveSession = useAppStore((s) => s.setActiveSession);

  const [d, setD] = useState<SpawnSpecDraft>(block.draft ?? {});
  const [status, setStatus] = useState(block.status);
  const [createdId, setCreatedId] = useState(block.created_session_id);
  const [error, setError] = useState<string | undefined>(block.error);

  const set = (patch: Partial<SpawnSpecDraft>) => setD((prev) => ({ ...prev, ...patch }));
  const projectCandidates =
    block.gaps.find((g) => g.field === "project_path")?.candidates ?? [];

  const canCreate = !!d.project_path?.trim() && status !== "creating";

  async function pickFolder() {
    const w = window as unknown as {
      electronAPI?: { openFolderDialog?: () => Promise<string | null> };
    };
    const p = w.electronAPI?.openFolderDialog
      ? await w.electronAPI.openFolderDialog()
      : window.prompt("Project folder path");
    if (p) set({ project_path: p });
  }

  async function create() {
    setStatus("creating");
    setError(undefined);
    try {
      const s = await spawnSession({ ...d, use_worktree: !!d.use_worktree });
      setCreatedId(s.id as string);
      setStatus("created");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("failed");
    }
  }

  if (status === "cancelled") return null;

  // ── Created — a plain inline line (NOT a boxed card), so the confirmation
  //    reads like a normal agent-dispatch note in the transcript. ──
  if (status === "created") {
    return (
      <div
        className="fade-in"
        style={{
          margin: "2px 0 12px",
          fontSize: 12.5,
          color: "var(--c-med)",
          lineHeight: 1.5,
          display: "flex",
          alignItems: "center",
          gap: 7,
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: "var(--c-low)" }}>✓</span>
        <span>
          Created agent{" "}
          <span style={{ color: "var(--c-high)", fontWeight: 500 }}>{d.title || "Agent"}</span>
          {d.project_path ? <span style={{ color: "var(--c-dim)" }}> · {d.project_path}</span> : null}
        </span>
        {createdId && (
          <button
            onClick={() => setActiveSession(createdId)}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--c-med)"; }}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--c-med)",
              fontSize: 12.5,
              fontWeight: 500,
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            Open
          </button>
        )}
      </div>
    );
  }

  // ── Folder picker — the only pending state ──
  const taskPreview = (d.first_task ?? "").trim();
  return (
    <div style={{ animation: "permCardIn 0.18s cubic-bezier(0.22,1,0.36,1) both" }}>
      <style>{`@keyframes permCardIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={SURFACE}>
        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#a8a8a8",
              fontWeight: 600,
            }}
          >
            Create agent — pick a folder
          </div>

          {/* Context line: which agent this folder is for. Everything else
              (provider/model/perm/task) is already resolved in the draft. */}
          <div style={{ fontSize: 12, color: "#c4c4c4", lineHeight: 1.5 }}>
            {d.title || "Agent"} · {d.tool || "auto provider"}
            {taskPreview ? (
              <span style={{ color: "#6a6a6a" }}>
                {" — "}
                {taskPreview.length > 90 ? `${taskPreview.slice(0, 90)}…` : taskPreview}
              </span>
            ) : null}
          </div>

          <button
            onClick={pickFolder}
            style={{
              ...FIELD,
              textAlign: "left",
              cursor: "pointer",
              color: d.project_path ? "#ececec" : "#7a7a7a",
              borderColor: d.project_path ? "rgba(255,255,255,0.10)" : "#7C6AF7",
            }}
          >
            {d.project_path || "Pick a folder…"}
          </button>
          {projectCandidates.length > 0 && !d.project_path && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {projectCandidates.map((c) => (
                <button
                  key={c}
                  onClick={() => set({ project_path: c })}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    borderRadius: 999,
                    background: "var(--c-srf)",
                    color: "var(--c-med)",
                    border: "1px solid var(--c-brd)",
                    cursor: "pointer",
                  }}
                >
                  {c.split(/[\\/]/).pop()}
                </button>
              ))}
            </div>
          )}

          {error && <div style={{ fontSize: 11.5, color: "#e0706a" }}>{error}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button
              onClick={() => setStatus("cancelled")}
              style={{
                height: 26,
                padding: "0 10px",
                background: "transparent",
                border: "none",
                borderRadius: 6,
                color: "#a8a8a8",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={!canCreate}
              style={{
                height: 26,
                padding: "0 11px",
                background: canCreate ? "#f5f5f5" : "rgba(255,255,255,0.15)",
                border: "1px solid #f5f5f5",
                borderRadius: 6,
                color: canCreate ? "#0a0a0a" : "#777",
                fontSize: 12,
                fontWeight: 600,
                cursor: canCreate ? "pointer" : "default",
              }}
            >
              {status === "creating" ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
