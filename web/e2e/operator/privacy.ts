// What the operator specs use to prove that no recipient data is left where it
// should not be: in browser storage, in a URL, in the console, in a request
// other than the one that creates the campaign, or in any response.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page, Request } from "@playwright/test";

const CSV_PATH = resolve(process.cwd(), "../fixtures/contract/operator/csv/valid.csv");

export interface Sentinels {
  /** The whole CSV, as typed or uploaded. */
  csv: string;
  addresses: string[];
  memos: string[];
  /** Amounts as written in the CSV. Matched as whole numbers only. */
  amounts: string[];
}

/** The sentinel recipients from the captured fixtures: recognisable addresses,
 * memos and amounts that appear nowhere else in the app. */
export function loadSentinels(file = "valid.csv"): Sentinels {
  const csv = readFileSync(CSV_PATH.replace("valid.csv", file), "utf8");
  const rows = csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(","));
  return {
    csv,
    addresses: rows.map((r) => r[0] ?? "").filter(Boolean),
    memos: rows.map((r) => r[2] ?? "").filter(Boolean),
    // "3" and "0.75" are too common to match as substrings; only amounts with a
    // fraction are distinctive enough, and they are matched as whole numbers.
    amounts: rows.map((r) => r[1] ?? "").filter((a) => a.includes(".")),
  };
}

/** Which kinds of sentinel appear in `text`. Names the kind and the row, never
 * repeats the value, so a failure report does not itself spread the data. */
export function findSentinels(text: string, s: Sentinels): string[] {
  const found: string[] = [];
  if (text.includes(s.csv.trim())) found.push("the whole CSV");
  s.addresses.forEach((value, i) => {
    if (text.includes(value)) found.push(`address of row ${String(i + 1)}`);
  });
  s.memos.forEach((value, i) => {
    if (text.includes(value)) found.push(`memo ${String(i + 1)}`);
  });
  s.amounts.forEach((value, i) => {
    const pattern = new RegExp(`(?<![\\d.])${value.replace(".", "\\.")}(?!\\d)`, "u");
    if (pattern.test(text)) found.push(`amount ${String(i + 1)}`);
  });
  return found;
}

// ---- what is on the page ----------------------------------------------------------------

/** The page's text without the list the person is working on: the preview rows and
 * the text boxes. While the list is being prepared it may be on screen there and
 * nowhere else; once the campaign exists it may be nowhere. */
export async function textOutsideTheList(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("textarea, input, [data-recipient-preview]").forEach((el) => {
      el.remove();
    });
    return copy.textContent ?? "";
  });
}

// ---- everything the browser holds -------------------------------------------------------

/** Every place the page can keep data, as one string: localStorage,
 * sessionStorage, IndexedDB (every record of every store), the cache storage,
 * service workers, `window.name`, the history entry and cookies. */
export async function dumpBrowserState(page: Page): Promise<string> {
  const inPage = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    out["localStorage"] = { ...localStorage };
    out["sessionStorage"] = { ...sessionStorage };
    out["windowName"] = window.name;
    out["historyState"] = history.state as unknown;
    out["cookie"] = document.cookie;

    const databases: Record<string, unknown> = {};
    for (const { name } of await indexedDB.databases()) {
      if (name === undefined) continue;
      databases[name] = await new Promise((resolveDb) => {
        const open = indexedDB.open(name);
        open.onerror = () => {
          resolveDb("unreadable");
        };
        open.onsuccess = () => {
          const db = open.result;
          const stores = [...db.objectStoreNames];
          const dump: Record<string, unknown> = {};
          if (stores.length === 0) {
            db.close();
            resolveDb(dump);
            return;
          }
          const tx = db.transaction(stores, "readonly");
          let pending = stores.length;
          for (const store of stores) {
            const all = tx.objectStore(store).getAll();
            all.onsuccess = () => {
              dump[store] = all.result;
              if (--pending === 0) {
                db.close();
                resolveDb(dump);
              }
            };
          }
        };
      });
    }
    out["indexedDB"] = databases;

    const caches_: Record<string, string[]> = {};
    for (const key of await caches.keys()) {
      caches_[key] = (await (await caches.open(key)).keys()).map((r) => r.url);
    }
    out["caches"] = caches_;
    out["serviceWorkers"] = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope);
    return out;
  });
  const cookies = await page.context().cookies();
  return JSON.stringify({ ...inPage, cookies });
}

// ---- everything the page does -----------------------------------------------------------

export interface Observed {
  /** Every console message of any type, as "type: text". */
  console: () => string[];
  /** Only errors, warnings and uncaught exceptions. */
  problems: () => string[];
  /** Every URL the page was at or asked for, including history changes. */
  urls: () => string[];
  /** Every request, with its method, URL and body. */
  requests: () => { method: string; url: string; body: string | null; hasToken: boolean }[];
  /** The text of every API response except the event stream. */
  responses: () => { url: string; text: string }[];
}

/** Start watching a page. Call before the first navigation. */
export async function observe(page: Page): Promise<Observed> {
  const messages: string[] = [];
  const problems: string[] = [];
  const urls: string[] = [];
  const requests: ReturnType<Observed["requests"]> = [];
  const responses: { url: string; text: string }[] = [];

  page.on("console", (message) => {
    const line = `${message.type()}: ${message.text()}`;
    messages.push(line);
    if (message.type() === "error" || message.type() === "warning") problems.push(`console.${line}`);
  });
  page.on("pageerror", (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });

  // History changes inside the app (pushState / replaceState) do not always
  // surface as navigations, so the page reports them.
  await page.exposeFunction("__zdSawUrl", (url: string) => {
    urls.push(url);
  });
  await page.addInitScript(() => {
    const report = () => {
      (window as unknown as { __zdSawUrl?: (u: string) => void }).__zdSawUrl?.(location.href);
    };
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = (...args: Parameters<History["pushState"]>) => {
        original(...args);
        report();
      };
    }
    window.addEventListener("popstate", report);
    window.addEventListener("hashchange", report);
  });

  page.on("request", (request: Request) => {
    const token = (request.headers()["authorization"] ?? "").startsWith("Bearer ");
    requests.push({ method: request.method(), url: request.url(), body: request.postData(), hasToken: token });
    urls.push(request.url());
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/") || url.endsWith("/events")) return;
    void response
      .text()
      .then((text) => responses.push({ url, text }))
      .catch(() => undefined); // the page moved on before the body was read
  });

  return {
    console: () => messages,
    problems: () => problems,
    urls: () => urls,
    requests: () => requests,
    responses: () => responses,
  };
}

/** The real demo payout list (examples/demo-recipients.testnet.csv): public testnet addresses
 * from the sample batch, for screenshots and the checks that need a believable list. */
export function loadDemoCsv(): string {
  return readFileSync(resolve(process.cwd(), "../examples/demo-recipients.testnet.csv"), "utf8");
}
