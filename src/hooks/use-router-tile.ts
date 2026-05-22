import { useCallback, useState } from "react";
import { routers } from "@/lib/routers-api";

export type TileStatus = "idle" | "connecting" | "error";

export interface UseRouterTile {
  status: TileStatus;
  error: string | null;
  connect: (
    secret: string,
    metadata?: Record<string, unknown>,
  ) => Promise<boolean>;
  disconnect: () => Promise<void>;
  test: () => Promise<boolean>;
}

export function useRouterTile(id: string, onUpdate: () => void): UseRouterTile {
  const [status, setStatus] = useState<TileStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(
    async (
      secret: string,
      metadata: Record<string, unknown> = {},
    ): Promise<boolean> => {
      setStatus("connecting");
      setError(null);
      const r = await routers.connect(id, secret, metadata);
      if (r.ok) {
        setStatus("idle");
        onUpdate();
        return true;
      }
      setStatus("error");
      setError(r.error || "Unknown error");
      return false;
    },
    [id, onUpdate],
  );

  const disconnect = useCallback(async () => {
    await routers.disconnect(id);
    onUpdate();
  }, [id, onUpdate]);

  const test = useCallback(async (): Promise<boolean> => {
    const r = await routers.testRouter(id);
    return r.ok;
  }, [id]);

  return { status, error, connect, disconnect, test };
}
