import en from "../i18n/locales/en.json";
import { isNative, platformName } from "./environment.js";
import { capabilities } from "./capabilities.js";

export class SaveUnsupportedError extends Error {
  readonly code = "SAVE_UNSUPPORTED";

  constructor() {
    super(en.savingFilesIsUnavailableOnThisDeviceImages);
    this.name = "SaveUnsupportedError";
  }
}

export async function saveFile(blob: Blob, filename: string): Promise<"saved" | "cancelled" | undefined> {
  if (!capabilities.saveFile) throw new SaveUnsupportedError();

  if (isNative() && capabilities.fileSave) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<"saved" | "cancelled">("save_file", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-file-name": encodeURIComponent(filename), "x-mime-type": blob.type || "application/octet-stream" } });
  }
  if (isNative()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: filename });
    if (path === null) return "cancelled";
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return "saved";
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
  return undefined;
}

/** Decrypted web bytes stay in memory unless the user explicitly downloads the file. */
export async function openFile(blob: Blob, filename: string, mimeType: string): Promise<void> {
  if (isNative()) {
    if (!capabilities.fileOpen) {
      await saveFile(blob, filename);
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>("open_file", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-file-name": encodeURIComponent(filename), "x-mime-type": mimeType } });
    return;
  }
  if (!webViewable(mimeType)) {
    await saveFile(blob, filename);
    return;
  }
  showWebFile(blob, mimeType);
}

// Unknown/active types (including SVG) never become navigation or preview targets.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp", "image/tiff", "image/x-icon", "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
export function filePreviewKind(mimeType: string): "image" | "video" | "pdf" | "text" | null {
  const type = mimeType.toLowerCase().split(";")[0].trim();
  return IMAGE_TYPES.has(type) ? "image" : VIDEO_TYPES.has(type) ? "video"
    : type === "application/pdf" ? "pdf" : TEXT_TYPES.has(type) ? "text" : null;
}

function webViewable(mimeType: string): boolean {
  const kind = filePreviewKind(mimeType);
  // Text is rendered as textContent by the app viewer, never navigated.
  return kind === "pdf" || kind === "image" || kind === "video";
}

function showWebFile(blob: Blob, mimeType: string, reserved?: Window): void {
  if (filePreviewKind(mimeType) === "pdf") {
    // Force the PDF viewer's MIME; neither the Blob type nor filename is trusted.
    const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    try {
      if (reserved) {
        if (reserved.closed) throw new Error("FILE_OPEN_BLOCKED");
        reserved.opener = null;
        reserved.location.replace(url);
      } else {
        // noopener may return null even on success, so it is not a popup-block signal.
        window.open(url, "_blank", "noopener");
      }
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    return;
  }
  const contentUrl = URL.createObjectURL(new Blob([blob], { type: mimeType.toLowerCase().split(";")[0].trim() }));
  // Even mislabeled bytes stay inside an opaque origin. The outer page contains
  // only this trusted iframe markup, never a filename or attachment content.
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  frame.src = contentUrl;
  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
  const url = URL.createObjectURL(new Blob(["<!doctype html><meta charset=utf-8>", frame.outerHTML], { type: "text/html" }));
  try {
    const tab = reserved ?? window.open(url, "_blank");
    if (!tab || tab.closed) throw new Error("FILE_OPEN_BLOCKED");
    tab.opener = null;
    if (reserved) tab.location.replace(url);
  } finally {
    setTimeout(() => { URL.revokeObjectURL(url); URL.revokeObjectURL(contentUrl); }, 60_000);
  }
}

/** Reserve synchronously during the tap, before fetching/decrypting loses user activation. */
export function prepareFileOpen(mimeType: string): { open: (blob: Blob) => void; cancel: () => void } | null {
  if (isNative() || !webViewable(mimeType)) return null;
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("FILE_OPEN_BLOCKED");
  tab.opener = null;
  return { open: (blob) => showWebFile(blob, mimeType, tab), cancel: () => tab.close() };
}

// This UI policy complements the native command's mandatory validation; it never replaces it.
const WINDOWS_OPEN_BLOCKED = new Set("exe com scr pif cpl msi msp mst bat cmd ps1 psm1 psd1 ps1xml vbs vbe js jse wsf wsh wsc hta lnk url reg inf scf jar py pyw pyc pyo pyz rb pl php sh bash appref-ms application gadget msc vb chm settingcontent-ms library-ms appx appxbundle msix msixbundle".split(" "));
const MAC_OPEN_BLOCKED = new Set("app command tool sh bash zsh csh ksh terminal workflow action scpt scptd applescript pkg mpkg jar py pl rb php osx dylib bundle plugin kext prefpane".split(" "));
const BLOCKED_MIME = new Set(["application/x-msdownload", "application/x-sh", "application/x-executable", "application/java-archive", "text/x-python", "application/javascript", "text/javascript", "application/x-msi", "application/x-msdos-program"]);
export function isFileOpenBlocked(name: string, mimeType: string): boolean {
  const extension = name.trim().toLowerCase().split(".").at(-1) ?? "";
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  const platform = platformName();
  if (BLOCKED_MIME.has(mime)) return true;
  if (platform === "android") return extension === "apk" || mime === "application/vnd.android.package-archive";
  if (platform === "ios") return false;
  if (platform === "web" && (["svg", "svgz", "html", "htm", "xhtml", "xml", "js", "mjs", "cjs"].includes(extension) || ["image/svg+xml", "text/html", "application/xhtml+xml", "application/xml", "text/xml"].includes(mime))) return true;
  return (platform === "web" || platform === "windows") && (WINDOWS_OPEN_BLOCKED.has(extension) || extension.startsWith("msh"))
    || (platform === "web" || platform === "macos") && MAC_OPEN_BLOCKED.has(extension);
}

export function canOpenFile(name: string, mimeType: string): boolean {
  return !isFileOpenBlocked(name, mimeType) && (isNative() || filePreviewKind(mimeType) !== null);
}
