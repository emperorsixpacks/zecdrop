// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme, currentTheme, readStoredTheme, resolveInitialTheme, storeTheme, THEME_STORAGE_KEY } from "./theme";

function stubMatchMedia(darkPreferred: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: darkPreferred && query.includes("dark"),
      media: query,
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("is light, the look, when nothing is stored and the system does not say dark", () => {
    stubMatchMedia(false);
    expect(resolveInitialTheme()).toBe("light");
  });

  it("is dark when the system says dark and nothing is stored", () => {
    stubMatchMedia(true);
    expect(resolveInitialTheme()).toBe("dark");
  });

  it("a stored choice beats the system setting", () => {
    stubMatchMedia(false);
    storeTheme("dark");
    expect(resolveInitialTheme()).toBe("dark");
    storeTheme("light");
    stubMatchMedia(true);
    expect(resolveInitialTheme()).toBe("light");
  });

  it("works when matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveInitialTheme()).toBe("light");
  });

  it("ignores garbage in storage", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(readStoredTheme()).toBeNull();
  });

  it("applyTheme sets data-theme and currentTheme reads it back; with none set it is light", () => {
    expect(currentTheme()).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredTheme()).toBeNull();
    expect(() => {
      storeTheme("dark");
    }).not.toThrow();
  });
});
