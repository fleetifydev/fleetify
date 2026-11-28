/** What an open card lets the user change, not just read: the session itself
 *  (stop, restart, fork, pin, rename, reset, archive), how the agent works (its
 *  permission mode, its effort, a spending cap), and its work in git (commit and
 *  push, open the folder). Every action goes through the same calls the rest of
 *  the app uses, and anything that cannot be undone asks once more. */
import { useState, type ReactNode } from "react";
import { Check, GitBranch, MoreHorizontal, Pencil, RotateCcw, Archive, Loader2 } from "lucide-react";
import { archiveSession, resetSession, setBudgetLimit, updateSession as apiUpdateSession } from "@/lib/api";
import { git } from "@/lib/git-api";
import { permissionCapabilityFor, permissionModesFor } from "@/lib/capabilities";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { useSessionGitContext } from "@/hooks/use-session-git-context";
import { OpenInMenu } from "@/components/layout/open-in-menu";
import { useAppStore } from "@/stores/app-store";
import type { Session } from "@/types/session";
import { sessionActions } from "./fleet-cards";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

const EFFORTS: { id: NonNullable<Session["effort"]>; label: string }[] = [
  { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" },
  { id: "extra_high", label: "Extra high" }, { id: "max", label: "Max" },
];

/** A setting as a quiet row: its name, then a native select dressed like the app (keyboard and screen readers come free). */
function Setting({ label, children }: { label: string; children: ReactNode }) {
  return <label className="fr-set"><span>{label}</span>{children}</label>;
}

export type ControlPart = "life" | "settings" | "git";

export function AgentControls({ session, live, parts = ["life", "settings", "git"], compact }: { session: Session; live: boolean; parts?: ControlPart[]; compact?: boolean }) {
  const app = useAppStore.getState;
  const { tiles } = useProvidersConfig();
  const modes = permissionModesFor(permissionCapabilityFor(tiles, session.tool));
  const folder = session.worktree_path ?? session.project_path;
  const gitCtx = useSessionGitContext(folder, true);
  const dirty = (gitCtx?.plus ?? 0) + (gitCtx?.minus ?? 0) > 0;

  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [more, setMore] = useState(false);
  const [ask, setAsk] = useState<"reset" | "archive" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [cap, setCap] = useState<string>(session.budget_limit ? String(session.budget_limit) : "");
  const [commitMsg, setCommitMsg] = useState<string | null>(null);

  const say = (text: string, bad = false) => { setNote({ text, bad }); window.setTimeout(() => setNote(n => (n?.text === text ? null : n)), 3200); };
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); if (done) say(done); } catch (err) { say(err instanceof Error ? err.message : "That did not work", true); } finally { setBusy(null); }
  };
  const patch = (data: Parameters<typeof apiUpdateSession>[1], done: string) => run(Object.keys(data)[0]!, async () => {
    app().updateSession(session.id, data as Partial<Session>);
    await apiUpdateSession(session.id, data);
  }, done);

  // commit and push: the message is written for you first, and you can change it before it goes
  const startCommit = () => run("commit-msg", async () => {
    if (!folder) throw new Error("No folder for this session");
    const m = await git.generateCommitMessage(folder, session.tool ?? undefined);
    setCommitMsg(m.ok ? m.message : `${session.title || "Work"}: changes`);
  });
  const doCommit = () => run("commit", async () => {
    if (!folder || !commitMsg?.trim()) return;
    const c = await git.commit(folder, commitMsg.trim());
    if (!c.ok) throw new Error(c.error);
    const p = await git.push(folder);
    setCommitMsg(null);
    if (!p.ok) throw new Error(`Committed; push failed: ${p.error}`);
    say(`Committed and pushed to ${p.branch}`);
  });

  const lifecycle = sessionActions(session, live);
  return (
    <div className="fr-ctrl" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
      {/* the session itself */}
      {parts.includes("life") && <div className="fr-controls">
        {lifecycle.map(a => (
          <button key={a.key} type="button" className={`fr-ctl${compact ? " fr-ctl-ic" : ""}${busy === a.key ? " is-busy" : ""}${a.key === "stop" ? " t-danger" : ""}`} onClick={() => void run(a.key, a.fn, a.key === "fork" ? "Forked" : undefined)} title={a.label} aria-label={a.label}>
            {a.icon}{!compact && <span>{a.label}</span>}
          </button>
        ))}
        <span className="fr-ctrl-more">
          <button type="button" className={`fr-ctl fr-ctl-ic${more ? " is-on" : ""}`} aria-label="More" onClick={() => { setMore(m => !m); setAsk(null); }}><MoreHorizontal size={13} /></button>
          {more && (
            <span className="fr-ctrl-pop">
              <button type="button" onClick={() => { setRenaming(session.title || ""); setMore(false); }}><Pencil size={12} />Rename</button>
              <button type="button" onClick={() => setAsk(a => (a === "reset" ? null : "reset"))}><RotateCcw size={12} />{ask === "reset" ? "Start over? Click again" : "Reset the conversation"}</button>
              {ask === "reset" && <button type="button" className="is-danger" onClick={() => { setMore(false); setAsk(null); void run("reset", () => resetSession(session.id), "The conversation starts over"); }}><Check size={12} />Yes, reset it</button>}
              <button type="button" onClick={() => setAsk(a => (a === "archive" ? null : "archive"))}><Archive size={12} />{ask === "archive" ? "Archive it? Click again" : "Archive"}</button>
              {ask === "archive" && <button type="button" className="is-danger" onClick={() => { setMore(false); setAsk(null); void run("archive", async () => { await archiveSession(session.id); app().removeSession(session.id); }); }}><Check size={12} />Yes, archive it</button>}
            </span>
          )}
        </span>
      </div>}
      {renaming !== null && (
        <form className="fr-ctrl-rename" onSubmit={e => { e.preventDefault(); const t = renaming.trim(); setRenaming(null); if (t && t !== session.title) void patch({ title: t }, "Renamed"); }}>
          <input autoFocus value={renaming} onChange={e => setRenaming(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") setRenaming(null); }} placeholder="Name" />
          <button type="submit" className="fr-btn fr-btn--primary">Save</button>
        </form>
      )}

      {/* how the agent works */}
      {parts.includes("settings") && <div className="fr-sets">
        {modes.length > 0 && (
          <Setting label="Permissions">
            <select value={session.permission_mode || modes[0]!.id} onChange={e => void patch({ permission_mode: e.target.value }, `Permissions: ${modes.find(m => m.id === e.target.value)?.label ?? e.target.value}`)}>
              {modes.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Setting>
        )}
        <Setting label="Effort">
          <select value={session.effort ?? "high"} onChange={e => void patch({ effort: e.target.value as Session["effort"] }, `Effort: ${EFFORTS.find(x => x.id === e.target.value)?.label}`)}>
            {EFFORTS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </Setting>
        <Setting label="Budget">
          <span className="fr-cap">
            <em>${(session.budget_used ?? 0).toFixed(2)} of</em>
            <input inputMode="decimal" value={cap} placeholder="no cap" onChange={e => setCap(e.target.value.replace(/[^\d.]/g, ""))}
              onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              onBlur={() => {
                const v = cap ? Number(cap) : null;
                if ((v ?? null) === (session.budget_limit ?? null) || (v !== null && !(v > 0))) return;
                void run("cap", async () => { await setBudgetLimit(session.id, v); app().updateSession(session.id, { budget_limit: v }); }, v ? `Cap set to $${v}` : "No cap");
              }} />
          </span>
        </Setting>
      </div>}

      {/* its work in git */}
      {parts.includes("git") && folder && (
        <div className="fr-gitrow">
          <span className="fr-gitrow-br" title={gitCtx?.branch ?? session.worktree_branch ?? ""}><GitBranch size={11} />{gitCtx?.branch ?? session.worktree_branch ?? "—"}</span>
          {dirty && <span className="fr-gitrow-d"><b className="add">+{gitCtx?.plus}</b><b className="del">−{gitCtx?.minus}</b></span>}
          <span className="fr-bar-gap" />
          <button type="button" className="fr-ctl" disabled={!dirty || !!busy} title={dirty ? "Write a message for these changes, then commit and push" : "No changes to commit"} onClick={() => void startCommit()}>
            {busy === "commit-msg" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}<span>Commit & push</span>
          </button>
          <OpenInMenu projectPath={folder} />
        </div>
      )}
      {commitMsg !== null && (
        <div className="fr-commit">
          <textarea value={commitMsg} rows={Math.min(5, commitMsg.split("\n").length + 1)} onChange={e => setCommitMsg(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") setCommitMsg(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void doCommit(); }} />
          <div className="fr-buttons">
            <button type="button" className="fr-btn" onClick={() => setCommitMsg(null)}>Cancel</button>
            <button type="button" className="fr-btn fr-btn--primary" disabled={busy === "commit" || !commitMsg.trim()} onClick={() => void doCommit()}>{busy === "commit" ? "Committing…" : "Commit & push"}</button>
          </div>
        </div>
      )}
      {note && <div className={`fr-ctrl-note${note.bad ? " is-bad" : ""}`} role="status">{note.text}</div>}
    </div>
  );
}
