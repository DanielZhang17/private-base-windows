import { useEffect, useRef, useSyncExternalStore } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../ui/Icon.js";
import type { Sticker } from "../../features/stickers/catalog.js";
import { idleSprite, packSprite, type StickerSize } from "../../features/stickers/pack-assets.js";

const unusedSprite = {
  subscribe: () => () => undefined,
  snapshot: () => idleSprite,
  start: () => undefined,
  retry: () => undefined,
};

export function useStickerImage(sticker: Sticker | undefined, size: StickerSize) {
  const sprite = sticker ? packSprite(sticker, size) : unusedSprite;
  const { state, url } = useSyncExternalStore(sprite.subscribe, sprite.snapshot);
  return { state: state === "idle" ? "loading" as const : state, url, start: sprite.start, retry: sprite.retry };
}

const visibleImages = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;

function loadWhenVisible(element: Element, load: () => void) {
  if (typeof IntersectionObserver === "undefined") { load(); return; }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer?.unobserve(entry.target);
      const loadImage = visibleImages.get(entry.target);
      visibleImages.delete(entry.target);
      loadImage?.();
    }
  });
  visibleImages.set(element, load);
  observer.observe(element);
  return () => { observer?.unobserve(element); visibleImages.delete(element); };
}

export function StickerImage({ sticker, alt = "", image }: {
  sticker: Sticker; alt?: string; image: ReturnType<typeof useStickerImage>;
}) {
  const artRef = useRef<HTMLSpanElement>(null);
  const { start, url } = image;
  useEffect(() => {
    if (artRef.current) return loadWhenVisible(artRef.current, start);
  }, [start]);

  const slot = sticker.n - 1;
  const position = `${(slot % 4) * 100 / 3}% ${Math.floor(slot / 4) * 100 / 3}%`;
  return <span ref={artRef} className={`sticker-art ${url ? "" : "invisible"}`}
    role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={!alt || undefined}
    style={url ? { backgroundImage: `url("${url}")`, backgroundPosition: position } : undefined} />;
}

export function StickerArt({ sticker, size, alt, className, retryable }: {
  sticker: Sticker; size: StickerSize; alt?: string; className?: string; retryable?: boolean;
}) {
  const image = useStickerImage(sticker, size);
  return <span className={`sticker-art-box ${className ?? ""} ${image.state === "ready" ? "" : "bg-sunken rounded-control"} ${image.state === "loading" ? "animate-ui-pulse" : ""}`}>
    {image.state !== "failed" ? <StickerImage sticker={sticker} alt={alt} image={image} />
      : retryable ? <button type="button" className="tap-target grid place-items-center rounded-control p-2 text-sm text-ink-muted"
        aria-label={t("stickerImageFailed", { name: alt ?? t("stickerPreview") })}
        onClick={() => void image.retry()}><Icon name="retry" size={20} />{t("retry")}</button>
      : <Icon name="image" size={24} className="text-ink-muted" />}
  </span>;
}
