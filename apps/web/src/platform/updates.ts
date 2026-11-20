import { capabilities } from "./capabilities.js";
import { isNative } from "./environment.js";

export type UpdateChannel = "stable" | "beta";
export const UPDATE_CHANNEL_KEY = "private-base:update-channel";

export interface UiBundleInfo {
  appVersion: string;
  uiVersion: string;
  uiSource: "embedded" | "ota";
}

function isReadOnlyOta(): boolean {
  return isNative() && window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.otaUi === "read-only";
}

function localUpdateChannel(): UpdateChannel {
  try { return localStorage.getItem(UPDATE_CHANNEL_KEY) === "beta" ? "beta" : "stable"; }
  catch { return "stable"; }
}

export async function readUpdateChannel(): Promise<UpdateChannel> {
  if (capabilities.otaUiAvailable) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const native = await invoke<UpdateChannel | null>("ui_bundle_get_channel");
      if (native === "stable" || native === "beta") return native;
    } catch { /* Use the local preference if native state is unavailable. */ }
  }
  return localUpdateChannel();
}

export type UiRestartErrorCode = "not_ready" | "unsupported" | "failed";
export class UiRestartError extends Error {
  constructor(readonly code: UiRestartErrorCode) { super(code); }
}

/** Waits before the 2nd and 3rd acknowledgement: all tries end about 5 s in, inside the shell's 20 s window. */
export const UI_READY_RETRY_DELAYS = [1000, 4000] as const;
// Native answers that retrying cannot change. Anything else may be transient.
const DEFINITIVE_READY_ERRORS = new Set(["unsupported", "no_trial"]);

/** One acknowledgement with retries; `uiBundles.ready()` runs it at most once per process. */
export async function acknowledgeUiBundleReady(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<void>("ui_bundle_ready", { channel: localUpdateChannel() });
      return;
    } catch (error) {
      const delay = UI_READY_RETRY_DELAYS[attempt];
      if (delay === undefined || (typeof error === "string" && DEFINITIVE_READY_ERRORS.has(error))) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

let ready: Promise<void> | undefined;
export const uiBundles = {
  isReadOnly: isReadOnlyOta,
  getActive(): UiBundleInfo | undefined {
    return capabilities.otaUiAvailable ? window.__PRIVATEBASE_UI_BUNDLE__ ?? undefined : undefined;
  },
  /** Imports the saved Stable/Beta choice; native fills only an unset preference. */
  async initializeChannel(): Promise<void> {
    if (!capabilities.otaUi) return;
    const channel = localUpdateChannel();
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ui_bundle_initialize_channel", { channel });
  },
  async setChannel(channel: UpdateChannel): Promise<void> {
    if (isReadOnlyOta()) throw new UpdateError("failed");
    if (!capabilities.otaUi) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ui_bundle_set_channel", { channel });
  },
  ready(): Promise<void> | undefined {
    if (!capabilities.otaUi) return;
    return ready ??= acknowledgeUiBundleReady();
  },
  /** Gracefully restarts into the staged bundle on desktop. Native re-verifies it first. */
  async restart(): Promise<void> {
    if (!capabilities.otaUiRestart) throw new UiRestartError("unsupported");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<void>("ui_bundle_restart");
    } catch (error) {
      // Never expose native diagnostics.
      throw new UiRestartError(error === "not_ready" || error === "unsupported" ? error : "failed");
    }
  },
  /** Verified UI version staged for the next launch. Undefined when none, unknown or unsupported. */
  async getPending(): Promise<string | undefined> {
    if (!capabilities.otaUi) return undefined;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const version = await invoke<string | null>("ui_bundle_get_pending");
      return typeof version === "string" && version ? version : undefined;
    } catch { return undefined; }
  },
  async isAndroidUnmetered(): Promise<boolean | null> {
    if (!capabilities.otaUiAvailable) return null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<boolean | null>("ui_bundle_is_unmetered");
    } catch { return null; }
  },
};

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
