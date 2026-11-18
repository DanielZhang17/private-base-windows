import { useCallback, useLayoutEffect, useRef } from "react";
import { getTopOverlay, registerOverlay, type Overlay } from "./overlay-stack.js";

export function useOverlayLayer(open: boolean, kind: "modal" | "popover", rank: number, onBack?: () => void, dismissOnBack = !!onBack) {
  const entry = useRef<Overlay | undefined>(undefined);
  const back = useRef(onBack);
  back.current = onBack;
  const handlesBack = !!onBack;
  useLayoutEffect(() => {
    if (!open) return;
    const overlay: Overlay = { kind, rank, dismissOnBack, onBack: handlesBack ? () => back.current?.() : undefined };
    entry.current = overlay;
    const unregister = registerOverlay(overlay);
    return () => { unregister(); entry.current = undefined; };
  }, [open, kind, rank, handlesBack, dismissOnBack]);
  return useCallback(() => !!entry.current && getTopOverlay() === entry.current, []);
}
