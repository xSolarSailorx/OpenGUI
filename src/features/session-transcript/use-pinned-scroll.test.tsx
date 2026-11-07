// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { usePinnedScroll } from "./use-pinned-scroll";

const resize = { callback: null as ResizeObserverCallback | null, disconnected: vi.fn() };

function Harness({ sessionId, contentKey }: { sessionId: string; contentKey: string }) {
  const scroll = usePinnedScroll({ sessionId, contentKey, pinWhenNearBottom: true });
  return (
    <div ref={scroll.scrollRef} onScroll={scroll.onScroll} data-testid="viewport">
      <button onClick={scroll.detachPin}>detach</button>
      <output>{String(scroll.isPinned())}</output>
    </div>
  );
}

describe("usePinnedScroll", () => {
  beforeEach(() => {
    resize.disconnected.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize.callback = callback;
        }
        observe() {}
        disconnect() {
          resize.disconnected();
        }
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("tracks user pin intent, follows growth, resets per Session, and disconnects resize observation", () => {
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 595 };
    const view = render(<Harness sessionId="one" contentKey="1" />);
    const viewport = screen.getByTestId("viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
      clientHeight: { configurable: true, get: () => geometry.clientHeight },
      scrollTop: {
        configurable: true,
        get: () => geometry.scrollTop,
        set: (value) => {
          geometry.scrollTop = value;
        },
      },
    });
    fireEvent.scroll(viewport);
    geometry.scrollHeight = 1100;
    view.rerender(<Harness sessionId="one" contentKey="2" />);
    expect(geometry.scrollTop).toBe(700);

    fireEvent.click(screen.getByText("detach"));
    geometry.scrollHeight = 1200;
    resize.callback?.([], {} as ResizeObserver);
    expect(geometry.scrollTop).toBe(700);

    view.rerender(<Harness sessionId="two" contentKey="1" />);
    resize.callback?.([], {} as ResizeObserver);
    expect(geometry.scrollTop).toBe(800);
    view.unmount();
    expect(resize.disconnected).toHaveBeenCalled();
  });

  test("re-pins across frames until scrollHeight stabilises (content-visibility settling)", () => {
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 };
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });

    const view = render(<Harness sessionId="one" contentKey="1" />);
    const viewport = screen.getByTestId("viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
      clientHeight: { configurable: true, get: () => geometry.clientHeight },
      scrollTop: {
        configurable: true,
        get: () => geometry.scrollTop,
        set: (value) => {
          geometry.scrollTop = value;
        },
      },
    });
    const flushFrames = () => {
      const pending = rafQueue.splice(0);
      for (const callback of pending) callback(0);
    };

    // A session switch pins synchronously using the initial (placeholder) height.
    view.rerender(<Harness sessionId="two" contentKey="1" />);
    expect(geometry.scrollTop).toBe(600);

    // Content-visibility rows realise their true height across several frames.
    geometry.scrollHeight = 1400;
    flushFrames();
    expect(geometry.scrollTop).toBe(1000);

    geometry.scrollHeight = 1800;
    flushFrames();
    expect(geometry.scrollTop).toBe(1400);

    // Height stops changing; the settle loop finishes after two stable frames.
    flushFrames();
    expect(geometry.scrollTop).toBe(1400);
    flushFrames();
    expect(geometry.scrollTop).toBe(1400);
    view.unmount();
  });
});
