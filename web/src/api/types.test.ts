import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { MAX_MONEY } from "@/lib/zec";

import { parsePublicReceipt, type PublicReceipt } from "./types";

// ---- Wire fixtures (snake_case, exactly what the Rust core serializes) ----

const TXID = "a".repeat(64);
const FUNDING_TXID = "c".repeat(64);

type Json = Record<string, unknown>;

function wireBatch(patch: Json = {}): Json {
  return {
    index: 0,
    txid: TXID,
    funding_input: `${FUNDING_TXID}:0`,
    net_into_pool: "485000000",
    fee: "20000",
    shielded_actions: 3,
    pool: "ironwood",
    confirmations: 5,
    ...patch,
  };
}

function wireReceipt(patch: Json = {}): Json {
  return {
    campaign_id: "camp-01",
    network: "testnet",
    funding_address: null,
    declared_total: "485000000",
    fee_total: "20000",
    batches: [wireBatch()],
    manifest_commitment: "e".repeat(64),
    phase: { phase: "settled" },
    findings: [],
    ...patch,
  };
}

/** A receipt whose only batch has `patch` applied. */
const withBatch = (patch: Json): Json => wireReceipt({ batches: [wireBatch(patch)] });

/** A copy of `source` without `key`. */
function without(source: Json, key: string): Json {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

const rejects = (input: unknown) =>
  expect(() => parsePublicReceipt(input)).toThrow(ZodError);

// ---- The funding address (added by the core with the mixed-funding finding) ------

describe("funding_address", () => {
  it("is carried when the verifier establishes it", () => {
    const view = parsePublicReceipt({ ...wireReceipt(), funding_address: "tmFundingAddressForTests1234" });
    expect(view.fundingAddress).toBe("tmFundingAddressForTests1234");
  });

  it("is null when the verifier says so", () => {
    expect(parsePublicReceipt({ ...wireReceipt(), funding_address: null }).fundingAddress).toBeNull();
  });

  it("is required: a receipt without the key is refused, not read as null", () => {
    const { funding_address: _dropped, ...without } = wireReceipt() as Record<string, unknown>;
    expect(() => parsePublicReceipt(without)).toThrow(ZodError);
  });

  it.each([["an empty string", ""], ["whitespace inside", "t m"], ["a number", 5], ["an object", { a: 1 }]])(
    "refuses %s",
    (_label, value) => {
      expect(() => parsePublicReceipt({ ...wireReceipt(), funding_address: value })).toThrow(ZodError);
    },
  );
});

// ---- Mapping --------------------------------------------------------------

describe("wire to view mapping", () => {
  it("maps snake_case to camelCase and parses the outpoint", () => {
    const view: PublicReceipt = parsePublicReceipt(wireReceipt());
    expect(view).toEqual({
      campaignId: "camp-01",
      network: "testnet",
      fundingAddress: null,
      declaredTotal: "485000000",
      feeTotal: "20000",
      manifestCommitment: "e".repeat(64),
      phase: { phase: "settled" },
      findings: [],
      batches: [
        {
          index: 0,
          txid: TXID,
          fundingInput: { txid: FUNDING_TXID, vout: 0 },
          netIntoPool: "485000000",
          fee: "20000",
          shieldedActions: 3,
          pool: "ironwood",
          confirmations: 5,
        },
      ],
    });
  });

  it("exposes no snake_case key on the view", () => {
    const view = parsePublicReceipt(wireReceipt());
    const keys = [...Object.keys(view), ...Object.keys(view.batches[0] ?? {})];
    expect(keys.filter((k) => k.includes("_"))).toEqual([]);
  });

  it("accepts zero batches", () => {
    expect(parsePublicReceipt(wireReceipt({ batches: [] })).batches).toEqual([]);
  });

  it("the camelCase view shape is NOT accepted as input", () => {
    // Guards against the UI feeding its own output back in, or the verifier
    // switching casing without the contract test noticing.
    rejects(parsePublicReceipt(wireReceipt()));
  });
});

// ---- Phase ----------------------------------------------------------------

describe("phase", () => {
  const forms: [label: string, wire: Json][] = [
    ["draft", { phase: "draft" }],
    ["awaiting_funding", { phase: "awaiting_funding" }],
    ["funded", { phase: "funded" }],
    ["sending", { phase: "sending", done: 1, total: 2 }],
    ["sending, nothing done yet", { phase: "sending", done: 0, total: 5 }],
    ["sending, all done", { phase: "sending", done: 3, total: 3 }],
    ["settled", { phase: "settled" }],
    ["failed", { phase: "failed" }],
  ];

  it.each(forms)("accepts %s", (_label, wire) => {
    expect(parsePublicReceipt(wireReceipt({ phase: wire })).phase).toEqual(wire);
  });

  const bad: [label: string, wire: unknown][] = [
    ["the flat string form", "settled"],
    ["an unknown phase", { phase: "done" }],
    ["a missing tag", {}],
    ["sending without counters", { phase: "sending" }],
    ["sending with a missing total", { phase: "sending", done: 1 }],
    ["sending with done above total", { phase: "sending", done: 3, total: 2 }],
    ["sending with a negative counter", { phase: "sending", done: -1, total: 2 }],
    ["sending with a fractional counter", { phase: "sending", done: 0.5, total: 2 }],
    ["sending with a string counter", { phase: "sending", done: "1", total: 2 }],
    ["counters on a phase that has none", { phase: "settled", done: 1, total: 1 }],
    ["an extra field on draft", { phase: "draft", note: "x" }],
    ["a counter above u32", { phase: "sending", done: 0, total: 4_294_967_296 }],
    ["null", null],
  ];

  it.each(bad)("rejects %s", (_label, wire) => {
    rejects(wireReceipt({ phase: wire }));
  });
});

// ---- Per-recipient data must never be accepted ---------------------------

// covers: REQ-PRIV-001
describe("per-recipient data is rejected, never stripped", () => {
  const PRIVATE_FIELDS: [key: string, value: unknown][] = [
    ["recipients", [{ address: "u1x", amount: "1" }]],
    ["address", "u1sentinelleakedaddress"],
    ["amount", "424242"],
    ["memo", "sentinel memo text"],
    ["recipient", "u1sentinelleakedaddress"],
    ["outputs", [{ to: "u1x", value: "1" }]],
  ];

  it.each(PRIVATE_FIELDS)("rejects top-level `%s`", (key, value) => {
    rejects(wireReceipt({ [key]: value }));
  });

  it.each(PRIVATE_FIELDS)("rejects `%s` inside a batch", (key, value) => {
    rejects(withBatch({ [key]: value }));
  });

  it.each(PRIVATE_FIELDS)("rejects `%s` inside the phase object", (key, value) => {
    rejects(wireReceipt({ phase: { phase: "sending", done: 0, total: 1, [key]: value } }));
  });

  it("does not echo the leaked values in the error message", () => {
    const payload = wireReceipt({
      address: "u1sentinelleakedaddress",
      amount: "424242",
      memo: "sentinel memo text",
    });
    let message = "";
    try {
      parsePublicReceipt(payload);
    } catch (e) {
      message = e instanceof ZodError ? e.message : String(e);
    }
    expect(message).toMatch(/address/); // names the key...
    for (const secret of ["u1sentinelleakedaddress", "424242", "sentinel memo text"]) {
      expect(message).not.toContain(secret); // ...never the value
    }
  });

  it("the retired field name orchard_actions is refused", () => {
    rejects(withBatch({ orchard_actions: 3 }));
    rejects({ ...wireReceipt(), batches: [{ ...without(wireBatch(), "shielded_actions"), orchard_actions: 3 }] });
  });
});

// ---- Field rules ----------------------------------------------------------

describe("required fields", () => {
  it.each(Object.keys(wireReceipt()))("receipt requires `%s`", (key) => {
    rejects(without(wireReceipt(), key));
  });

  it.each(Object.keys(wireBatch()))("batch requires `%s`", (key) => {
    rejects(wireReceipt({ batches: [without(wireBatch(), key)] }));
  });

  it("rejects things that are not objects", () => {
    for (const bad of [null, undefined, 1, "x", [], [wireReceipt()]]) rejects(bad);
  });
});

describe("batch txid", () => {
  it("may be null before the batch is built", () => {
    const view = parsePublicReceipt(withBatch({ txid: null, confirmations: 0 }));
    expect(view.batches[0]?.txid).toBeNull();
  });

  it.each([
    "short",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64), // wire ids are lowercase
    `0x${"a".repeat(62)}`,
    "g".repeat(64),
    "",
    ` ${"a".repeat(63)}`,
  ])("rejects %j", (txid) => {
    rejects(withBatch({ txid }));
  });

  it("rejects a missing txid (null is explicit, absence is not allowed)", () => {
    rejects(wireReceipt({ batches: [without(wireBatch(), "txid")] }));
  });
});

