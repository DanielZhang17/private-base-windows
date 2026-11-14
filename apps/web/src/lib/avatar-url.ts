import { resolveApiUrl } from "../services/api.js";

export function resolveAvatarImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("genshin://")) {
    const slug = value.slice("genshin://".length);
    return resolveApiUrl(`/api/account/avatars/genshin/${encodeURIComponent(slug)}`);
  }
  if (value.startsWith("dicebear://")) {
    const [style, seed] = value.slice(11).split("/");
    return seed ? `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}` : null;
  }
  if (value.startsWith("r2://")) return resolveApiUrl(`/api/account/avatar/${value.slice(5)}`);
  return null;
}
