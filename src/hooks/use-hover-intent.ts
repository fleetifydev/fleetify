import { useCallback, useEffect, useRef, useState } from "react";

interface HoverHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export interface HoverIntent {
  open: boolean;
  anchorProps: HoverHandlers;
  popupProps: HoverHandlers;
  close: () => void;
}

/** Hover-intent timing: open after `openDelay` of dwell, close `closeDelay`
 *  after the cursor leaves BOTH the anchor and the popup. The gap between the
 *  two lets the cursor travel anchor → card without the card vanishing. */
export function useHoverIntent(
  { openDelay = 400, closeDelay = 200 }: { openDelay?: number; closeDelay?: number } = {},
): HoverIntent {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpen = () => { if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; } };
  const clearClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };

  const scheduleOpen = useCallback(() => {
    clearClose();
    if (openTimer.current) return;
    openTimer.current = setTimeout(() => { openTimer.current = null; setOpen(true); }, openDelay);
  }, [openDelay]);

  const scheduleClose = useCallback(() => {
    clearOpen();
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, closeDelay);
  }, [closeDelay]);

  const cancelClose = useCallback(() => { clearClose(); }, []);

  const close = useCallback(() => { clearOpen(); clearClose(); setOpen(false); }, []);

  useEffect(() => () => { clearOpen(); clearClose(); }, []);

  return {
    open,
    anchorProps: { onMouseEnter: scheduleOpen, onMouseLeave: scheduleClose },
    popupProps: { onMouseEnter: cancelClose, onMouseLeave: scheduleClose },
    close,
  };
}
