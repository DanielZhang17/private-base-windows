import { createContext } from "react";
import type { useCallInvitationOwner } from "./useCallInvitationOwner.js";

export const IncomingCallContext = createContext<ReturnType<typeof useCallInvitationOwner> | null>(null);
