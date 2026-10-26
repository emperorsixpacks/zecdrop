// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";

import { Confetti } from "./Confetti";

function system(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduced && query.includes("reduce"), media: query })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset["motion"];
});

describe("Confetti", () => {
  it("is a burst of pieces, as decoration, when Lively", () => {
    system(false);
    document.documentElement.dataset["motion"] = "lively";
    const { container } = render(<Confetti />);
    const burst = container.querySelector("[data-testid='confetti']");
    expect(burst).toHaveAttribute("aria-hidden", "true");
    expect(burst?.querySelectorAll("i").length).toBeGreaterThan(10);
  });

  it("is not drawn when Calm", () => {
    system(false);
    document.documentElement.dataset["motion"] = "calm";
    expect(render(<Confetti />).container.firstChild).toBeNull();
  });

  it("is not drawn when the system asks for reduced motion, whatever was chosen", () => {
    system(true);
    document.documentElement.dataset["motion"] = "lively";
    expect(render(<Confetti />).container.firstChild).toBeNull();
  });
});
