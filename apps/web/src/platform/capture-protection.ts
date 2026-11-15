export async function getCaptureProtection(): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{ enabled: boolean }>("get_capture_protection");
  return result.enabled;
}

export async function setCaptureProtection(enabled: boolean): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("set_capture_protection", { enabled });
}
