import SessionEndedPage from "./pages/SessionEndedPage.js";
import { NewDeviceAlerts } from "./features/devices/NewDeviceAlert.js";
import { Notice, Spinner } from "./ui/index.js";
import { useAuthPhase, useAppLifecycle, useDatabaseUpgradeBlocked, type AuthPhase } from "./features/chat/useAppPhase.js";
import { useRef } from "react";
import { Routes, Route, Navigate, Outlet, useLocation } from "react-router-dom";
import LoginPage from "./pages/LoginPage.js";
import RegisterPage from "./pages/RegisterPage.js";
import UnlockPage from "./pages/UnlockPage.js";
import ChatPage from "./pages/ChatPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import { CallProvider } from "./features/calls/CallProvider.js";
import CallPage from "./pages/CallPage.js";
import VerifyPage from "./pages/VerifyPage.js";
import DeviceLinkPage from "./pages/DeviceLinkPage.js";
import ClientsPage from "./pages/ClientsPage.js";
import { CLIENTS_PATH, CLIENTS_RELEASES_PATH } from "./features/clients/routes.js";
import Layout from "./components/layout/Layout.js";
import SettingsLayout from "./components/layout/SettingsLayout.js";
import { HistoryTransferOwner, HistoryTransferScreen, TRANSFER_PATH, TRANSFER_SETUP_PATH } from "./features/transfer/HistoryTransferScreens.js";
import { capabilities } from "./platform/capabilities.js";
import { SettingsFrame } from "./features/settings/SettingsFrame.js";
import { CaptureProtectionGate } from "./features/settings/CaptureProtectionGate.js";
import { t } from "./i18n/index.js";
import UnlockedAppEffects from "./components/app/UnlockedAppEffects.js";
import UiPreferencesEffects from "./components/app/UiPreferencesEffects.js";
import SessionRepairEffects from "./components/app/SessionRepairEffects.js";
import { UpdateProvider } from "./features/updates/UpdateProvider.js";
import WebPushEffects from "./components/app/WebPushEffects.js";
import SaveFeedbackToastProvider from "./components/app/SaveFeedbackToastProvider.js";

function FullScreenLoader({ phase }: { phase: AuthPhase }) {
  return (
    <div className="h-dvh bg-canvas flex flex-col gap-6 items-center justify-center px-safe pb-safe pt-safe">
      <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-20" />
      {phase !== "database-error" && <Spinner label="Opening Private Base" size={32} />}
      {phase === "database-blocked" && <p role="alert" className="max-w-sm text-center">{t("databaseUpgradeBlocked")}</p>}
      {phase === "database-error" && <p role="alert" className="max-w-sm text-center">{t("databaseStartupFailed")}</p>}
    </div>
  );
}

function hasStartupScreen(phase: AuthPhase) {
  return phase === "checking" || phase === "database-blocked" || phase === "database-error";
}

