import { expect, it } from "vitest";
import { ALLOWED_MIME_TYPES } from "@e2ee-chat/shared";
import { uploadMimeType } from "./uploadMimeType.js";

it.each(ALLOWED_MIME_TYPES)("selects upload metadata for %s", (type) => {
  expect(uploadMimeType({ type })).toBe(/^(image|video)\//.test(type) ? type : "application/octet-stream");
});

it.each([
  [" IMAGE/AVIF ", "image/avif"], ["Video/QuickTime", "video/quicktime"],
  ["image/svg+xml", "application/octet-stream"], ["video/x-matroska", "application/octet-stream"],
  ["image/png; charset=utf-8", "application/octet-stream"], ["image/", "application/octet-stream"],
  ["application/x-apple-diskimage", "application/octet-stream"], ["application/zip", "application/octet-stream"],
  ["", "application/octet-stream"], ["  ", "application/octet-stream"],
])("normalizes or safely falls back for %j", (type, expected) => {
  expect(uploadMimeType({ type })).toBe(expected);
});
