import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const nativeBuild = process.env.PRIVATEBASE_NATIVE_WEB_BUILD === "1";
let noReady = false;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "native-db-schema",
      apply: "build",
      configResolved(config) {
        noReady = config.env.VITE_OTA_TEST_NO_READY === "1";
        const outDir = resolve(config.root, config.build.outDir);
        if (noReady && (!nativeBuild || outDir !== resolve(config.root, "dist-native-ota-no-ready")
          || lstatSync(outDir, { throwIfNoEntry: false })?.isSymbolicLink())) {
          throw new Error("The OTA no-ready flag requires the dedicated fixture output directory.");
        }
      },
      generateBundle() {
        if (!nativeBuild) return;
        const schema = readFileSync(new URL("./src/db/schema-version.json", import.meta.url), "utf8");
        this.emitFile({
          type: "asset",
          fileName: "schema-version.json",
          source: noReady
            ? JSON.stringify({ ...JSON.parse(schema), otaTestNoReady: true })
            : schema,
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:8787",
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  esbuild: {
    target: "es2022",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "es2022",
    },
  },
  build: {
    target: "es2022",
  },
});
