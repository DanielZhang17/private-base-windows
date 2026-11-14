import { t, useLocale } from "../i18n/index.js";
import { useEffect, useState } from "react";
import { cx } from "./cx.js";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZES: Record<AvatarSize, string> = {
  xs: "size-7 text-[0.6875rem]",
  sm: "size-9 text-[0.8125rem]",
  md: "size-11 text-[0.9375rem]",
  lg: "size-16 text-[1.375rem]",
  xl: "size-24 text-[2rem]",
};

export interface AvatarProps {
  /** Resolved image URL. Resolving app-specific schemes is the caller's job. */
  src?: string | null;
  /** Display name: gives the initials fallback and the accessible name. */
  name: string;
  size?: AvatarSize;
  /** "rounded" marks a group; people are circles. */
  shape?: "circle" | "rounded";
  /** Presence dot. Omit when presence is unknown. */
  presence?: "online" | "offline";
  className?: string;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const second = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";
  return (first + second).toUpperCase();
}

export function Avatar({ src, name, size = "md", shape = "circle", presence, className }: AvatarProps) {
  useLocale();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const showImage = Boolean(src) && !failed;
  const radius = shape === "circle" ? "rounded-full" : "rounded-[30%]";

  return (
    <span
      role="img"
      aria-label={presence ? t("avatarWithPresence", { name, presence: presence === "online" ? t("presenceOnline") : t("presenceOffline") }) : name}
      className={cx("relative inline-flex shrink-0 select-none", SIZES[size], className)}
    >
      {showImage ? (
        <img
          src={src!}
          alt=""
          loading="lazy"
          draggable={false}
          className={cx("size-full object-cover", radius)}
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true" className={cx("flex size-full items-center justify-center bg-brand-soft font-semibold text-on-brand-soft", radius)}>
          {initials(name)}
        </span>
      )}
      {presence && (
        <span
          aria-hidden="true"
          className={cx(
            "absolute end-0 bottom-0 size-[28%] min-w-2.5 min-h-2.5 rounded-full border-2 border-surface",
            presence === "online" ? "bg-ok" : "bg-line-strong",
          )}
        />
      )}
    </span>
  );
}
