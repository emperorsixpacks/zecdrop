/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { explorerAddressUrl, explorerTxUrl } from "./explorer";
import realReceipt8 from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/receipt.json?raw";
import realReceipt from "../../../fixtures/testnet-ironwood-batch/50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3/receipt.json?raw";

// scripts/check-explorer-links.mjs is a one-off for re-verifying the explorer
// links before submission. It reads the default templates out of
// src/lib/config.ts; this proves it builds exactly the links the page does,
// without touching the network (--dry-run).

type Sample = { batches: { txid: string }[]; funding_address?: string | null };
const eight = JSON.parse(realReceipt8) as Sample;
const smoke = JSON.parse(realReceipt) as Sample;

describe("scripts/check-explorer-links.mjs --dry-run", () => {
  const output = execFileSync("node", ["scripts/check-explorer-links.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const rows = output
    .trim()
    .split("\n")
    .map((line) => line.split("\t") as [string, string]);
  const urls = rows.map(([, url]) => url);

  it("checks BOTH real samples' transaction links exactly as the page builds them", () => {
    for (const sample of [eight, smoke]) {
      for (const batch of sample.batches) expect(urls).toContain(explorerTxUrl("testnet", batch.txid));
    }
    expect(rows.filter(([what]) => what.startsWith("transaction (")).length).toBe(
      eight.batches.length + smoke.batches.length,
    );
  });

  it("checks the funding address link, exactly as the page builds it", () => {
    const address = eight.funding_address ?? null;
    expect(address).not.toBeNull();
    expect(urls).toContain(explorerAddressUrl("testnet", address ?? ""));
    // Both samples share one funding address, so its link is listed once.
    expect(rows.filter(([what]) => what.startsWith("funding address")).length).toBe(1);
  });

  it("also checks an unknown transaction and an unknown address, so a 200 for the real ones means something", () => {
    expect(rows).toContainEqual(["unknown transaction (control)", explorerTxUrl("testnet", "0".repeat(64))]);
    expect(rows.some(([what]) => what === "unknown address (control)")).toBe(true);
  });

  it("makes no request in a dry run (it prints links and stops)", () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const url of urls) expect(url).toMatch(/^https:\/\//u);
  });
});
