import { useContext, useEffect, useState } from "react";
import { useLocale } from "../../i18n/index.js";
import { useCallStore } from "../../stores/callStore.js";
import { capabilities } from "../../platform/capabilities.js";
import { IncomingCallContext } from "./IncomingCallContext.js";

/** Modal view state over the persistent invitation owner. */
export function useIncomingCall() {
  useLocale();
  const owner = useContext(IncomingCallContext);
  if (!owner) throw new Error("useIncomingCall must be used inside CallProvider");
  const call = useCallStore();
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return {
    callerName: call.callerName, callerAvatarUrl: call.callerAvatarUrl, callType: call.callType,
    keyReady: call.keyReady,
    visible: !(capabilities.nativeCallNotifications && hidden) && !!call.activeCallId && !!call.callType && call.direction === "incoming" && call.callStatus === "ringing",
    callUnsupported: !capabilities.e2eeCalls,
    ...owner,
  };
}
