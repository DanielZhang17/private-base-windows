import { Spinner, ToastProvider } from "./ui/index.js";
import { useAuthPhase, useAppLifecycle, type AuthPhase } from "./features/chat/useAppPhase.js";
import { useRef } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import LoginPage from "./pages/LoginPage.js";
import RegisterPage from "./pages/RegisterPage.js";
import UnlockPage from "./pages/UnlockPage.js";
import ChatPage from "./pages/ChatPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import CallPage from "./pages/CallPage.js";
import VerifyPage from "./pages/VerifyPage.js";
import DeviceLinkPage from "./pages/DeviceLinkPage.js";
import Layout from "./components/layout/Layout.js";
import SettingsLayout from "./components/layout/SettingsLayout.js";
import UnlockedAppEffects from "./components/app/UnlockedAppEffects.js";
import UiPreferencesEffects from "./components/app/UiPreferencesEffects.js";
import SessionRepairEffects from "./components/app/SessionRepairEffects.js";

function FullScreenLoader() {
  return (
    <div className="h-dvh bg-canvas flex flex-col gap-6 items-center justify-center px-safe pb-safe pt-safe">
      <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-20" />
      <Spinner label="Opening Private Base" size={32} />
    </div>
  );
}

function ProtectedRoute({ phase, children }: { phase: AuthPhase; children: React.ReactNode }) {
  const location = useLocation();

  if (phase === "checking") return <FullScreenLoader />;
  if (phase === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (phase === "locked") {
    return <Navigate to="/unlock" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}

function PublicOnlyRoute({ phase, children, preserveAfterAuth = false }: {
  phase: AuthPhase;
  children: React.ReactNode;
  preserveAfterAuth?: boolean;
}) {
  const location = useLocation();
  const enteredAnonymously = useRef(false);
  if (phase === "anonymous") enteredAnonymously.current = true;

  // Registration must stay mounted until its recovery key has been acknowledged.
  if (preserveAfterAuth && enteredAnonymously.current) return <>{children}</>;

  if (phase === "checking") return <FullScreenLoader />;
  if (phase === "unlocked") return <Navigate to="/" replace />;
  if (phase === "locked") return <Navigate to="/unlock" replace state={{ from: location }} />;
  return <>{children}</>;
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

  if (phase === "checking") return <FullScreenLoader />;
  if (phase === "anonymous") return <Navigate to="/login" replace />;
  if (phase === "unlocked") return <Navigate to={returnTo} replace />;
  return <UnlockPage />;
}

export default function App() {
  const phase = useAuthPhase();
  useAppLifecycle(phase);

  return (
    <ToastProvider>
      <SessionRepairEffects />
      <UiPreferencesEffects />
      {phase === "unlocked" && <UnlockedAppEffects />}

      <Routes>
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
        <Route
          path="/call/:callId"
          element={(
            <ProtectedRoute phase={phase}>
              <CallPage />
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
