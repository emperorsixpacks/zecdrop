// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyTheme,
  currentTheme,
  readStoredTheme,
  resolveInitialTheme,
  storeTheme,
  THEME_STORAGE_KEY,
} from "./theme";

function stubMatchMedia(lightPreferred: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: lightPreferred && query.includes("light"),
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
  it("defaults to dark when nothing is stored and the OS has no preference", () => {
    stubMatchMedia(false);
    expect(resolveInitialTheme()).toBe("dark");
  });

  it("follows an OS light preference when nothing is stored", () => {
    stubMatchMedia(true);
    expect(resolveInitialTheme()).toBe("light");
  });

  it("a stored choice beats the OS preference", () => {
    stubMatchMedia(true);
    storeTheme("dark");
    expect(resolveInitialTheme()).toBe("dark");
  });

  it("works when matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveInitialTheme()).toBe("dark");
  });

  it("ignores garbage in storage", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(readStoredTheme()).toBeNull();
  });

  it("applyTheme sets data-theme and currentTheme reads it back", () => {
    expect(currentTheme()).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(currentTheme()).toBe("light");
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
      storeTheme("light");
    }).not.toThrow();
  });
});
