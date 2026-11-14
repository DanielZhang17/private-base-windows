import { Outlet } from "react-router-dom";
import { useOutgoingQueue } from "../../features/chat/useOutgoingQueue.js";
import IncomingCallModal from "../calls/IncomingCallModal.js";

/** Settings pages provide their own visual shell; keep unlocked background behavior. */
export default function SettingsLayout() {
  useOutgoingQueue();
  return <><IncomingCallModal /><Outlet /></>;
}
