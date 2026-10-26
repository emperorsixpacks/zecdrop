// The hosting config for a PUBLIC, static copy of the app: the receipt viewer.
//
//   VITE_API_URL=https://<verifier-host> node scripts/hosted-config.mjs [--dist dist] [--root]
//
// writes <dist>/vercel.json (default dist = dist) and, with --root, also ./vercel.json.
// `npm run build:hosted` builds the page and then runs this. The same VITE_API_URL
// that the page is built with decides the Content-Security-Policy's connect-src,
// so the page can talk to its verifier and to nothing else, and there is one place
// to set the verifier's address. Nothing is hard-coded: with no VITE_API_URL
// (the page and its API on one origin) connect-src is just 'self'.
//
// vercel.json cannot read environment variables, which is why it is generated
// rather than committed. Nothing here deploys anything or calls any hosting API.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin of the verifier named by VITE_API_URL, or null when the API is on
 * the page's own origin (an absolute path such as /api, or nothing).
 *
 * https only, except loopback http, which the local preview test uses. Anything
 * else is an error: a typo here would otherwise become a loosened policy. */
export function verifierOrigin(apiUrl) {
  if (apiUrl === undefined || apiUrl === "") return null;
  if (apiUrl.startsWith("/") && !apiUrl.startsWith("//")) return null;
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`VITE_API_URL is not a URL or an absolute path: ${apiUrl}`);
  }
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (!secure && !localHttp) {
    throw new Error("VITE_API_URL must be an https URL (or http on loopback, for local previews)");
  }
  if (url.username || url.password) throw new Error("VITE_API_URL must not carry credentials");
  return url.origin;
}

/** The policy for the hosted page. */
export function contentSecurityPolicy(apiUrl) {
  const origin = verifierOrigin(apiUrl);
  return [
    "default-src 'self'",
    `connect-src 'self'${origin === null ? "" : ` ${origin}`}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** The routes the app handles in the browser; the host must answer them all with index.html. */
export const CLIENT_ROUTES = ["/r/:path*", "/privacy", "/payslip", "/get-paid", "/start", "/campaigns", "/new/:path*", "/campaign/:path*", "/audit"];

export function buildHostedConfig({ apiUrl }) {
  return {
    $schema: "https://openapi.vercel.sh/vercel.json",
    rewrites: CLIENT_ROUTES.map((source) => ({ source, destination: "/index.html" })),
    headers: [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy(apiUrl) },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
      // Hashed files never change under the same name; the page that names them must always be re-checked.
      { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/((?!assets/).*)", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
    ],
  };
}

/** Whether `pathname` matches a vercel.json `source` (the subset used above:
 * literal text, `(regex)` groups, `:name` and `:name*`). The local preview server
 * and the tests use the same matcher, so what they check is what is written. */
export function matchSource(source, pathname) {
  let pattern = "";
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (ch === "(") {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === "(") depth += 1;
        else if (source[j] === ")" && --depth === 0) break;
      }
      pattern += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && source[i + 1] === ":") {
      const name = /^:[A-Za-z_]\w*/u.exec(source.slice(i + 1))?.[0] ?? ":";
      const after = source[i + 1 + name.length];
      if (after === "*") {
        pattern += "(?:/.*)?";
        i += name.length + 2;
      } else {
        pattern += "/[^/]+";
        i += name.length + 1;
      }
    } else {
      pattern += ch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`, "u").test(pathname);
}

// ---- command line -------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const dist = resolve(process.cwd(), args.includes("--dist") ? (args[args.indexOf("--dist") + 1] ?? "dist") : "dist");
  const config = buildHostedConfig({ apiUrl: process.env["VITE_API_URL"] });
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const targets = [join(dist, "vercel.json"), ...(args.includes("--root") ? [resolve(process.cwd(), "vercel.json")] : [])];
  for (const target of targets) writeFileSync(target, text);
  const origin = verifierOrigin(process.env["VITE_API_URL"]);
  console.log(`wrote ${targets.join(", ")}`);
  console.log(`connect-src: 'self'${origin === null ? " (the page's own origin only)" : ` ${origin}`}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
