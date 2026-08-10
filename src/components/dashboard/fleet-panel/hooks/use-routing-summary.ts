/**
 * 5 s poll of GET /api/routing/summary for the Router section.
 * Same rhythm as use-fleet-data: pause while the tab is hidden,
 * refetch on visibility regain. `undefined` = first load pending,
 * `null` = fetch failed (section degrades silently).
 */
import { useEffect, useState } from "react";
import { fetchRoutingSummary, type RoutingSummary } from "@/lib/api";

export function useRoutingSummary(pollMs = 5_000): RoutingSummary | null | undefined {
  const [summary, setSummary] = useState<RoutingSummary | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const s = await fetchRoutingSummary();
      if (!cancelled) setSummary(s);
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
  }, [pollMs]);

  return summary;
}
