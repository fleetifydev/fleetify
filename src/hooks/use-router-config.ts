import { useCallback, useEffect, useState } from "react";
import { routers, type RouterTile } from "@/lib/routers-api";

export interface RouterConfigState {
  tiles: RouterTile[];
  masterEnabled: boolean;
  loading: boolean;
  setMasterEnabled: (v: boolean) => Promise<void>;
  setActive: (category: "decision" | "proxy", id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useRouterConfig(): RouterConfigState {
  const [tiles, setTiles] = useState<RouterTile[]>([]);
  const [masterEnabled, setMasterEnabledLocal] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const r = await routers.list();
    setTiles(r.tiles);
    setMasterEnabledLocal(r.enabled);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    routers.list().then((r) => {
      if (cancelled) return;
      setTiles(r.tiles);
      setMasterEnabledLocal(r.enabled);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMasterEnabled = useCallback(async (v: boolean) => {
    await routers.setMasterToggle(v);
    setMasterEnabledLocal(v);
  }, []);

  const setActive = useCallback(
    async (category: "decision" | "proxy", id: string) => {
      await routers.setActive(category, id);
      await refresh();
    },
    [refresh],
  );

  return {
    tiles,
    masterEnabled,
    loading,
    setMasterEnabled,
    setActive,
    refresh,
  };
}
