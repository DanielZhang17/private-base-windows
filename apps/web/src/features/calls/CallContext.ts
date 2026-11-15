import { createContext, useContext } from "react";
import type { useCallSession } from "./useCall.js";

export const CallContext = createContext<ReturnType<typeof useCallSession> | null>(null);

/** Views consume one app-owned call; they never start or dispose media. */
export function useCall() {
  const call = useContext(CallContext);
  if (!call) throw new Error("useCall must be used inside CallProvider");
  return call;
}
