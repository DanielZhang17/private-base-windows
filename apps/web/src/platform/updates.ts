import { capabilities } from "./capabilities.js";

export type UpdateChannel = "stable" | "beta";
export interface UpdateCheck {
  available: boolean;
  version?: string;
  notes?: string;
  sizeBytes?: number;
  mandatory?: boolean;
}
export interface UpdateProgress { downloaded: number; total: number }
export type UpdateErrorCode = "unsupported" | "network" | "permission_required" | "failed";
export class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode) { super(code); }
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!capabilities.autoUpdate) throw new UpdateError("unsupported");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(name, args);
  } catch (error) {
    // Never expose native diagnostics, which can contain local paths or secrets.
    throw new UpdateError(error === "unsupported" || error === "network" || error === "permission_required" ? error : "failed");
  }
}

/** Native owns endpoints, rollout decisions, verification and the prepared update. */
export const updates = {
  async getVersion(): Promise<string> {
    if (!capabilities.autoUpdate) throw new UpdateError("unsupported");
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    } catch { throw new UpdateError("failed"); }
  },
  check: (channel: UpdateChannel) => command<UpdateCheck>("update_check", { channel }),
  download: () => command<void>("update_download"),
  install: () => command<void>("update_install"),
  openPermissionSettings: () => capabilities.autoUpdate === "android"
    ? command<void>("update_open_permission_settings") : Promise.reject(new UpdateError("unsupported")),
  async onProgress(callback: (progress: UpdateProgress) => void): Promise<() => void> {
    if (!capabilities.autoUpdate) throw new UpdateError("unsupported");
    try {
      const { listen } = await import("@tauri-apps/api/event");
      return await listen<UpdateProgress>("update-progress", ({ payload }) => {
        if (Number.isFinite(payload?.downloaded) && payload.downloaded >= 0 && Number.isFinite(payload.total) && payload.total >= 0) callback(payload);
      });
    } catch { throw new UpdateError("failed"); }
  },
};
