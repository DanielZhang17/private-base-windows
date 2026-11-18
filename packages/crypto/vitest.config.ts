import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["../../scripts/strict-webcrypto-setup.ts"] },
});
