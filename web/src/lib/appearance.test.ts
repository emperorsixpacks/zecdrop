// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initAppearance, useAppearance } from "./appearance";
import { MOTION_STORAGE_KEY } from "./motion";
import { THEME_STORAGE_KEY } from "./theme";

function system(opts: { dark?: boolean; reduced?: boolean }) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: (opts.dark === true && query.includes("dark")) || (opts.reduced === true && query.includes("reduce")),
      media: query,
    })),
  );
}

const html = () => document.documentElement.dataset;

beforeEach(() => {
  localStorage.clear();
  for (const key of ["theme", "motion"]) delete html()[key];
  system({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the appearance, as it starts", () => {
  it("is light and Lively when nothing has been chosen", () => {
    initAppearance();
    expect(html()).toMatchObject({ theme: "light", motion: "lively" });
    expect(useAppearance.getState()).toMatchObject({ theme: "light", motion: "lively" });
  });

  it("is dark when the system says dark", () => {
    system({ dark: true });
    initAppearance();
    expect(html()["theme"]).toBe("dark");
  });

  it("comes back as it was left", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    localStorage.setItem(MOTION_STORAGE_KEY, "calm");
    initAppearance();
    expect(html()).toMatchObject({ theme: "dark", motion: "calm" });
  });

  it("is Calm under the system's reduced motion, and cannot be made Lively", () => {
    system({ reduced: true });
    localStorage.setItem(MOTION_STORAGE_KEY, "lively");
    initAppearance();
    expect(html()["motion"]).toBe("calm");
    useAppearance.getState().setMotion("lively");
    expect(html()["motion"]).toBe("calm");
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("lively"); // untouched
  });
});

describe("changing it", () => {
  beforeEach(() => {
    initAppearance();
  });

  it("a theme takes effect at once and is remembered", () => {
    useAppearance.getState().setTheme("dark");
    expect(html()["theme"]).toBe("dark");
    expect(useAppearance.getState().theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("motion takes effect at once and is remembered", () => {
    useAppearance.getState().setMotion("calm");
    expect(html()["motion"]).toBe("calm");
    expect(useAppearance.getState().motion).toBe("calm");
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("calm");
  });

  it("stores nothing but these two words", () => {
    useAppearance.getState().setTheme("light");
    useAppearance.getState().setMotion("calm");
    expect(Object.keys({ ...localStorage }).sort()).toEqual([MOTION_STORAGE_KEY, THEME_STORAGE_KEY].sort());
  });
});
