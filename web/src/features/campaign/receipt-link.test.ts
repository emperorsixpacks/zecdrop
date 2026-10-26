import { describe, expect, it } from "vitest";

import { parseReceiptLink } from "@/api/receipt-query";
import { parsePublicReceipt, type PublicReceipt } from "@/api/types";
import { fixtureJson } from "@/test/operator-fixtures";

import { receiptLinkPath, withPublicHost } from "./receipt-link";

const receipt = (file = "receipt-settled.json"): PublicReceipt => parsePublicReceipt(fixtureJson(file));

describe("receiptLinkPath", () => {
  it("builds /r/<id>?network&tx…&commitment&declared_total from the operator's receipt", () => {
    const r = receipt();
    const link = receiptLinkPath("c-000000000001", r);
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    expect(link.txCount).toBe(2);

    const [path, query] = link.path.split("?");
    expect(path).toBe("/r/c-000000000001");
    expect(parseReceiptLink(new URLSearchParams(query))).toEqual({
      ok: true,
      query: {
        network: r.network,
        txids: r.batches.map((b) => b.txid),
        commitment: r.manifestCommitment,
        declaredTotal: r.declaredTotal,
      },
    });
  });

  it("puts the transactions in batch order", () => {
    const link = receiptLinkPath("c-1", receipt());
    expect(link.ok && link.path.indexOf("tx=a0a0")).toBeLessThan(link.ok ? link.path.indexOf("tx=a1a1") : 0);
  });

  it("encodes an id that is not path-safe", () => {
    const link = receiptLinkPath("a/b c", receipt());
    expect(link.ok && link.path.startsWith("/r/a%2Fb%20c?")).toBe(true);
  });

  it("offers nothing until every batch has a transaction id", () => {
    const base = fixtureJson("receipt-settled.json") as { batches: Record<string, unknown>[] };
    const partial = parsePublicReceipt({ ...base, batches: base.batches.map((b, i) => (i === 1 ? { ...b, txid: null } : b)) });
    expect(receiptLinkPath("c-1", partial)).toEqual({ ok: false, reason: "some_batches_not_built" });
    expect(receiptLinkPath("c-1", { ...receipt(), batches: [] })).toEqual({ ok: false, reason: "no_transactions_yet" });
  });

  it("carries no field a recipient could be put in", () => {
    const link = receiptLinkPath("c-1", receipt());
    const params = new URLSearchParams(link.ok ? link.path.split("?")[1] : "");
    expect([...new Set(params.keys())].sort()).toEqual(["commitment", "declared_total", "network", "tx"]);
  });
});

describe("withPublicHost", () => {
  it("is the path alone, and says so, without a configured host", () => {
    expect(withPublicHost("/r/x?y=1", null)).toEqual({ text: "/r/x?y=1", complete: false });
  });

  it("puts the host in front when there is one", () => {
    expect(withPublicHost("/r/x?y=1", "https://verify.example.org")).toEqual({
      text: "https://verify.example.org/r/x?y=1",
      complete: true,
    });
  });
});
