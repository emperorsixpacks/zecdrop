import { describe, expect, it } from "vitest";

import { goldenJson } from "@/test/operator-fixtures";

import { parseNearDryQuote, parseNearLiveQuote, parseNearPreview, parseNearStatus, parseNearTokens } from "./near-schemas";
import { parseOperatorError } from "./schemas";

const golden = (file: string) => goldenJson(file) as Record<string, unknown>;

describe("the asset list", () => {
  it("is read into the panel's own shape", () => {
    const tokens = parseNearTokens(golden("near-tokens.json"));
    const first = tokens[0];
    expect(typeof first?.id).toBe("string");
    expect(typeof first?.symbol).toBe("string");
    expect(typeof first?.chain).toBe("string");
    expect(first?.decimals).toBeGreaterThanOrEqual(0);
  });

  it("refuses an asset whose name is not plain text", () => {
    const body = { count: 1, tokens: [{ asset_id: "a b", blockchain: "near", decimals: 6, symbol: "<b>" }] };
    expect(() => parseNearTokens(body)).toThrow();
  });
});

describe("prices", () => {
  it("a preview carries the campaign's size back in zatoshi, as text", () => {
    const view = parseNearPreview(golden("near-preview.json"));
    expect(view.amountOut).toBe("545000");
    expect(view.amountIn).toBe("7679013");
    expect(view.timeEstimateSeconds).toBe(135);
  });

  it("a preview that is not marked as one is refused", () => {
    expect(() => parseNearPreview({ ...golden("near-preview.json"), preview: false })).toThrow();
  });

  it("a dry quote that is not marked dry is refused", () => {
    expect(() => parseNearDryQuote({ ...golden("near-dry-quote.json"), dry: false })).toThrow();
  });

  it("an amount that is not whole digits is refused", () => {
    expect(() => parseNearPreview({ ...golden("near-preview.json"), amount_in: "7.5" })).toThrow();
    expect(() => parseNearPreview({ ...golden("near-preview.json"), amount_in: "-1" })).toThrow();
    expect(() => parseNearPreview({ ...golden("near-preview.json"), amount_out_zat: "1e5" })).toThrow();
  });
});

describe("the deposit address", () => {
  it("is plain text only: an address with markup or spaces is refused", () => {
    for (const bad of ["<script>x</script>", "two words", "a/b", ""]) {
      expect(() => parseNearLiveQuote({ ...golden("near-live-quote.json"), deposit_address: bad }), bad).toThrow();
    }
  });

  it("a live quote not marked live is refused", () => {
    expect(() => parseNearLiveQuote({ ...golden("near-live-quote.json"), live: false })).toThrow();
  });

  it("the memo is plain text or null", () => {
    expect(parseNearLiveQuote({ ...golden("near-live-quote.json"), deposit_memo: "memo-123" }).depositMemo).toBe("memo-123");
    expect(() => parseNearLiveQuote({ ...golden("near-live-quote.json"), deposit_memo: "a memo" })).toThrow();
  });
});

describe("the swap's status", () => {
  it("is one of the operator's words, with a step that says what to do", () => {
    const status = parseNearStatus(golden("near-status-incomplete-deposit.json"));
    expect(status).toEqual(expect.objectContaining({ status: "incomplete_deposit", step: "top_up_or_await_refund", campaignFunded: false }));
  });

  it("carries the transactions the service names, as 64-digit hex", () => {
    const status = parseNearStatus(golden("near-status-success.json"));
    expect(status.zecTxids).toEqual(["a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"]);
    expect(() => parseNearStatus({ ...golden("near-status-success.json"), zec_txids: ["not-hex"] })).toThrow();
  });

  it("a campaign the operator calls funded is read as that and nothing more: the page never says so for the service", () => {
    const status = parseNearStatus({ ...golden("near-status-success.json"), campaign_funded: true });
    expect(status.campaignFunded).toBe(true);
  });
});

describe("a deposit address the operator could not keep", () => {
  it("is read with its address and deadline, so the page can say them", () => {
    const error = parseOperatorError({
      error: { code: "near_quote_not_saved", message: "kept nowhere", deposit_address: "stranded-address.near", deadline: "2030-01-01T12:00:00Z" },
    });
    expect(error).toEqual({ code: "near_quote_not_saved", message: "kept nowhere", depositAddress: "stranded-address.near", deadline: "2030-01-01T12:00:00Z" });
  });

  it("a deadline the service did not give is null", () => {
    const error = parseOperatorError({ error: { code: "near_quote_not_saved", message: "m", deposit_address: "a.near", deadline: null } });
    expect(error).toEqual(expect.objectContaining({ deadline: null }));
  });

  it("an unknown extra field on it is an error, not dropped", () => {
    expect(() =>
      parseOperatorError({ error: { code: "near_quote_not_saved", message: "m", deposit_address: "a.near", deadline: null, extra: 1 } }),
    ).toThrow();
  });
});