function ProtectedRoute({ phase, children }: { phase: AuthPhase; children: React.ReactNode }) {
  const location = useLocation();

  if (hasStartupScreen(phase)) return <FullScreenLoader phase={phase} />;
  if (phase === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (phase === "locked") {
    return <Navigate to="/unlock" replace state={{ from: location }} />;
  }
  // Android: no chat is shown until screenshot protection is confirmed on.
  return <CaptureProtectionGate>{children}</CaptureProtectionGate>;
}

function PublicOnlyRoute({ phase, children, preserveAfterAuth = false }: {
  phase: AuthPhase;
  children: React.ReactNode;
  preserveAfterAuth?: boolean;
}) {
  const location = useLocation();
  const enteredAnonymously = useRef(false);
  const upgradeBlocked = useDatabaseUpgradeBlocked();
  if (phase === "anonymous") enteredAnonymously.current = true;
  const form = <>{children}{upgradeBlocked && <div className="fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-safe">
    <Notice tone="warning" className="mt-2 max-w-sm">{t("databaseUpgradeBlocked")}</Notice>
  </div>}</>;

  // Registration must stay mounted until its recovery key has been acknowledged.
  if (enteredAnonymously.current && (preserveAfterAuth || phase === "database-blocked")) return form;

  if (hasStartupScreen(phase)) return <FullScreenLoader phase={phase} />;
  if (phase === "unlocked") return <Navigate to="/" replace />;
  if (phase === "locked") return <Navigate to="/unlock" replace state={{ from: location }} />;
  return form;
}

function UnlockRoute({ phase }: { phase: AuthPhase }) {
  const location = useLocation();

  const returnTo = (() => {
    const state = location.state as
      | {
          from?: {
            pathname?: string;
            search?: string;
            hash?: string;
          };
        }
      | null;
    const from = state?.from;
    if (!from?.pathname) return "/";
    return `${from.pathname}${from.search ?? ""}${from.hash ?? ""}`;
  })();

  if (hasStartupScreen(phase)) return <FullScreenLoader phase={phase} />;
  if (phase === "anonymous") return <Navigate to="/login" replace />;
  if (phase === "unlocked") return <Navigate to={returnTo} replace />;
  return <UnlockPage />;
}

export default function App() {
  const phase = useAuthPhase();
  useAppLifecycle(phase);

  return (
    <SaveFeedbackToastProvider>
      <SessionRepairEffects />
      <WebPushEffects unlocked={phase === "unlocked"} />
      <UiPreferencesEffects />
      {phase === "unlocked" && <><UnlockedAppEffects />{capabilities.historyTransfer && <HistoryTransferOwner />}</>}

      <CallProvider enabled={phase === "unlocked"}>
      <Routes>
        {/* The public download route never mounts the updater, including after in-app navigation. */}
        <Route path={CLIENTS_PATH} element={<ClientsPage />} />
        <Route path={CLIENTS_RELEASES_PATH} element={<ClientsPage />} />
        <Route element={<UpdateProvider><Outlet /></UpdateProvider>}>
        <Route
          path="/login"
          element={(
            <PublicOnlyRoute phase={phase}>
              <LoginPage />
            </PublicOnlyRoute>
          )}
        />
        <Route
          path="/register"
          element={(
            <PublicOnlyRoute phase={phase} preserveAfterAuth>
              <RegisterPage />
            </PublicOnlyRoute>
          )}
        />
        <Route path="/unlock" element={<UnlockRoute phase={phase} />} />
        <Route path="/session-ended" element={<SessionEndedPage />} />
        <Route
          path="/call/:callId"
          element={(
            <ProtectedRoute phase={phase}>
              <CallPage banner={<NewDeviceAlerts compact />} />
            </ProtectedRoute>
          )}
        />
        <Route
          path="/"
          element={(
            <ProtectedRoute phase={phase}>
              <Layout />
            </ProtectedRoute>
          )}
        >
          <Route path="chat/:conversationId" element={<ChatPage />} />
        </Route>
        <Route
          element={(
            <ProtectedRoute phase={phase}>
              <SettingsLayout />
            </ProtectedRoute>
          )}
        >
          <Route path="settings" element={<SettingsPage />} />
          <Route path="verify/:userId" element={<VerifyPage />} />
          <Route path="devices" element={<DeviceLinkPage />} />
          {capabilities.historyTransfer && <Route path={TRANSFER_PATH} element={<SettingsFrame title={t("transfer.title")} section="devices" detailOwnsHeading detail={<HistoryTransferScreen />} />} />}
        </Route>
        {capabilities.historyTransfer && <Route path={TRANSFER_SETUP_PATH} element={<ProtectedRoute phase={phase}>
          <div className="transfer-setup flex h-dvh flex-col bg-canvas"><div className="transfer-setup-card flex min-h-0 flex-1 flex-col"><HistoryTransferScreen setup /></div></div>
        </ProtectedRoute>} />}
        <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </CallProvider>
    </SaveFeedbackToastProvider>
  );
}
