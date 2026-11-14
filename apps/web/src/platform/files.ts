import en from "../i18n/locales/en.json";
import { isNative } from "./environment.js";
import { capabilities } from "./capabilities.js";

export class SaveUnsupportedError extends Error {
  readonly code = "SAVE_UNSUPPORTED";

  constructor() {
    super(en.savingFilesIsUnavailableOnThisDeviceImages);
    this.name = "SaveUnsupportedError";
  }
}

export async function saveFile(blob: Blob, filename: string): Promise<void> {
  if (!capabilities.saveFile) throw new SaveUnsupportedError();

  if (isNative()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: filename });
    if (path === null) return;
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser start the download before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