describe("batch funding_input", () => {
  it.each([
    [`${FUNDING_TXID}:0`, 0],
    [`${FUNDING_TXID}:7`, 7],
    [`${FUNDING_TXID}:4294967295`, 4_294_967_295],
  ])("accepts %s", (text, vout) => {
    const view = parsePublicReceipt(withBatch({ funding_input: text }));
    expect(view.batches[0]?.fundingInput).toEqual({ txid: FUNDING_TXID, vout });
  });

  it.each([
    ["no separator", FUNDING_TXID],
    ["empty index", `${FUNDING_TXID}:`],
    ["empty txid", ":1"],
    ["negative index", `${FUNDING_TXID}:-1`],
    ["leading zero", `${FUNDING_TXID}:01`],
    ["index above u32", `${FUNDING_TXID}:4294967296`],
    ["huge index", `${FUNDING_TXID}:99999999999999999999`],
    ["fractional index", `${FUNDING_TXID}:1.5`],
    ["uppercase txid", `${"C".repeat(64)}:0`],
    ["short txid", `${"c".repeat(63)}:0`],
    ["two separators", `${FUNDING_TXID}:0:1`],
    ["trailing space", `${FUNDING_TXID}:0 `],
    ["an object instead of a string", { txid: FUNDING_TXID, vout: 0 }],
  ])("rejects %s", (_label, text) => {
    rejects(withBatch({ funding_input: text }));
  });
});

