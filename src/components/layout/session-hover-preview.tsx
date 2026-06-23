import type { RefObject } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import type { Session } from "@/types/session";
import { useSessionGitContext } from "@/hooks/use-session-git-context";
import { SessionPreviewCard } from "@/components/layout/session-preview-card";

interface Props {
  session: Session;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  popupProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  onClose: () => void;
}

/** Floating hover preview anchored to the right of a session row.
 *  Timing is owned by useHoverIntent (the `open`/`popupProps`/`onClose` props);
 *  base-ui PreviewCard parts give focus-safe hover-card positioning. */
export function SessionHoverPreview({ session, anchor, open, popupProps, onClose }: Props) {
  const gitContext = useSessionGitContext(session.worktree_path ?? session.project_path, open);

  return (
    <PreviewCard.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          anchor={anchor}
          side="right"
          align="start"
          sideOffset={8}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          style={{ zIndex: 60 }}
        >
          <PreviewCard.Popup
            onMouseEnter={popupProps.onMouseEnter}
            onMouseLeave={popupProps.onMouseLeave}
            style={{ outline: "none" }}
          >
            <SessionPreviewCard session={session} gitContext={gitContext} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
