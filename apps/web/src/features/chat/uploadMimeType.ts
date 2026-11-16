import { ALLOWED_MIME_TYPES } from "@e2ee-chat/shared";

/** Only supported image/video types are exposed in upload metadata. */
export function uploadMimeType(file: Pick<File, "type">): string {
  const type = file.type.trim().toLowerCase();
  return (type.startsWith("image/") || type.startsWith("video/"))
    && ALLOWED_MIME_TYPES.some((allowed) => allowed === type) ? type : "application/octet-stream";
}
