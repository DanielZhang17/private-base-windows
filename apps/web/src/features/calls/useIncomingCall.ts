import { renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale } from "../../i18n/index.js";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../services/api.js";
import { useCallStore } from "../../stores/callStore.js";
import { capabilities } from "../../platform/capabilities.js";

export function useIncomingCall() {
  useLocale();
  const navigate = useNavigate();
  const call = useCallStore();
  const busy = useRef(false);
  const [loadingAction, setLoadingAction] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const callUnsupported = !capabilities.e2eeCalls;
  const respond = async (action: "accept" | "decline") => {
    if (busy.current || !call.activeCallId || (action === "accept" && (!call.keyReady || callUnsupported))) return;
    busy.current = true;
    setLoadingAction(action);
    setError(null);
    try {
      await api.post(`/api/calls/${call.activeCallId}/${action}`);
      call.updateCallStatus(call.activeCallId, action === "accept" ? "active" : "declined");
      if (action === "accept") navigate(`/call/${call.activeCallId}`);
    } catch (err) { setError(toErrorMessage(err, "couldNotRespondToCall")); }
    finally { busy.current = false; setLoadingAction(null); }
  };
  return { callerName: call.callerName, callerAvatarUrl: call.callerAvatarUrl, callType: call.callType,
    keyReady: call.keyReady, visible: !!call.activeCallId && !!call.callType && call.direction === "incoming" && call.callStatus === "ringing", loadingAction, error: error ? renderMessage(error) : error, callUnsupported, respond };
}
