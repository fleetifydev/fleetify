import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHoverIntent } from "../use-hover-intent";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useHoverIntent", () => {
  it("opens only after openDelay", () => {
    const { result } = renderHook(() => useHoverIntent({ openDelay: 400, closeDelay: 200 }));
    act(() => result.current.anchorProps.onMouseEnter());
    act(() => vi.advanceTimersByTime(399));
    expect(result.current.open).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(true);
  });

  it("cancels the open when the cursor leaves before openDelay", () => {
    const { result } = renderHook(() => useHoverIntent({ openDelay: 400, closeDelay: 200 }));
    act(() => result.current.anchorProps.onMouseEnter());
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.anchorProps.onMouseLeave());
    act(() => vi.advanceTimersByTime(400));
    expect(result.current.open).toBe(false);
  });

  it("stays open when the cursor moves into the popup", () => {
    const { result } = renderHook(() => useHoverIntent({ openDelay: 400, closeDelay: 200 }));
    act(() => result.current.anchorProps.onMouseEnter());
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.anchorProps.onMouseLeave()); // schedule close
    act(() => result.current.popupProps.onMouseEnter());  // cancel close
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.open).toBe(true);
  });

  it("closes after leaving both for closeDelay", () => {
    const { result } = renderHook(() => useHoverIntent({ openDelay: 400, closeDelay: 200 }));
    act(() => result.current.anchorProps.onMouseEnter());
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.popupProps.onMouseLeave());
    act(() => vi.advanceTimersByTime(199));
    expect(result.current.open).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(false);
  });

  it("close() forces shut immediately", () => {
    const { result } = renderHook(() => useHoverIntent({ openDelay: 400, closeDelay: 200 }));
    act(() => result.current.anchorProps.onMouseEnter());
    act(() => vi.advanceTimersByTime(400));
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });
});
