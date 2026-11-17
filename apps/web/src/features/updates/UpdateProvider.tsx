import { createContext, useContext, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useCall } from "../calls/CallContext.js";
import { useCallStore } from "../../stores/callStore.js";
import { useAuthStore } from "../../stores/authStore.js";
import { clearAccountScopedState } from "../../platform/session.js";
import { Button, Dialog } from "../../ui/index.js";
import { t, useLocale } from "../../i18n/index.js";
import { useUpdates } from "./useUpdates.js";
import { UpdateActions, UpdateStatus } from "./UpdateStatus.js";

const UpdateContext = createContext<ReturnType<typeof useUpdates> | null>(null);
export const useAppUpdates = () => useContext(UpdateContext);

export function UpdateProvider({ children }: { children: ReactNode }) {
  useLocale();
  const call = useCall();
  const pendingCall = useCallStore(s => !!s.pendingCallStart || s.callStatus === "active" || s.callStatus === "ringing");
  const update = useUpdates(pendingCall || call.stage !== "ended");
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const navigate = useNavigate();
  const [dismissedMandatory, setDismissedMandatory] = useState(false);
  function signOut() {
    clearAccountScopedState(); logout(); navigate("/login", { replace: true });
    setDismissedMandatory(true);
  }
  const mandatory = !!update.kind && !!update.state.update?.mandatory && (!!user || !dismissedMandatory);
  return <UpdateContext.Provider value={update}>
    {children}
    <Dialog open={mandatory} onClose={signOut} dismissible={false} title={t("updates.requiredTitle")}
      description={t("updates.requiredBody")}
      footer={<><Button variant="secondary" onClick={signOut}>{t("signOut3")}</Button><UpdateActions update={update} /></>}>
      <UpdateStatus update={update} />
    </Dialog>
  </UpdateContext.Provider>;
}
