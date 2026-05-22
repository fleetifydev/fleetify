import { RouterTile } from "./router-tile";
import type { RouterTile as RouterTileMeta } from "@/lib/routers-api";

interface Props {
  meta: RouterTileMeta;
  onActivate: (category: "decision" | "proxy") => void;
}

export function BuiltinRouterTile({ meta, onActivate }: Props) {
  return (
    <RouterTile
      meta={meta}
      description="Offline, deterministic capability matrix + heuristic complexity classifier. Always available as fallback."
      onActivate={onActivate}
    />
  );
}
