import { readFileSync } from "node:fs";
import { BUILD_WEB_DEPENDENCIES, runPnpmSteps } from "./pnpm.mjs";
import { semver, validContractNumber } from "./ui-version.mjs";

// Relative to apps/web. Must match build.frontendDist in src-tauri/tauri.conf.json.
// A dedicated directory keeps the native-configured bundle from racing with the
// plain web build, which owns apps/web/dist and does not set the native API default.
export const NATIVE_OUT_DIR = "dist-native";

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const noReady = process.argv.includes("--ota-test-no-ready");
const embedded = process.argv.includes("--embedded");
const release = process.argv.includes("--release");
if ((embedded || release) && (noReady || process.env.VITE_OTA_TEST_NO_READY === "1")) {
  throw new Error("The OTA no-ready flag cannot be set for an embedded or release build.");
}
const outDir = noReady ? "dist-native-ota-no-ready" : NATIVE_OUT_DIR;
let contract;
if (embedded) {
  contract = read("../ui-bundle.json");
  try {
    semver(contract.embeddedUiVersion);
  } catch (error) {
    throw new Error("Invalid embeddedUiVersion in ui-bundle.json.", { cause: error });
  }
  for (const field of ["nativeContract", "embeddedDbSchemaVersion"]) {
    if (!validContractNumber(contract[field])) throw new Error(`Invalid ${field} in ui-bundle.json.`);
  }
}

runPnpmSteps([
  BUILD_WEB_DEPENDENCIES,
  // Mirrors the web package's build script ("tsc -b && vite build"), with a native outDir.
  ["--filter", "@e2ee-chat/web", "exec", "tsc", "-b"],
  ["--filter", "@e2ee-chat/web", "exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"],
], {
  ...process.env,
  PRIVATEBASE_NATIVE_WEB_BUILD: "1",
  ...(noReady ? { VITE_OTA_TEST_NO_READY: "1" } : {}),
  VITE_API_BASE_URL: process.env.VITE_API_BASE_URL?.trim() || "https://chat-api.718788.xyz",
});

if (contract) {
  const built = read(`../../web/${NATIVE_OUT_DIR}/schema-version.json`);
  if (built.version !== contract.embeddedDbSchemaVersion || built.otaTestNoReady) {
    throw new Error("The embeddedDbSchemaVersion must match the built web database schema for a full native build.");
  }
}
