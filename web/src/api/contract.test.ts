// Contract tests against the golden files that the Rust tests generate:
//   fixtures/contract/public-receipt*.json   (relative to web/: ../fixtures/...)
//
// The Rust side pins each file to what PublicReceipt serializes to today, so
// when the core changes the wire format its test fails until the files are
// regenerated, and then THIS test fails until types.ts is updated on purpose.
// Neither side can drift alone. Update the schema, not the assertions here.
//
// Files are pulled in with Vite's `?raw` import so the test needs no Node APIs
// (and `import.meta` stays confined to lib/config.ts).

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import mismatchText from "../../../fixtures/contract/public-receipt-declared-mismatch.json?raw";
import findingsText from "../../../fixtures/contract/public-receipt-findings.json?raw";
import goldenText from "../../../fixtures/contract/public-receipt.json?raw";
// Real batches mined on public testnet, as the live verifier reported them
// (public chain data only; see fixtures/testnet-ironwood-batch*/README.md).
import realTestnetText from "../../../fixtures/testnet-ironwood-batch/50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3/receipt.json?raw";
import realTestnet8Text from "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/receipt.json?raw";

import { parsePublicReceipt } from "./types";

type Json = Record<string, unknown>;
interface Wire extends Json {
  batches: Json[];
  phase: Json;
  findings: Json[];
}

const FIXTURES: [name: string, text: string][] = [
  ["public-receipt.json", goldenText],
  ["public-receipt-findings.json", findingsText],
  ["public-receipt-declared-mismatch.json", mismatchText],
  ["testnet-ironwood-batch/<txid>/receipt.json (the first real testnet batch, 3 outputs)", realTestnetText],
  ["testnet-ironwood-batch-8/<txid>/receipt.json (the real 8-output testnet batch)", realTestnet8Text],
];

/** A fresh deep copy, so each test mutates its own payload. */
const copy = (text: string): Wire => JSON.parse(text) as Wire;

const TOP_LEVEL_KEYS = [
  "batches",
  "campaign_id",
  "declared_total",
  "fee_total",
  "findings",
  "funding_address",
  "manifest_commitment",
  "network",
  "phase",
];
const BATCH_KEYS = [
  "confirmations",
  "fee",
  "funding_input",
  "index",
  "net_into_pool",
  "pool",
  "shielded_actions",
  "txid",
];

// covers: REQ-PRIV-001
describe.each(FIXTURES)("%s (from the Rust core)", (_name, text) => {
  it("parses with the strict schema", () => {
    expect(() => parsePublicReceipt(copy(text))).not.toThrow();
  });

  it("has exactly the allow-listed keys (drift alarm)", () => {
    // If the core adds or renames a key, this fails together with the schema.
    const wire = copy(text);
    expect(Object.keys(wire).sort()).toEqual(TOP_LEVEL_KEYS);
    for (const batch of wire.batches) expect(Object.keys(batch).sort()).toEqual(BATCH_KEYS);
    for (const finding of wire.findings) {
      expect(["code", "batch_index"]).toEqual(expect.arrayContaining(Object.keys(finding)));
    }
  });

  it("contains no per-recipient data", () => {
    // The one address a receipt may carry is the CAMPAIGN's transparent funding address, public on
    // the chain. It is a top-level string, not a recipient. Everything else is scanned for the words.
    const { funding_address: fundingAddress, ...rest } = copy(text);
    expect(fundingAddress === undefined || fundingAddress === null || typeof fundingAddress === "string").toBe(true);
    const lower = JSON.stringify(rest).toLowerCase();
    for (const word of ["recipient", "address", "memo", "amount"]) {
      expect(lower, `the fixture mentions "${word}"`).not.toContain(word);
    }
  });

  describe("with private fields injected, it is refused", () => {
    const injected: [key: string, value: unknown][] = [
      ["recipients", [{ address: "u1sentineladdress", amount: "7777001" }]],
      ["address", "u1sentineladdress"],
      ["amount", "7777001"],
      ["memo", "sentinel-memo-one"],
    ];

    it.each(injected)("top-level `%s`", (key, value) => {
      const payload = copy(text);
      payload[key] = value;
      expect(() => parsePublicReceipt(payload)).toThrow(ZodError);
    });

    it.each(injected)("`%s` in every batch", (key, value) => {
      for (let i = 0; i < copy(text).batches.length; i++) {
        const payload = copy(text);
        (payload.batches[i] as Json)[key] = value;
        expect(() => parsePublicReceipt(payload)).toThrow(ZodError);
      }
    });

    it.each(injected)("`%s` in the phase object", (key, value) => {
      const payload = copy(text);
      payload.phase[key] = value;
      expect(() => parsePublicReceipt(payload)).toThrow(ZodError);
    });

    it.each(injected)("`%s` in every finding", (key, value) => {
      for (let i = 0; i < copy(text).findings.length; i++) {
        const payload = copy(text);
        (payload.findings[i] as Json)[key] = value;
        expect(() => parsePublicReceipt(payload)).toThrow(ZodError);
      }
    });
  });

  it("a renamed or dropped key is refused too", () => {
    const renamed = copy(text);
    renamed["declaredTotal"] = renamed["declared_total"];
    delete renamed["declared_total"];
    expect(() => parsePublicReceipt(renamed)).toThrow(ZodError);

    const dropped = copy(text);
    delete (dropped.batches[0] as Json)["pool"];
    expect(() => parsePublicReceipt(dropped)).toThrow(ZodError);

    const noFindings: Json = copy(text);
    delete noFindings["findings"];
    expect(() => parsePublicReceipt(noFindings)).toThrow(ZodError);
  });
});

