/**
 * Cross-session aggregation for the Fleet right panel.
 *
 * Backend has no `/fleet/...` aggregation routes yet — it only exposes
 * per-session detail/activity/memory. So we fan out: poll each agent's
 * activity + memory every 5s, merge client-side, expose unified streams.
 *
 * Cheap because activity rows are summaries (≤ 200B each) and we cap at
 * 80 per session. With ~10 sessions that's ≤ 800 rows on the client.
 * Polling pauses while the tab is hidden.
 */
import { useEffect, useRef, useState } from "react";
import {
  fetchSessionActivity,
  fetchSessionMemory,
  fetchSessionDetail,
  type SessionActivityItem,
  type SessionMemoryItem,
  type SessionDetail,
} from "@/lib/api";
import type { Session } from "@/types/session";

export interface FleetActivityRow extends SessionActivityItem {
  session_id: string;
  session_title: string;
  session_status: Session["status"];
}

export interface FleetMemoryRow extends SessionMemoryItem {
  session_id: string;
  session_title: string;
  project_path: string;
}

export interface AgentDetailMap {
  [sessionId: string]: SessionDetail | undefined;
}

interface UseFleetDataResult {
  activity: FleetActivityRow[];
  memory: FleetMemoryRow[];
  details: AgentDetailMap;
  loading: boolean;
}

/** Poll every session for its activity + memory, merge by timestamp.
 *  Caller decides which slice to render. */
export function useFleetData(sessions: Session[], pollMs = 5_000): UseFleetDataResult {
  const [activity, setActivity] = useState<FleetActivityRow[]>([]);
  const [memory, setMemory] = useState<FleetMemoryRow[]>([]);
  const [details, setDetails] = useState<AgentDetailMap>({});
  const [loading, setLoading] = useState(true);

  // Latest sessions snapshot in a ref so the polling effect doesn't
  // restart on every status tick — only on genuine list changes (agent
  // added / removed). Status changes still flow through via the next
  // poll's session-title/status fields.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const sessionIdsKey = sessions.map(s => s.id).sort().join(",");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const list = sessionsRef.current;
      if (list.length === 0) {
        setActivity([]); setMemory([]); setDetails({}); setLoading(false);
        return;
      }

      const [activityResults, memoryResults, detailResults] = await Promise.all([
        Promise.all(list.map(s =>
          fetchSessionActivity(s.id, { limit: 30 })
            .then(rows => rows.map(r => ({
              ...r, session_id: s.id, session_title: s.title, session_status: s.status,
            }) as FleetActivityRow))
            .catch(() => [] as FleetActivityRow[])
        )),
        Promise.all(list.map(s =>
          fetchSessionMemory(s.id)
            .then(rows => rows.map(r => ({
              ...r,
              session_id: s.id,
              session_title: s.title,
              project_path: s.project_path ?? "",
            }) as FleetMemoryRow))
            .catch(() => [] as FleetMemoryRow[])
        )),
        Promise.all(list.map(s =>
          fetchSessionDetail(s.id).then(d => [s.id, d] as const).catch(() => [s.id, undefined] as const)
        )),
      ]);
      if (cancelled) return;

      // Merge activity, sort newest first.
      const merged: FleetActivityRow[] = [];
      for (const arr of activityResults) merged.push(...arr);
      merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      setActivity(merged);

      // Memory dedupe — backend returns shared cross-session items per
      // session (same id appears under each session whose project matches).
      // Keep the first occurrence; that's enough to render once.
      const seen = new Set<string>();
      const memMerged: FleetMemoryRow[] = [];
      for (const arr of memoryResults) {
        for (const m of arr) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          memMerged.push(m);
        }
      }
      memMerged.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      setMemory(memMerged);

      const dMap: AgentDetailMap = {};
      for (const [sid, d] of detailResults) dMap[sid] = d;
      setDetails(dMap);
      setLoading(false);
    };

    load();
    const iv = setInterval(load, pollMs);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdsKey, pollMs]);

  return { activity, memory, details, loading };
}
