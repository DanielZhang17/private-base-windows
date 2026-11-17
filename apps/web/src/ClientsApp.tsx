import ClientsPage from "./pages/ClientsPage.js";
import { ToastProvider } from "./ui/index.js";

/**
 * Standalone root for a direct visit to /clients. Unlike App it mounts no auth phase,
 * key, session-repair, push, call or sync effects, and imports no stores or crypto.
 * The theme follows the system preference through the CSS tokens.
 */
export default function ClientsApp() {
  return (
    <ToastProvider>
      <ClientsPage />
    </ToastProvider>
  );
}
