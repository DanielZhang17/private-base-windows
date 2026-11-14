import { BUILD_WEB_DEPENDENCIES, runPnpmSteps } from "./pnpm.mjs";

// Relative to apps/web. Must match build.frontendDist in src-tauri/tauri.conf.json.
// A dedicated directory keeps the native-configured bundle from racing with the
// plain web build, which owns apps/web/dist and does not set the native API default.
export const NATIVE_OUT_DIR = "dist-native";

runPnpmSteps([
  BUILD_WEB_DEPENDENCIES,
  // Mirrors the web package's build script ("tsc -b && vite build"), with a native outDir.
  ["--filter", "@e2ee-chat/web", "exec", "tsc", "-b"],
  ["--filter", "@e2ee-chat/web", "exec", "vite", "build", "--outDir", NATIVE_OUT_DIR, "--emptyOutDir"],
], {
  ...process.env,
  VITE_API_BASE_URL: process.env.VITE_API_BASE_URL?.trim() || "https://chat-api.718788.xyz",
});
