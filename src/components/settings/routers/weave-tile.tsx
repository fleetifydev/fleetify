import { useState } from "react";
import { RouterTile } from "./router-tile";
import { ConnectModal } from "./connect-modal";
import { useRouterTile } from "@/hooks/use-router-tile";
import type { RouterTile as RouterTileMeta } from "@/lib/routers-api";

interface Props {
  meta: RouterTileMeta;
  onUpdate: () => void;
  onActivate: (category: "decision" | "proxy") => void;
}

export function WeaveTile({ meta, onUpdate, onActivate }: Props) {
  const [open, setOpen] = useState(false);
  const { connect, disconnect } = useRouterTile("weave", onUpdate);
  return (
    <>
      <RouterTile
        meta={meta}
        description="Cost-optimizing proxy with built-in routing decisions. Both Decision and Proxy capable."
        onConnect={() => setOpen(true)}
        onDisconnect={disconnect}
        onActivate={onActivate}
      />
      {open && (
        <ConnectModal
          routerId="weave"
          routerName="Weave Router"
          docsUrl="https://router.workweave.ai/dashboard"
          extraFields={[
            {
              name: "base_url",
              label: "Base URL",
              placeholder: "Base URL (leave blank for managed)",
            },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={connect}
        />
      )}
    </>
  );
}
