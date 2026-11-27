import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToastStore } from "./toastStore";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("toast queue", () => {
  it("shows three at a time and gives each normal toast five seconds on screen", () => {
    const store = createToastStore();
    const { show } = store.getState();
    const visible = () => store.getState().visible.map(({ message }) => message);

    const first = () => "First";
    const second = () => "Second";
    const third = () => "Third";
    const fourth = () => "Fourth";
    show(first);
    show(second, "error");
    show(third, "error");
    show(fourth);

    vi.advanceTimersByTime(4_999);
    expect(visible()).toEqual([first, second, third]);
    vi.advanceTimersByTime(1);
    expect(visible()).toEqual([second, third, fourth]);
    vi.advanceTimersByTime(4_999);
    expect(visible()).toEqual([second, third, fourth]);
    vi.advanceTimersByTime(1);
    expect(visible()).toEqual([second, third]);
  });

  it("keeps errors until dismissed and reveals the next queued error", () => {
    const store = createToastStore();
    const { show, dismiss } = store.getState();
    const first = show(() => "First", "error");
    const second = show(() => "Second", "error");
    const third = show(() => "Third", "error");
    const fourth = show(() => "Fourth", "error");
    const ids = () => store.getState().visible.map(({ id }) => id);

    vi.advanceTimersByTime(60_000);
    expect(ids()).toEqual([first, second, third]);
    dismiss(second);
    expect(ids()).toEqual([first, third, fourth]);
    vi.advanceTimersByTime(60_000);
    expect(ids()).toEqual([first, third, fourth]);
  });
});
