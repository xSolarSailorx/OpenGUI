import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { NEAR_BOTTOM_PX } from "@/lib/constants";

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

export function isNearBottom(element: HTMLElement): boolean {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScrollTop <= NEAR_BOTTOM_PX) return true;
  return distanceFromBottom(element) <= NEAR_BOTTOM_PX;
}

function pinToBottom(element: HTMLElement): void {
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (element.scrollTop !== maxTop) element.scrollTop = maxTop;
}

/**
 * Bounded number of frames to let `content-visibility: auto` rows settle their
 * real height after jumping to the bottom. Off-screen rows are initially sized
 * by an intrinsic-size placeholder, so the true `scrollHeight` only emerges
 * across several layout passes once the bottom rows force a re-render.
 */
const SETTLE_MAX_FRAMES = 12;
/** Consecutive frames with an unchanged `scrollHeight` before we consider the settle done. */
const SETTLE_STABLE_FRAMES = 2;

export function usePinnedScroll(input: {
  sessionId: string | null;
  /** Changes when transcript content length/revision changes (e.g. message count + busy). */
  contentKey: string;
  pinWhenNearBottom: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const programmaticRef = useRef(false);
  const wasPinningRef = useRef(input.pinWhenNearBottom);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const settleGenerationRef = useRef(0);

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || programmaticRef.current) return;
    pinnedRef.current = isNearBottom(el);
  }, []);

  const detachPin = useCallback(() => {
    pinnedRef.current = false;
  }, []);

  const capturePrependAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    prependAnchorRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    markProgrammatic();
    pinToBottom(el);
    // Rows use `content-visibility: auto`, so their real height only settles once
    // the bottom rows force a layout pass that expands the intrinsic-size
    // placeholders above them. Pin across a bounded number of frames, stopping as
    // soon as `scrollHeight` is stable, so we land at the true bottom.
    const generation = ++settleGenerationRef.current;
    let frames = 0;
    let stableFrames = 0;
    let previousHeight = el.scrollHeight;
    const settle = () => {
      if (generation !== settleGenerationRef.current) return;
      const current = scrollRef.current;
      if (!current || !pinnedRef.current) return;
      markProgrammatic();
      pinToBottom(current);
      frames += 1;
      if (current.scrollHeight === previousHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        previousHeight = current.scrollHeight;
      }
      if (stableFrames < SETTLE_STABLE_FRAMES && frames < SETTLE_MAX_FRAMES) {
        requestAnimationFrame(settle);
      }
    };
    requestAnimationFrame(settle);
  }, [markProgrammatic]);

  useLayoutEffect(() => {
    pinnedRef.current = true;
    prependAnchorRef.current = null;
    // Opening a chat (or switching sessions) should land at the true bottom. Rows
    // use content-visibility, so their real height settles after the first paint;
    // scrollToBottom re-pins on the following frame to absorb that growth.
    scrollToBottom();
  }, [input.sessionId, scrollToBottom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    if (!el || !anchor) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta > 0) {
      markProgrammatic();
      el.scrollTop = anchor.scrollTop + delta;
    }
    prependAnchorRef.current = null;
  });

  useEffect(() => {
    const el = scrollRef.current;
    const shouldPin = input.pinWhenNearBottom || wasPinningRef.current;
    wasPinningRef.current = input.pinWhenNearBottom;
    if (!el || !shouldPin || !pinnedRef.current) return;
    markProgrammatic();
    pinToBottom(el);
  }, [input.contentKey, input.pinWhenNearBottom, markProgrammatic]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!input.pinWhenNearBottom || !pinnedRef.current) return;
      markProgrammatic();
      pinToBottom(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [input.pinWhenNearBottom, input.sessionId, markProgrammatic]);

  return {
    scrollRef,
    onScroll,
    detachPin,
    capturePrependAnchor,
    scrollToBottom,
    isPinned: () => pinnedRef.current,
  };
}
