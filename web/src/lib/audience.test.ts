// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIENCE_STORAGE_KEY, DEFAULT_AUDIENCE, readStoredAudience, useAudience } from "./audience";

beforeEach(() => {
  localStorage.clear();
  useAudience.setState({ audience: DEFAULT_AUDIENCE });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the audience", () => {
  it("is personal for a visitor who never chose, and writes nothing until they do", () => {
    expect(DEFAULT_AUDIENCE).toBe("personal");
    expect(useAudience.getState().audience).toBe("personal");
    expect(localStorage.length).toBe(0);
  });

  it("is remembered on this browser once chosen", () => {
    useAudience.getState().setAudience("organisation");
    expect(useAudience.getState().audience).toBe("organisation");
    expect(localStorage.getItem(AUDIENCE_STORAGE_KEY)).toBe("organisation");
    expect(readStoredAudience()).toBe("organisation");
  });

  it("ignores a stored value it does not know", () => {
    localStorage.setItem(AUDIENCE_STORAGE_KEY, "everyone");
    expect(readStoredAudience()).toBeNull();
  });

  it("still switches when storage is blocked; the choice only does not survive a reload", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => {
      useAudience.getState().setAudience("organisation");
    }).not.toThrow();
    expect(useAudience.getState().audience).toBe("organisation");
    expect(readStoredAudience()).toBeNull();
  });
});
