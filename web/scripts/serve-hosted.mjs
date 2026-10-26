// Serves a built copy of the app the way the host will: the files, the rewrites
// and the response headers of the vercel.json that scripts/hosted-config.mjs wrote
// into the same folder. For local previews and the browser test only; it is not
// a production server and it deploys nothing.
//
//   node scripts/serve-hosted.mjs --dir dist-hosted --port 4174

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import { matchSource } from "./hosted-config.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback);
const DIR = resolve(process.cwd(), option("--dir", "dist"));
const PORT = Number(option("--port", "4174"));

const config = JSON.parse(readFileSync(join(DIR, "vercel.json"), "utf8"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".ico": "image/x-icon",
};

/** The file for a request path, or null (never outside DIR). */
function fileFor(pathname) {
  const target = normalize(join(DIR, decodeURIComponent(pathname)));
  if (target !== DIR && !target.startsWith(DIR + sep)) return null;
  try {
    const stat = statSync(target);
    if (stat.isFile()) return target;
    if (stat.isDirectory()) return fileFor(join(pathname, "index.html"));
  } catch {
    /* not a file */
  }
  return null;
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://placeholder");
  let file;
  try {
    file = fileFor(url.pathname);
  } catch {
    file = null;
  }
  let status = 200;
  if (file === null && config.rewrites.some((r) => matchSource(r.source, url.pathname))) {
    file = join(DIR, "index.html");
  }
  if (file === null) status = 404;

  // Headers from every rule whose source matches; a later rule's value for a key wins.
  for (const rule of config.headers) {
    if (!matchSource(rule.source, url.pathname)) continue;
    for (const { key, value } of rule.headers) response.setHeader(key, value);
  }
  if (file === null) {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  response.writeHead(status, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  response.end(request.method === "HEAD" ? undefined : readFileSync(file));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${DIR} on http://127.0.0.1:${String(PORT)}`);
});
