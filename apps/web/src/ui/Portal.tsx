import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Escape ancestor stacking contexts for a full-window overlay. */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
