// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoReceipt } from "@/api/demo";
import "@/test/dom";

import { FundsFlow } from "./FundsFlow";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the flow of funds", () => {
  it("is drawn at once where nothing can be watched (no IntersectionObserver), and says the same thing", () => {
    const { container } = render(<FundsFlow receipt={demoReceipt("real")} />);
    expect(container.firstChild).toHaveAttribute("data-in", "true");
    expect(screen.getByRole("list", { name: "Where the funds went" })).toHaveTextContent("8 outputs");
  });

  it("waits until it scrolls into view to draw itself, then stays drawn", () => {
    let notify: IntersectionObserverCallback = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })),
    );
    const { container } = render(<FundsFlow receipt={demoReceipt("real")} />);
    expect(container.firstChild).toHaveAttribute("data-in", "false");
    act(() => {
      notify([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(container.firstChild).toHaveAttribute("data-in", "true");
    expect(disconnect).toHaveBeenCalled();
  });

  it("its pictures are decoration", () => {
    const { container } = render(<FundsFlow receipt={demoReceipt("real")} />);
    for (const picture of container.querySelectorAll(".flow-dot, .flow-line")) expect(picture).toHaveAttribute("aria-hidden", "true");
  });
});