describe("public-receipt.json: a campaign in progress", () => {
  it("maps to the expected view", () => {
    expect(parsePublicReceipt(copy(goldenText))).toEqual({
      campaignId: "golden-fixture",
      network: "testnet",
      fundingAddress: "tFAKEfundingAddressNotARealAddress0000",
      declaredTotal: "534500000",
      feeTotal: "35000",
      manifestCommitment: "e".repeat(64),
      phase: { phase: "sending", done: 1, total: 2 },
      findings: [],
      batches: [
        {
          index: 0,
          txid: "a".repeat(64),
          fundingInput: { txid: "c".repeat(64), vout: 0 },
          netIntoPool: "485000000",
          fee: "20000",
          shieldedActions: 3,
          pool: "ironwood",
          confirmations: 5,
        },
        {
          index: 1,
          txid: null, // not built yet
          fundingInput: { txid: "c".repeat(64), vout: 1 },
          netIntoPool: "49500000",
          fee: "15000",
          shieldedActions: 2,
          pool: "ironwood",
          confirmations: 0,
        },
      ],
    });
  });

  it("is consistent with itself (totals add up)", () => {
    // Not a schema rule; a sanity check that the fixture is a real receipt.
    const wire = copy(goldenText);
    const net = wire.batches.reduce((sum, b) => sum + BigInt(b["net_into_pool"] as string), 0n);
    const fees = wire.batches.reduce((sum, b) => sum + BigInt(b["fee"] as string), 0n);
    expect(net.toString()).toBe(wire["declared_total"]);
    expect(fees.toString()).toBe(wire["fee_total"]);
  });
});

// covers: REQ-VER-001
describe("public-receipt-findings.json: every kind of problem a verifier can report", () => {
  const view = parsePublicReceipt(copy(findingsText));

  it("reports a failed campaign with an unknown fee total", () => {
    expect(view.phase).toEqual({ phase: "failed" });
    expect(view.feeTotal).toBeNull();
    expect(view.campaignId).toBe("golden-fixture");
    expect(view.batches).toHaveLength(8);
  });

  it("lists every batch-level finding code, with the batch it is about", () => {
    expect(view.findings).toEqual([
      { code: "tx_not_found", batchIndex: 2 },
      { code: "tx_unparseable", batchIndex: 3 },
      { code: "prevout_unresolved", batchIndex: 4 },
      { code: "negative_fee", batchIndex: 5 },
      { code: "balance_mismatch", batchIndex: 6 },
      { code: "unexpected_pool", batchIndex: 7 },
      { code: "mixed_funding_sources", batchIndex: 6 },
      { code: "batch_pending", batchIndex: 1 },
    ]);
  });

  it("keeps the facts it could establish and nulls the ones it could not", () => {
    const [ok, pending, notFound, unparseable, noFee, , , wrongPool] = view.batches;
    expect(ok).toMatchObject({ netIntoPool: "1000000", fee: "20000", pool: "ironwood" });
    expect(pending).toMatchObject({ confirmations: 1, fee: "20000" });
    for (const unknown of [notFound, unparseable]) {
      expect(unknown).toMatchObject({
        fundingInput: null,
        netIntoPool: null,
        fee: null,
        shieldedActions: null,
        pool: null,
        confirmations: 0,
      });
      expect(unknown?.txid).not.toBeNull(); // the txid was asked for, so it is known
    }
    expect(noFee).toMatchObject({ netIntoPool: "1000000", fee: null });
    expect(wrongPool?.pool).toBe("orchard");
  });
});

// covers: REQ-VER-001
describe("public-receipt-declared-mismatch.json: the declared total does not add up", () => {
  const view = parsePublicReceipt(copy(mismatchText));

  it("reports it as a finding and a failed phase, not as a failed request", () => {
    expect(view.findings).toEqual([{ code: "declared_total_mismatch" }]);
    expect(view.phase).toEqual({ phase: "failed" });
  });

  it("does not name the campaign: a key-less verifier was not told", () => {
    expect(view.campaignId).toBeNull();
  });

  it("still knows every fee, so the fee total is present", () => {
    expect(view.feeTotal).toBe("40000");
    expect(view.declaredTotal).toBe("2000001");
    expect(view.batches.map((b) => b.netIntoPool)).toEqual(["1000000", "1000000"]);
  });
});