describe("amounts", () => {
  const MAX = MAX_MONEY.toString();

  it("accepts zero and exactly the supply cap", () => {
    expect(parsePublicReceipt(wireReceipt({ declared_total: "0" })).declaredTotal).toBe("0");
    expect(parsePublicReceipt(wireReceipt({ declared_total: MAX })).declaredTotal).toBe(MAX);
  });

  it.each([
    1000, // a number, not a string
    1000n,
    "-1",
    "+1",
    "1.5",
    "1e3",
    " 1",
    "1 ",
    "01",
    "",
    "0x10",
    "1,000",
    (MAX_MONEY + 1n).toString(), // above the 21M ZEC supply
    "18446744073709551615", // u64 max: fits u64 but is not a valid amount
    "18446744073709551616",
  ])("rejects %s in every amount field", (bad) => {
    rejects(wireReceipt({ declared_total: bad }));
    rejects(wireReceipt({ fee_total: bad }));
    rejects(withBatch({ net_into_pool: bad }));
    rejects(withBatch({ fee: bad }));
  });
});

describe("counters", () => {
  it("accepts u32 bounds", () => {
    const view = parsePublicReceipt(
      withBatch({ index: 4_294_967_295, shielded_actions: 0, confirmations: 4_294_967_295 }),
    );
    expect(view.batches[0]?.index).toBe(4_294_967_295);
  });

  it.each(["index", "shielded_actions", "confirmations"])("rejects bad values for %s", (key) => {
    for (const bad of [-1, 1.5, "3", 4_294_967_296, Number.NaN]) {
      rejects(withBatch({ [key]: bad }));
    }
  });

  it.each(["index", "confirmations"])("%s can never be null", (key) => {
    rejects(withBatch({ [key]: null }));
  });
});

describe("pool", () => {
  it.each(["ironwood", "orchard"])("accepts %s", (pool) => {
    expect(parsePublicReceipt(withBatch({ pool })).batches[0]?.pool).toBe(pool);
  });

  it.each(["sapling", "Ironwood", "ORCHARD", "", 1])("rejects %j", (pool) => {
    rejects(withBatch({ pool }));
  });
});

