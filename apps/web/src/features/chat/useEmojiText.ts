import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResolveCustomEmojisResponse } from "@e2ee-chat/shared";
import { parseEmojiTextSegments } from "../../lib/custom-emojis.js";
import { api, resolveApiUrl } from "../../services/api.js";

export function useEmojiText(content: string) {
  const segments = useMemo(() => parseEmojiTextSegments(content), [content]);
  const emojiIds = useMemo(
    () => [...new Set(segments.flatMap((segment) => segment.emojiId ? [segment.emojiId] : []))].sort(),
    [segments],
  );

  const resolvedEmojiQuery = useQuery({
    queryKey: ["resolvedCustomEmojis", emojiIds.join(",")],
    queryFn: () => api.post<ResolveCustomEmojisResponse>("/api/emojis/resolve", { ids: emojiIds }),
    enabled: emojiIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const emojiMap = useMemo(
    () => new Map((resolvedEmojiQuery.data?.emojis ?? []).map((emoji) => [emoji.id, emoji])),
    [resolvedEmojiQuery.data],
  );

  return segments.map((segment) => ({ ...segment, src: segment.emojiId && emojiMap.get(segment.emojiId) ? resolveApiUrl(emojiMap.get(segment.emojiId)!.downloadUrl) : null }));
}
