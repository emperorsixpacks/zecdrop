// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMotion, currentMotion, isLively, MOTION_STORAGE_KEY, motionScale, prefersReducedMotion, readStoredMotion, resolveInitialMotion, storeMotion } from "./motion";

function system(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduced && query.includes("reduce"), media: query })),
  );
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["motion"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("motion", () => {
  it("is Lively unless chosen otherwise", () => {
    system(false);
    expect(resolveInitialMotion()).toBe("lively");
    storeMotion("calm");
    expect(resolveInitialMotion()).toBe("calm");
    expect(readStoredMotion()).toBe("calm");
  });

  it("is Calm, whatever was chosen, when the system asks for reduced motion", () => {
    system(true);
    storeMotion("lively");
    expect(prefersReducedMotion()).toBe(true);
    expect(resolveInitialMotion()).toBe("calm");
    expect(motionScale()).toBe(0);
    expect(isLively()).toBe(false);
  });

  it("is treated as reduced where it cannot be told (no matchMedia)", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(true);
    expect(resolveInitialMotion()).toBe("calm");
  });

  it("scales a JS animation: full when Lively, a third when Calm, none when reduced", () => {
    system(false);
    applyMotion("lively");
    expect(motionScale()).toBe(1);
    expect(isLively()).toBe(true);
    applyMotion("calm");
    expect(motionScale()).toBe(0.3);
    expect(isLively()).toBe(false);
    system(true);
    expect(motionScale()).toBe(0);
  });

  it("is put on <html> and read back, and garbage in storage is ignored", () => {
    applyMotion("lively");
    expect(document.documentElement.dataset["motion"]).toBe("lively");
    expect(currentMotion()).toBe("lively");
    localStorage.setItem(MOTION_STORAGE_KEY, "frantic");
    expect(readStoredMotion()).toBeNull();
  });
});