describe("identity fields", () => {
  it("accepts exactly the two networks", () => {
    expect(parsePublicReceipt(wireReceipt({ network: "mainnet" })).network).toBe("mainnet");
    for (const bad of ["regtest", "Testnet", "", null]) rejects(wireReceipt({ network: bad }));
  });

  it("accepts campaign ids of the core's alphabet and length", () => {
    for (const id of ["a", "spring-drop_2026.1", "A".repeat(64)]) {
      expect(parsePublicReceipt(wireReceipt({ campaign_id: id })).campaignId).toBe(id);
    }
  });

  it.each(["", "a".repeat(65), "a b", "a/b", "é", "<img>", "a\n"])(
    "rejects campaign id %j",
    (id) => {
      rejects(wireReceipt({ campaign_id: id }));
    },
  );

  it.each([
    "e".repeat(63),
    "e".repeat(65),
    "E".repeat(64),
    `0x${"e".repeat(62)}`,
    "g".repeat(64),
    "",
  ])("rejects manifest commitment %j", (commitment) => {
    rejects(wireReceipt({ manifest_commitment: commitment }));
  });
});

// ---- Facts the verifier could not establish ---------------------------------

describe("null means 'not established' and is part of the contract", () => {
  const unknownBatch = () =>
    wireBatch({
      funding_input: null,
      net_into_pool: null,
      fee: null,
      shielded_actions: null,
      pool: null,
      confirmations: 0,
    });

  it("accepts a batch whose facts are all unknown, keeping only index, txid and confirmations", () => {
    const view = parsePublicReceipt(
      wireReceipt({
        fee_total: null,
        batches: [unknownBatch()],
        phase: { phase: "failed" },
        findings: [{ code: "tx_not_found", batch_index: 0 }],
      }),
    );
    expect(view.batches[0]).toEqual({
      index: 0,
      txid: TXID,
      fundingInput: null,
      netIntoPool: null,
      fee: null,
      shieldedActions: null,
      pool: null,
      confirmations: 0,
    });
    expect(view.feeTotal).toBeNull();
  });

  it("accepts a receipt that does not name its campaign", () => {
    expect(parsePublicReceipt(wireReceipt({ campaign_id: null })).campaignId).toBeNull();
  });

  it.each(["declared_total", "manifest_commitment", "network", "phase", "findings", "batches"])(
    "%s can never be null",
    (key) => {
      rejects(wireReceipt({ [key]: null }));
    },
  );

  it("still insists every key is present: null is explicit, absence is not allowed", () => {
    for (const key of ["campaign_id", "fee_total", "findings"]) {
      rejects(without(wireReceipt(), key));
    }
    for (const key of ["funding_input", "net_into_pool", "fee", "shielded_actions", "pool"]) {
      rejects(wireReceipt({ batches: [without(wireBatch(), key)] }));
    }
  });
});

// ---- Findings ----------------------------------------------------------------

describe("findings", () => {
  it("are mapped to the view, in order", () => {
    const view = parsePublicReceipt(
      wireReceipt({
        phase: { phase: "failed" },
        findings: [
          { code: "balance_mismatch", batch_index: 0 },
          { code: "declared_total_mismatch" },
          { code: "batch_pending", batch_index: 2 },
        ],
      }),
    );
    expect(view.findings).toEqual([
      { code: "balance_mismatch", batchIndex: 0 },
      { code: "declared_total_mismatch" },
      { code: "batch_pending", batchIndex: 2 },
    ]);
  });

  // covers: REQ-PRIV-001
  it.each([
    ["an unknown code", [{ code: "mystery", batch_index: 0 }]],
    ["free text from outside", [{ code: "tx_not_found", batch_index: 0, message: "visit evil.example" }]],
    ["a smuggled address", [{ code: "tx_not_found", batch_index: 0, address: "u1sentineladdress" }]],
    ["a smuggled amount", [{ code: "declared_total_mismatch", amount: "7777001" }]],
    ["a bare string", ["tx_not_found"]],
    ["a non-array", { code: "tx_not_found", batch_index: 0 }],
  ])("refuses %s", (_label, findings) => {
    rejects(wireReceipt({ findings }));
  });
});
