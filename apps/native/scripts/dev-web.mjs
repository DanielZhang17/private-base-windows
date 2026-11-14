import { BUILD_WEB_DEPENDENCIES, runPnpmSteps } from "./pnpm.mjs";

// beforeDevCommand: Vite resolves the workspace packages through their generated
// dist entries, so build them before starting the (long-running) dev server.
// The strict port keeps Tauri from loading another application's server.
runPnpmSteps([
  BUILD_WEB_DEPENDENCIES,
  ["--filter", "@e2ee-chat/web", "dev", "--host", "127.0.0.1", "--strictPort"],
]);
