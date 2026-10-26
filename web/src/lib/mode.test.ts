import { describe, expect, it } from "vitest";

import { isLoopbackHost, landOnPayouts, publicModeFor } from "./mode";

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

// covers: REQ-RUN-002
describe("landOnPayouts", () => {
  const TOKEN = `#token=${"ab".repeat(32)}`;
  /** A history that remembers what it was told, the way the page's own does. */
  function history() {
    const urls: string[] = [];
    return { urls, state: { idx: 0 }, replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => urls.push(String(url)) };
  }

  it("takes the operator's own link, at the site's root with its token, to the payouts, token and all", () => {
    const h = history();
    landOnPayouts({ pathname: "/", hash: TOKEN }, h, false);
    // The token goes along, for the session to take out of the address right after.
    expect(h.urls).toEqual([`/campaigns${TOKEN}`]);
  });

  it("leaves every other address alone: another page, no token, or the public site", () => {
    for (const [pathname, hash, publicMode] of [
      ["/campaigns", TOKEN, false],
      ["/new", TOKEN, false],
      ["/", "", false],
      ["/", "#top", false],
      ["/", TOKEN, true],
    ] as const) {
      const h = history();
      landOnPayouts({ pathname, hash }, h, publicMode);
      expect(h.urls, `${pathname}${hash} public=${String(publicMode)}`).toEqual([]);
    }
  });
});
