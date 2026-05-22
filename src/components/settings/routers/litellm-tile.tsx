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

export function LiteLLMTile({ meta, onUpdate, onActivate }: Props) {
  const [open, setOpen] = useState(false);
  const { connect, disconnect } = useRouterTile("litellm", onUpdate);
  return (
    <>
      <RouterTile
        meta={meta}
        description="Self-hosted gateway with fallback chains and budget controls."
        onConnect={() => setOpen(true)}
        onDisconnect={disconnect}
        onActivate={onActivate}
      />
      {open && (
        <ConnectModal
          routerId="litellm"
          routerName="LiteLLM"
          docsUrl="https://docs.litellm.ai/docs/proxy/quick_start"
          extraFields={[
            {
              name: "base_url",
              label: "Base URL",
              placeholder: "e.g. http://localhost:4000",
              required: true,
            },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={connect}
        />
      )}
    </>
  );
}
