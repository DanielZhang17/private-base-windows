import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { keyboardHeight, panelHeight, withinTap } from "./picker-model.js";

const storageKey = (landscape: boolean) => `private-base:keyboard-height:${landscape ? "landscape" : "portrait"}`;

function readHeight(landscape: boolean): number | undefined {
  try { return Number(localStorage.getItem(storageKey(landscape))) || undefined; }
  catch { return undefined; }
}

function landscapeOrientation(height = window.innerHeight) {
  const type = window.screen.orientation?.type;
  if (window.matchMedia?.("(pointer: coarse)").matches && type) return type.startsWith("landscape");
  return height < window.innerWidth;
}

export function useComposerPanel(phone: boolean, open: boolean, input: RefObject<HTMLTextAreaElement | null>, dismiss: () => void) {
  const baseline = useRef(window.innerHeight);
  const lastWidth = useRef(window.innerWidth);
  const lastOrientation = useRef(landscapeOrientation());
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const returning = useRef(false);
  const [geometry, setGeometry] = useState(() => ({ height: panelHeight(window.innerHeight, landscapeOrientation(), readHeight(landscapeOrientation())), occupied: 0, overlay: 0 }));
  const close = useRef(dismiss);
  close.current = dismiss;

  const finish = () => {
    clearTimeout(timeout.current);
    returning.current = false;
    close.current();
  };

  const measure = () => {
    if (!phone) return;
    const inner = window.innerHeight;
    const width = window.innerWidth;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    // A window resize with a fine pointer can also fire while the composer has focus.
    // Only touch layouts can infer a keyboard from a height-only layout resize.
    if (!coarse || width !== lastWidth.current) baseline.current = inner;
    lastWidth.current = width;
    const landscape = landscapeOrientation(baseline.current);
    const visual = window.visualViewport;
    const focused = document.activeElement === input.current;
    if (lastOrientation.current !== landscape) {
      lastOrientation.current = landscape;
      baseline.current = inner;
    }
    if ((!focused && !open) || inner > baseline.current) baseline.current = inner;
    const overlay = Math.max(0, inner - (visual?.height ?? inner) - (visual?.offsetTop ?? 0));
    const occupied = keyboardHeight(baseline.current, inner, visual?.height, visual?.offsetTop);
    const keyboard = visual && visual.scale > 1 ? 0 : occupied;
    if (focused && keyboard > 120) {
      try { localStorage.setItem(storageKey(landscape), String(Math.round(keyboard))); } catch { /* Device preference is optional. */ }
    }
    const height = panelHeight(baseline.current, landscape, readHeight(landscape));
    const next = { height, occupied: keyboard, overlay: keyboard > 0 ? overlay : 0 };
    setGeometry((previous) => previous.height === next.height && previous.occupied === next.occupied && previous.overlay === next.overlay ? previous : next);
    if (returning.current && keyboard >= height * .8) finish();
  };

  useLayoutEffect(() => {
    if (!phone) return;
    const visual = window.visualViewport;
    measure();
    const rotate = () => {
      baseline.current = window.innerHeight;
      measure();
    };
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", rotate);
    visual?.addEventListener("resize", measure);
    visual?.addEventListener("scroll", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", rotate);
      visual?.removeEventListener("resize", measure);
      visual?.removeEventListener("scroll", measure);
    };
  }, [phone, open]);

  useEffect(() => {
    if (phone && open) return;
    clearTimeout(timeout.current);
    returning.current = false;
    return () => clearTimeout(timeout.current);
  }, [phone, open]);
  useEffect(() => () => clearTimeout(timeout.current), []);

  return {
    ...geometry,
    measure,
    blurForPanel() {
      measure();
      input.current?.blur();
    },
    showKeyboard() {
      if (!returning.current) {
        returning.current = true;
        timeout.current = setTimeout(finish, 400);
      }
      input.current?.focus({ preventScroll: true });
      measure();
    },
  };
}

/** Follow the bottom edge through a composer/keyboard resize when already pinned. */
export function useComposerScrollAnchor(list?: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const log = list?.current;
    if (!log || typeof ResizeObserver === "undefined") return;
    let pinned = log.scrollHeight - log.clientHeight - log.scrollTop < 2;
    const onScroll = () => { pinned = log.scrollHeight - log.clientHeight - log.scrollTop < 2; };
    const observer = new ResizeObserver(() => {
      if (pinned) log.scrollTop = log.scrollHeight;
    });
    observer.observe(log);
    log.addEventListener("scroll", onScroll, { passive: true });
    return () => { observer.disconnect(); log.removeEventListener("scroll", onScroll); };
  }, [list]);
}

export function usePickerDismissal({
  open, phone, isTop, picker, trigger, list, dismiss,
}: {
  open: boolean; phone: boolean; isTop: () => boolean;
  picker: RefObject<HTMLElement | null>; trigger: RefObject<HTMLElement | null>;
  list?: RefObject<HTMLDivElement | null>; dismiss: (restore?: boolean) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const log = list?.current;
    let press: { id: number; x: number; y: number } | undefined;
    const logSurface = (target: EventTarget | null) => target instanceof Element && log?.contains(target)
      && !target.closest("button, a, input, textarea, select, [role=button]");
    const down = (event: PointerEvent) => {
      press = undefined;
      if (!isTop() || event.button !== 0) return;
      const target = event.target as Node;
      if (!phone && !picker.current?.contains(target) && !trigger.current?.contains(target)) dismiss();
      if (phone && logSurface(target)) press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const move = (event: PointerEvent) => {
      if (press?.id === event.pointerId && !withinTap(press, event.clientX, event.clientY)) press = undefined;
    };
    const cancel = () => { press = undefined; };
    const up = (event: PointerEvent) => {
      if (press?.id === event.pointerId && isTop() && logSurface(document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target)
        && withinTap(press, event.clientX, event.clientY)) dismiss();
      cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !isTop()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss(true);
    };
    const listeners = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", cancel], ["keydown", key]] as const;
    for (const [type, listener] of listeners) document.addEventListener(type, listener as EventListener, true);
    log?.addEventListener("scroll", cancel);
    return () => {
      for (const [type, listener] of listeners) document.removeEventListener(type, listener as EventListener, true);
      log?.removeEventListener("scroll", cancel);
    };
  }, [open, phone, isTop, list, dismiss, picker, trigger]);
}
