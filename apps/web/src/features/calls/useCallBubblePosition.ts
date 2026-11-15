import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { clampBubble, snapBubble, getBubbleArea, type AvoidZone, type Rectangle, type Point } from "./bubble-position.js";

export function useCallBubblePosition() {
  const boundsRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<Rectangle | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const [areaStyle, setAreaStyle] = useState<CSSProperties>();
  const [position, setPosition] = useState<Point | null>(null);
  const [snapping, setSnapping] = useState(false);
  const drag = useRef<{ id: number; origin: Point; start: Point; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const edge = useRef<"left" | "right">("right");
  const measure = () => {
    const bounds = boundsRef.current!.getBoundingClientRect();
    const bubble = bubbleRef.current!.getBoundingClientRect();
    return {
      bubble: { width: bubble.width, height: bubble.height },
      viewport: areaRef.current ? { width: areaRef.current.right - areaRef.current.left, height: areaRef.current.bottom - areaRef.current.top } : { width: bounds.width, height: bounds.height },
    };
  };
  useLayoutEffect(() => {
    const resize = () => {
      // Mobile keyboards and pinch zoom resize/pan the visual viewport independently
      // of the layout viewport used by fixed positioning.
      const visual = window.visualViewport;
      const bounds = boundsRef.current!;
      bounds.style.setProperty("--call-viewport-top", `${visual?.offsetTop ?? 0}px`);
      bounds.style.setProperty("--call-viewport-left", `${visual?.offsetLeft ?? 0}px`);
      bounds.style.setProperty("--call-viewport-right", `${visual ? Math.max(0, window.innerWidth - visual.width - visual.offsetLeft) : 0}px`);
      bounds.style.setProperty("--call-viewport-bottom", `${visual ? Math.max(0, window.innerHeight - visual.height - visual.offsetTop) : 0}px`);
      const base = bounds.getBoundingClientRect();
      const visible = (rect: DOMRect) => rect.width > 0 && rect.height > 0 &&
        rect.right > base.left && rect.left < base.right && rect.bottom > base.top && rect.top < base.bottom;
      const messages = Array.from(document.querySelectorAll<HTMLElement>("[data-call-message-area]"))
        .map((element) => element.getBoundingClientRect()).find(visible);
      const zones = Array.from(document.querySelectorAll<HTMLElement>("[data-call-avoid]"))
        .map((element) => ({ ...toRectangle(element.getBoundingClientRect()), edge: element.dataset.callAvoid as AvoidZone["edge"] }));
      const allowed = getBubbleArea(toRectangle(base), zones, messages);
      const area = { left: allowed.left - base.left, top: allowed.top - base.top, right: allowed.right - base.left, bottom: allowed.bottom - base.top };
      const bubble = bubbleRef.current!.getBoundingClientRect();
      const previous = areaRef.current;
      if (previous && previous.left === area.left && previous.top === area.top && previous.right === area.right && previous.bottom === area.bottom &&
          sizeRef.current.width === bubble.width && sizeRef.current.height === bubble.height) return;
      areaRef.current = area;
      sizeRef.current = { width: bubble.width, height: bubble.height };
      if (drag.current) suppressClick.current = true;
      drag.current = null;
      setSnapping(false);
      const viewport = { width: area.right - area.left, height: area.bottom - area.top };
      setAreaStyle({ left: area.left, top: area.top, width: viewport.width, height: viewport.height });
      setPosition((current) => clampBubble({
        x: edge.current === "right" ? viewport.width : 0,
        y: current?.y ?? (window.innerWidth < 640 ? viewport.height : 0),
      }, bubble, viewport));
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    const observed = new Set<Element>();
    const refresh = () => {
      const elements = new Set<Element>([boundsRef.current!, bubbleRef.current!,
        ...document.querySelectorAll("[data-call-avoid], [data-call-message-area]")]);
      for (const element of observed) if (!elements.has(element)) { observer?.unobserve(element); observed.delete(element); }
      for (const element of elements) if (!observed.has(element)) { observer?.observe(element); observed.add(element); }
      resize();
    };
    refresh();
    // Routes and conditional composers can mount while the bubble stays alive.
    const mutations = new MutationObserver(refresh);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, []);
  const finish = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    suppressClick.current = current.moved || cancelled;
    const { bubble, viewport } = measure();
    setPosition((value) => {
      const snapped = snapBubble(value ?? current.origin, bubble, viewport);
      edge.current = snapped.x === 0 ? "left" : "right";
      return snapped;
    });
    drag.current = null;
    setSnapping(true);
  };
  return {
    boundsRef, bubbleRef, areaStyle, position, snapping,
    dragProps: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (!event.isPrimary || event.button !== 0) return;
        suppressClick.current = false;
        setSnapping(false);
        drag.current = { id: event.pointerId, origin: position ?? { x: 0, y: 0 }, start: { x: event.clientX, y: event.clientY }, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const dx = event.clientX - current.start.x;
        const dy = event.clientY - current.start.y;
        if (!current.moved && Math.hypot(dx, dy) < 6) return;
        current.moved = true;
        setSnapping(false);
        const { bubble, viewport } = measure();
        setPosition(clampBubble({ x: current.origin.x + dx, y: current.origin.y + dy }, bubble, viewport));
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => finish(event),
      onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
    },
    shouldExpand: (detail: number) => detail === 0 || !suppressClick.current,
  };
}

function toRectangle(rect: DOMRect): Rectangle {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}
