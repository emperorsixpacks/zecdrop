import { describe, expect, it } from "vitest";

import { TOUR_LOOKS, TOUR_SHOTS, tourImageSrc } from "@/features/home/tour-steps";

import {
  buildHostedConfig,
  CLIENT_ROUTES,
  contentSecurityPolicy,
  matchSource,
  verifierOrigin,
} from "../../scripts/hosted-config.mjs";

// The hosting config for a public copy of the app (scripts/hosted-config.mjs).
// Nothing here deploys anything; it checks the file the owner would deploy.

describe("verifierOrigin", () => {
  it.each([
    ["https://verify.example.org", "https://verify.example.org"],
    ["https://verify.example.org/", "https://verify.example.org"],
    ["https://verify.example.org:8443/api", "https://verify.example.org:8443"],
    ["http://127.0.0.1:4175", "http://127.0.0.1:4175"],
    ["http://localhost:8080", "http://localhost:8080"],
  ])("%s is the origin %s", (apiUrl, origin) => {
    expect(verifierOrigin(apiUrl)).toBe(origin);
  });

  it.each([undefined, "", "/api", "/v1"])("%j means the page's own origin (nothing to add)", (apiUrl) => {
    expect(verifierOrigin(apiUrl)).toBeNull();
  });

  it.each([
    ["plain http to a real host", "http://verify.example.org"],
    ["credentials", "https://user:pass@verify.example.org"],
    ["a protocol-relative URL", "//verify.example.org"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a bare host", "verify.example.org"],
    ["ftp", "ftp://verify.example.org"],
  ])("refuses %s, so a typo cannot loosen the policy", (_label, apiUrl) => {
    expect(() => verifierOrigin(apiUrl)).toThrow();
  });
});

describe("the Content-Security-Policy", () => {
  const policy = contentSecurityPolicy("https://verify.example.org");
  const directive = (name: string) =>
    policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d === name || d.startsWith(`${name} `));

  it("allows only the page's own files by default", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
  });

  it("lets the page show its own pictures (the tour's), and no one else's: img-src is not set, so default-src rules", () => {
    expect(directive("img-src")).toBeUndefined();
    expect(policy).not.toMatch(/img-src|data:/u);
  });

  it("lets the page talk to its verifier and to nothing else", () => {
    expect(directive("connect-src")).toBe("connect-src 'self' https://verify.example.org");
  });

  it("forbids framing, plug-ins, <base> rewriting and posting forms elsewhere", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("form-action")).toBe("form-action 'self'");
  });

  it("never loosens script or style: no unsafe-inline, no unsafe-eval, no wildcard, no data:", () => {
    expect(policy).not.toMatch(/unsafe-|\*|data:|blob:|https?:\/\/(?!verify\.example\.org)/u);
    expect(directive("script-src")).toBeUndefined(); // falls back to default-src 'self'
    expect(directive("style-src")).toBeUndefined();
  });

  it("is only 'self' for connect-src when the API is on the page's own origin", () => {
    expect(contentSecurityPolicy(undefined)).toContain("connect-src 'self';");
    expect(contentSecurityPolicy("/api")).toContain("connect-src 'self';");
  });
});

describe("buildHostedConfig", () => {
  const config = buildHostedConfig({ apiUrl: "https://verify.example.org" });
  const headersFor = (pathname: string) =>
    config.headers
      .filter((rule) => matchSource(rule.source, pathname))
      .flatMap((rule) => rule.headers.map((h) => [h.key, h.value] as const));

  it("answers every client route with index.html", () => {
    expect(config.rewrites.map((r) => r.source)).toEqual([...CLIENT_ROUTES]);
    for (const rewrite of config.rewrites) expect(rewrite.destination).toBe("/index.html");
    for (const path of ["/r/c-1", "/r/demo", "/privacy", "/payslip", "/get-paid", "/campaigns", "/new", "/new/basics", "/campaign/c-1", "/audit"]) {
      expect(
        config.rewrites.some((r) => matchSource(r.source, path)),
        path,
      ).toBe(true);
    }
  });

  it("leaves real files alone: assets and the favicon are not rewritten", () => {
    for (const path of ["/assets/index-AbC123.js", "/assets/index-AbC123.css", "/favicon.svg", "/index.html", "/vercel.json"]) {
      expect(
        config.rewrites.some((r) => matchSource(r.source, path)),
        path,
      ).toBe(false);
    }
  });

  it("leaves the home page tour's pictures alone too: they are files in /tour, not client routes", () => {
    const pictures = TOUR_SHOTS.flatMap((shot) => TOUR_LOOKS.map((look) => tourImageSrc(shot, look)));
    expect(pictures).toHaveLength(16);
    for (const path of pictures) {
      expect(path).toMatch(/^\/tour\/[a-z-]+\.webp$/u);
      expect(
        config.rewrites.some((r) => matchSource(r.source, path)),
        path,
      ).toBe(false);
    }
  });

  it("does not mistake /campaigns for /campaign/…", () => {
    const campaign = CLIENT_ROUTES.find((r) => r.startsWith("/campaign/")) ?? "";
    expect(matchSource(campaign, "/campaigns")).toBe(false);
    expect(matchSource(campaign, "/campaign/c-1")).toBe(true);
  });

  it("puts the security headers on every path", () => {
    for (const path of ["/", "/r/demo", "/assets/index-AbC123.js", "/privacy", "/tour/receipt-light.webp"]) {
      const headers = Object.fromEntries(headersFor(path));
      expect(headers["Content-Security-Policy"], path).toContain("default-src 'self'");
      expect(headers["X-Content-Type-Options"], path).toBe("nosniff");
      expect(headers["Referrer-Policy"], path).toBe("no-referrer");
      expect(headers["X-Frame-Options"], path).toBe("DENY");
    }
  });

  it("caches hashed assets for a year and everything else not at all, never both", () => {
    const cache = (path: string) => headersFor(path).filter(([key]) => key === "Cache-Control").map(([, value]) => value);
    expect(cache("/assets/index-AbC123.js")).toEqual(["public, max-age=31536000, immutable"]);
    for (const path of ["/", "/index.html", "/r/demo", "/favicon.svg", "/tour/receipt-light.webp"]) {
      expect(cache(path), path).toEqual(["public, max-age=0, must-revalidate"]);
    }
  });

  it("names no host except the verifier", () => {
    const hosts = JSON.stringify(config).match(/https?:\/\/[^\s"';)]+/gu) ?? [];
    expect(hosts.filter((h) => !h.startsWith("https://verify.example.org") && !h.startsWith("https://openapi.vercel.sh"))).toEqual([]);
  });
});

describe("matchSource", () => {
  it.each([
    ["/(.*)", "/", true],
    ["/(.*)", "/a/b/c", true],
    ["/assets/(.*)", "/assets/x.js", true],
    ["/assets/(.*)", "/other/x.js", false],
    ["/privacy", "/privacy", true],
    ["/privacy", "/privacy/x", false],
    ["/privacy", "/privacyx", false],
    ["/r/:path*", "/r", true],
    ["/r/:path*", "/r/a/b", true],
    ["/r/:path*", "/rx", false],
    ["/x.json", "/xajson", false],
  ])("%s vs %s is %s", (source, path, expected) => {
    expect(matchSource(source, path)).toBe(expected);
  });
});
