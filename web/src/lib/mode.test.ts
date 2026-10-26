import { describe, expect, it } from "vitest";

import { isLoopbackHost, publicModeFor } from "./mode";

describe("isLoopbackHost", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "LOCALHOST"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "demo.example.org",
    "zecdrop.vercel.app",
    "127.0.0.1.example.org",
    "localhost.example.org",
    "0.0.0.0",
    "192.168.1.5",
    "",
  ])("%j is not", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("publicModeFor", () => {
  it("is the operator UI on loopback, unless the build says it is public-only", () => {
    expect(publicModeFor("localhost", false)).toBe(false);
    expect(publicModeFor("127.0.0.1", false)).toBe(false);
    expect(publicModeFor("127.0.0.1", true)).toBe(true);
  });

  it("is the public viewer anywhere else, whatever the build says", () => {
    expect(publicModeFor("demo.example.org", false)).toBe(true);
    expect(publicModeFor("demo.example.org", true)).toBe(true);
  });
});
