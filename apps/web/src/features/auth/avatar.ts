import { resolveAvatarImageUrl } from "../../lib/avatar-url.js";

/** Resolve stored avatar references before passing them to the presentational Avatar. */
export function authAvatarSrc(value: string | null | undefined): string | undefined {
  return resolveAvatarImageUrl(value) ?? undefined;
}
