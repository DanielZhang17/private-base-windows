import { bootstrap } from "./bootstrap.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import NativePasskeyPage from "./pages/NativePasskeyPage.js";
import { queryClient } from "./lib/query-client.js";
import { RouterNavigation } from "./platform/RouterNavigation.js";
import "./index.css";

void bootstrap(async () => {
  // Handoff pages never mount authentication, session repair, or local-key effects.
  const nativeHandoff = ["/native/passkey/sign-in", "/native/passkey/add"].includes(location.pathname);
  const App = nativeHandoff ? NativePasskeyPage : (await import("./App.js")).default;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* Both web and native use BrowserRouter: Tauri 2's asset resolver falls back to
            index.html for unknown paths, including tauri://localhost/chat/….
            Source: https://github.com/tauri-apps/tauri/blob/tauri-v2.0.0/crates/tauri/src/manager/mod.rs#L379-L385 */}
        <BrowserRouter>
          <RouterNavigation />
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>
  );
});
