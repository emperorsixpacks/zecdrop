// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";

import { CountInt, CountUp } from "./CountUp";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const motion = (reduce: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  document.documentElement.dataset["motion"] = "lively";
};

describe("CountUp", () => {
  it("shows the value at once when motion is reduced", () => {
    motion(true);
    render(<CountUp zatoshi={1_162_500_000n} />);
    expect(document.body.textContent).toBe("11.625");
  });

  it("shows the value at once where it cannot tell (no matchMedia)", () => {
    render(<CountUp zatoshi={500_000n} />);
    expect(document.body.textContent).toBe("0.005");
  });

  it("counts up once from zero, with the same number of decimals all the way", () => {
    motion(false);
    vi.useFakeTimers();
    const { container } = render(<CountUp zatoshi={1_162_500_000n} />);
    expect(container.textContent).toBe("0.000");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const midway = container.textContent ?? "";
    expect(midway).toMatch(/^\d+\.\d{3}$/u);
    expect(Number(midway)).toBeGreaterThan(0);
    expect(Number(midway)).toBeLessThan(11.625);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe("11.625");
  });

  it("counts from the old value to the new one when the value changes", () => {
    motion(false);
    vi.useFakeTimers();
    const { container, rerender } = render(<CountUp zatoshi={150_000_000n} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe("1.5");
    rerender(<CountUp zatoshi={250_000_000n} />);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const midway = Number(container.textContent);
    expect(midway).toBeGreaterThan(1.5);
    expect(midway).toBeLessThan(2.5);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe("2.5");
  });

  it("is quicker when Calm", () => {
    motion(false);
    document.documentElement.dataset["motion"] = "calm";
    vi.useFakeTimers();
    const { container } = render(<CountUp zatoshi={150_000_000n} />);
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(container.textContent).toBe("1.5");
  });

  it("keeps room for the finished number, so what is beside it does not move", () => {
    motion(true);
    const { container } = render(<CountUp zatoshi={1_162_500_000n} />);
    expect((container.firstChild as HTMLElement).style.minWidth).toBe("5.3ch");
  });

  it("a whole number has no decimal point to shift", () => {
    motion(true);
    render(<CountUp zatoshi={300_000_000n} />);
    expect(screen.queryByText(".")).toBeNull();
  });
});

describe("a frame that arrives before the count started", () => {
  it("never runs the number backwards (it once went negative and blanked the page)", () => {
    motion(false);
    vi.useFakeTimers();
    // A browser may hand the first frame a timestamp a little before the moment the count began.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now() - 80), 16) as unknown as number);
    const { container } = render(<CountUp zatoshi={1_162_500_000n} />);
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(container.textContent).toMatch(/^\d+\.\d{3}$/u);
    expect(Number(container.textContent)).toBeGreaterThanOrEqual(0);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.textContent).toBe("11.625");
  });
});

describe("CountInt", () => {
  it("counts a whole number up, and shows it at once when motion is reduced", () => {
    motion(true);
    const { container } = render(<CountInt value={8} />);
    expect(container.textContent).toBe("8");
  });

  it("runs from zero when Lively", () => {
    motion(false);
    vi.useFakeTimers();
    const { container } = render(<CountInt value={8} />);
    expect(container.textContent).toBe("0");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe("8");
  });
});
