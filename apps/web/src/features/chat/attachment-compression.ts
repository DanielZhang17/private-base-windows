import { CHUNK_SIZE, MAX_FILE_SIZE } from "@e2ee-chat/shared";

export function isCompressibleMedia(file: File): boolean {
  return file.type.startsWith("image/") || file.type.startsWith("video/");
}

export function fitsAttachmentLimit(file: File): boolean {
  // The upload limit applies to the encrypted file, including the framing and AES-GCM tags.
  return file.size + 4 + Math.ceil(file.size / CHUNK_SIZE) * 20 <= MAX_FILE_SIZE;
}

async function compressImage(file: File, signal: AbortSignal): Promise<File> {
  // Canvas exports one frame. Only accept formats in which the selected file is still.
  if (file.type === "image/webp") {
    const bytes = new Uint8Array(await file.slice(12, 21).arrayBuffer());
    if (bytes.length >= 9 && String.fromCharCode(...bytes.subarray(0, 4)) === "VP8X" && (bytes[8] & 2)) {
      throw new Error("Animated WebP");
    }
  }
  // PNG may be animated even when its MIME type is image/png. Inspect the chunk
  // headers up to the first image data chunk (acTL must come before IDAT).
  if (file.type === "image/png") {
    let offset = 8;
    while (offset + 8 <= file.size) {
      signal.throwIfAborted();
      const header = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
      const type = header.getUint32(4);
      if (type === 0x6163544c) throw new Error("Animated PNG");
      if (type === 0x49444154) break;
      offset += header.getUint32(0) + 12;
    }
  } else if (file.type !== "image/jpeg" && file.type !== "image/webp") {
    throw new Error("Unsupported image format");
  }

  signal.throwIfAborted();
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image encoder unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const format = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format, 0.78));
    if (!blob) throw new Error("Image encoding failed");
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    return withExtension(file, blob, extension);
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}

function withExtension(file: File, blob: Blob, extension: string): File {
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.${extension}`, { type: blob.type });
}

async function compressVideo(file: File, signal: AbortSignal): Promise<File> {
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") {
    throw new Error("Video encoder unavailable");
  }
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_MEDIUM, WebMOutputFormat } =
    await import("mediabunny");
  signal.throwIfAborted();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track");
    const [width, height] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
    const scale = Math.min(1, 1280 / Math.max(width, height), 720 / Math.min(width, height));
    const formats = [
      { format: new Mp4OutputFormat(), video: "avc", audio: "aac", extension: "mp4" },
      { format: new WebMOutputFormat(), video: "vp8", audio: "opus", extension: "webm" },
    ] as const;
    for (const candidate of formats) {
      signal.throwIfAborted();
      const target = new BufferTarget();
      const output = new Output({ format: candidate.format, target });
      const conversion = await Conversion.init({
        input, output, showWarnings: false,
        video: {
          codec: candidate.video, bitrate: QUALITY_MEDIUM, fit: "contain", forceTranscode: true,
          width: Math.max(2, Math.floor(width * scale / 2) * 2),
          height: Math.max(2, Math.floor(height * scale / 2) * 2),
        },
        audio: { codec: candidate.audio },
      });
      if (!conversion.isValid || conversion.discardedTracks.length) {
        await conversion.cancel();
        continue;
      }
      const cancel = () => { void conversion.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        await conversion.execute();
        if (!target.buffer?.byteLength) throw new Error("Video encoding failed");
        return withExtension(file, new Blob([target.buffer], { type: `video/${candidate.extension}` }), candidate.extension);
      } catch {
        signal.throwIfAborted();
        await conversion.cancel().catch(() => undefined);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    throw new Error("Unsupported video tracks");
  } finally {
    input.dispose();
  }
}

export async function compressAttachment(file: File, signal: AbortSignal): Promise<File> {
  signal.throwIfAborted();
  const compressed = await (file.type.startsWith("video/") ? compressVideo(file, signal) : compressImage(file, signal));
  signal.throwIfAborted();
  return compressed.size < file.size ? compressed : file;
}
