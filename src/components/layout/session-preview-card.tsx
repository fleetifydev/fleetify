/**
 * Compact session preview card — a sibling of the sidebar context menu.
 *
 * Mirrors `CtxMenu`'s surface (var(--popover), --c-brd2 border, radius 10,
 * the same layered shadow) and the sidebar's tight monochrome type. A calm
 * four-line summary, top to bottom:
 *
 *   Desktop/fleetify                  ← project folder (tail)
 *   feat/new-message                  ← working branch
 *   <conversation title>
 *   [logo] Opus 4.8           +42 -8  ← model (left) · diff stat (right)
 *
 * Presentational only: branch + diff come from `useSessionGitContext`.
 */
import { Folder, GitBranch } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { CLI_MODEL_LABELS } from "@/lib/picker-groups";
import type { Session } from "@/types/session";
import type { SessionGitContext } from "@/hooks/use-session-git-context";

interface Props {
  session: Session;
  gitContext: SessionGitContext | null;
}

/** Last two path segments, joined with the separator the path itself uses
 *  (so Windows paths stay `Desktop\fleetify`, POSIX stay `Desktop/fleetify`). */
function pathTail(path: string | null | undefined): string {
  if (!path) return "";
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join(sep);
}

export function SessionPreviewCard({ session, gitContext }: Props) {
  const folder = pathTail(session.worktree_path ?? session.project_path);
  const branch = gitContext?.branch ?? session.worktree_branch ?? null;
  const modelLabel = (session.model_name && CLI_MODEL_LABELS[session.model_name]) || session.model_name || "";
  const plus = gitContext?.plus ?? 0;
  const minus = gitContext?.minus ?? 0;
  const hasDiff = plus > 0 || minus > 0;

  return (
    <div style={{
      width: 240,
      background: "var(--popover)",
      border: "1px solid var(--c-brd2)",
      borderRadius: 10,
      boxShadow: "0 8px 24px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.06)",
      padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 5,
      animation: "spc-in 0.13s ease-out",
    }}>
      <style>{`@keyframes spc-in { from { opacity: 0; transform: translateX(-3px) } to { opacity: 1; transform: none } }`}</style>

      {/* Folder */}
      {folder && (
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 10.5, color: "var(--c-ghost)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden", whiteSpace: "nowrap",
        }}>
          <Folder size={10} style={{ flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{folder}</span>
        </div>
      )}

      {/* Branch */}
      {branch && (
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 11, color: "var(--c-dim)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden", whiteSpace: "nowrap",
        }}>
          <GitBranch size={10} style={{ flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{branch}</span>
        </div>
      )}

      {/* Conversation title */}
      <div style={{
        fontSize: 12.5, fontWeight: 500, color: "var(--c-high)",
        lineHeight: 1.35, marginTop: 1,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {session.title}
      </div>

      {/* Model (left) · diff stat (right) */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        marginTop: 2,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <ProviderLogo tool={session.tool} size={14} />
          {modelLabel && (
            <span style={{
              fontSize: 11.5, color: "var(--c-med)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {modelLabel}
            </span>
          )}
        </div>
        {hasDiff && (
          <div style={{
            display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
            fontSize: 10.5, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
          }}>
            <span style={{ color: "#4ade80" }}>+{plus}</span>
            <span style={{ color: "#f87171" }}>-{minus}</span>
          </div>
        )}
      </div>
    </div>
  );
}
