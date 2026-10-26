// Starts the REAL operator binary on the mock chain, for the operator specs.
//
// It builds nothing: it needs ../target/debug/drop-operator (cargo build -p
// drop-operator) and web/dist (npm run build) to exist and to be current. The
// operator serves web/dist itself, so the specs exercise exactly what a person
// gets from the binary: one origin, the bearer token in the URL fragment.
//
// What this does:
//   1. checks the two build outputs exist and web/dist is not older than src/
//   2. starts the binary on a free loopback port with a temporary store and a
//      random passphrase, and reads the token from its startup banner
//   3. seeds three campaigns through the API (unfunded, funded, settled) so the
//      accessibility specs have something to look at
//   4. returns a teardown that stops the binary and deletes the temporary store
//
// The token and the passphrase are held in memory and in the worker environment
// only. Neither is printed.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Seeded } from "./env.js";

const WEB = process.cwd(); // playwright runs from web/
const BINARY = resolve(WEB, "../target/debug/drop-operator");
const DIST = resolve(WEB, "dist");
const CSV_DIR = resolve(WEB, "../fixtures/contract/operator/csv");

/** Slow enough that a run is visible in the UI, fast enough for a test. The screenshot specs that
 * watch a run unfold ask for a slower one (ZECDROP_E2E_POLL_MS, ZECDROP_E2E_CONFIRM_POLLS); it is
 * still this spec's own operator, on its own port and store. */
const OPERATOR_ARGS = [
  "--poll-interval-ms",
  /^\d{2,5}$/u.test(process.env["ZECDROP_E2E_POLL_MS"] ?? "") ? (process.env["ZECDROP_E2E_POLL_MS"] as string) : "250",
  "--mock-confirm-after-polls",
  /^\d{1,2}$/u.test(process.env["ZECDROP_E2E_CONFIRM_POLLS"] ?? "") ? (process.env["ZECDROP_E2E_CONFIRM_POLLS"] as string) : "2",
];

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function checkBuilds(): void {
  if (!existsSync(BINARY)) {
    throw new Error(`${BINARY} does not exist. Build it first: cargo build -p drop-operator`);
  }
  const index = join(DIST, "index.html");
  if (!existsSync(index)) throw new Error(`${index} does not exist. Build the page first: npm run build`);
  const built = statSync(index).mtimeMs;
  const edited = Math.max(newestMtime(join(WEB, "src")), statSync(join(WEB, "index.html")).mtimeMs);
  if (edited > built) {
    throw new Error("web/dist is older than web/src. Rebuild the page first: npm run build (npm run e2e does it for you)");
  }
}

interface Running {
  child: ChildProcess;
  origin: string;
  token: string;
  dir: string;
}

async function start(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "zecdrop-e2e-"));
  const child = spawn(
    BINARY,
    [
      "--mock-chain",
      "--bind",
      "127.0.0.1:0",
      "--db",
      join(dir, "store.sqlite"),
      // The account registry must outlive the store, so it has its own folder; here, inside the
      // temporary one, so nothing is written to ~/.zecdrop.
      "--state-dir",
      join(dir, "state"),
      "--web-dir",
      DIST,
      ...OPERATOR_ARGS,
    ],
    {
      env: { PATH: process.env["PATH"] ?? "", ZECDROP_PASSPHRASE: randomBytes(24).toString("hex") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Whatever happens to this process, do not leave the operator running.
  const killNow = () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  process.once("exit", killNow);

  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    const link = await new Promise<{ origin: string; token: string }>((done, fail) => {
      const timer = setTimeout(() => {
        fail(new Error(`the operator did not print its link within 30 seconds\n${stderr}`));
      }, 30_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = /open:\s+(http:\/\/127\.0\.0\.1:\d+)\/#token=([0-9a-f]{64})/u.exec(stdout);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          clearTimeout(timer);
          done({ origin: match[1], token: match[2] });
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        fail(new Error(`the operator exited early (code ${String(code)})\n${stderr}`));
      });
    });
    return { child, dir, ...link };
  } catch (error) {
    killNow();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function stop({ child, dir }: Running): Promise<void> {
  if (child.exitCode === null) {
    await new Promise<void>((done) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.once("exit", () => {
        clearTimeout(force);
        done();
      });
      child.kill("SIGTERM");
    });
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---- seeding ---------------------------------------------------------------------

async function api<T>(running: Running, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${running.origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${running.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`seeding: ${method} ${path} answered ${String(response.status)}`);
  return (await response.json()) as T;
}

interface CampaignJson {
  id: string;
  funding_required: string;
  run: { state: string };
}

async function seed(running: Running): Promise<Seeded> {
  const csv = readFileSync(join(CSV_DIR, "valid.csv"), "utf8");
  const create = (name: string) =>
    api<CampaignJson>(running, "POST", "/campaigns", { name, csv, max_outputs_per_batch: 3, fee_policy: "zip317_text" });
  const fund = (c: CampaignJson, vout: number) =>
    api<CampaignJson>(running, "POST", `/campaigns/${c.id}/fund-observed`, {
      outpoint: `${"cd".repeat(32)}:${String(vout)}`,
      amount: c.funding_required,
    });

  const awaiting = await create("Seed: awaiting funding");
  const funded = await create("Seed: funded");
  await fund(funded, 0);
  const settled = await create("Seed: settled");
  await fund(settled, 0);
  await api(running, "POST", `/campaigns/${settled.id}/start`);

  const deadline = Date.now() + 60_000;
  for (;;) {
    const now = await api<CampaignJson>(running, "GET", `/campaigns/${settled.id}`);
    if (now.run.state === "settled") break;
    if (Date.now() > deadline) throw new Error("seeding: the seed campaign did not settle within 60 seconds");
    await new Promise((r) => setTimeout(r, 250));
  }
  return { awaiting: awaiting.id, funded: funded.id, settled: settled.id };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  checkBuilds();
  const running = await start();
  try {
    const seeded = await seed(running);
    process.env["ZECDROP_E2E_ORIGIN"] = running.origin;
    process.env["ZECDROP_E2E_TOKEN"] = running.token;
    process.env["ZECDROP_E2E_SEEDED"] = JSON.stringify(seeded);
  } catch (error) {
    await stop(running);
    throw error;
  }
  return async () => {
    await stop(running);
  };
}
