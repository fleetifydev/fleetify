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

export function NotDiamondTile({ meta, onUpdate, onActivate }: Props) {
  const [open, setOpen] = useState(false);
  const { connect, disconnect } = useRouterTile("notdiamond", onUpdate);
  return (
    <>
      <RouterTile
        meta={meta}
        description="ML-based per-prompt model recommendation. Built for autonomous coding agents."
        onConnect={() => setOpen(true)}
        onDisconnect={disconnect}
        onActivate={onActivate}
      />
      {open && (
        <ConnectModal
          routerId="notdiamond"
          routerName="Not Diamond"
          docsUrl="https://app.notdiamond.ai/api-keys"
          extraFields={[
            {
              name: "workspace_id",
              label: "Workspace ID",
              placeholder: "Workspace ID (optional)",
            },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={connect}
        />
      )}
    </>
  );
}
