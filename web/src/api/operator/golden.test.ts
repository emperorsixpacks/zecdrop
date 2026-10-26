// The real-chain half of the operator contract. The mock chain cannot produce
// a funding address, a deposit in progress, a wallet mismatch or a viewing key,
// so the operator's own Rust test (crates/drop-operator/tests/api_contract.rs)
// writes them to fixtures/contract/operator/golden/: the real handlers over an
// in-memory real-chain backend. No real node was involved; the addresses and
// the key in those files are placeholders. Every one is parsed here with the
// same strict schemas as the mock chain's captures.

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parsePublicReceipt } from "@/api/types";
import { DISCLOSURE_WARNING } from "@/features/audit/disclosure";
import { describeNearStatus } from "@/features/funding/near/status";
import { explainFailure } from "@/features/operator/messages";
import { between } from "@/test/rust-source";
import { fixtureJson, GOLDEN, GOLDEN_INDEX, goldenJson } from "@/test/operator-fixtures";
import apiSource from "../../../../crates/drop-operator/src/api.rs?raw";

import { OperatorApiError } from "./client";
import { parseNearDryQuote, parseNearLiveQuote, parseNearPreview, parseNearStatus, parseNearTokens } from "./near-schemas";
import { parseCampaign, parseHealth, parseOperatorError, parsePayslipsExport, parseViewingKeyExport } from "./schemas";

const names = GOLDEN_INDEX.map((e) => e.file);

describe("golden/ is complete", () => {
  it("lists exactly the files that are loaded", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([...names].sort());
  });

  it("covers the real-chain states the pages show", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "health-real.json",
        "create-real.json",
        "campaign-real-awaiting-deposit.json",
        "campaign-real-deposit-too-small.json",
        "campaign-real-deposit-shallow.json",
        "campaign-real-funded.json",
        "campaign-real-wrong-wallet.json",
        "audit-ufvk-export.json",
      ]),
    );
  });
});

/** The NEAR Intents routes (funding from another coin). The token list, the preview and the dry
 * quote are captured shapes; the live quote and the statuses were written by the operator's own
 * test from its documentation (they say so in near-schemas.ts). Each is parsed with the strict
 * schemas the panel uses. */
const NEAR = GOLDEN_INDEX.filter((e) => e.path.includes("/near/") || e.path.endsWith("/near"));

describe("the NEAR goldens", () => {
  it("are all there: the token list, a preview, quotes, the eight statuses and the refusals", () => {
    expect(NEAR.length).toBeGreaterThanOrEqual(25);
    for (const file of ["near-tokens.json", "near-preview.json", "near-dry-quote.json", "near-live-quote.json"]) {
      expect(NEAR.map((e) => e.file)).toContain(file);
    }
    expect(NEAR.filter((e) => e.file.startsWith("near-status-")).length).toBe(8);
  });

  for (const entry of NEAR) {
    it(`${entry.file}: ${entry.method} ${entry.path} -> ${String(entry.status)}`, () => {
      const body = goldenJson(entry.file);
      if (entry.status >= 400) {
        const error = parseOperatorError(body);
        expect(error.message.length).toBeGreaterThan(0);
        // The page has a sentence of its own for each refusal, never the generic one.
        const explained = explainFailure(new OperatorApiError("api", entry.status, error));
        expect(explained.title).not.toBe("The operator refused this");
        expect(explained.title).not.toBe("Something went wrong");
        return;
      }
      if (entry.path.endsWith("/near/tokens")) {
        const tokens = parseNearTokens(body);
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens.some((t) => t.symbol === "ZEC")).toBe(false); // never a ZEC asset
      } else if (entry.path.endsWith("/near/preview")) {
        const view = parseNearPreview(body);
        expect(view.amountOut).toBe("545000");
        expect(view.token.symbol).toBe("USDC");
      } else if (entry.path.endsWith("/dry-quote")) {
        expect(parseNearDryQuote(body).validForSeconds).toBe(600);
      } else if (entry.path.endsWith("/live-quote")) {
        const live = parseNearLiveQuote(body);
        expect(live.depositAddress.length).toBeGreaterThan(0);
        expect(live.refundTo.length).toBeGreaterThan(0);
      } else {
        const status = parseNearStatus(body);
        // The file name says which word it carries ("mystery-state" is the operator's word "unknown").
        const word = entry.file.replace(/^near-status-/u, "").replace(/\.json$/u, "").replaceAll("-", "_");
        expect(status.status).toBe(word === "mystery_state" ? "unknown" : word);
      }
    });
  }

  it("not one status, success included, says the campaign is funded", () => {
    for (const entry of NEAR.filter((e) => e.file.startsWith("near-status-"))) {
      const status = parseNearStatus(goldenJson(entry.file));
      expect(status.campaignFunded, entry.file).toBe(false);
      // The page's sentence for the word never says so either.
      const d = describeNearStatus(status.status);
      const said = `${d.title} ${d.detail}`.replace(/\bnot (yet )?(been )?funded\b/giu, "").replace(/\bcount as funded\b/giu, "");
      expect(said, entry.file).not.toMatch(/\bfunded\b/iu);
    }
  });

  it("the live quote's own instructions say the same", () => {
    const raw = goldenJson("near-live-quote.json") as { instructions: string[] };
    expect(raw.instructions.join(" ")).toMatch(/counts as funded only when its deposit is seen on the Zcash chain/u);
  });

  it("a field the page does not know is an error, not quietly dropped", () => {
    expect(() => parseNearPreview({ ...(goldenJson("near-preview.json") as object), surprise: 1 })).toThrow();
    expect(() => parseNearStatus({ ...(goldenJson("near-status-success.json") as object), surprise: 1 })).toThrow();
    expect(() => parseNearLiveQuote({ ...(goldenJson("near-live-quote.json") as object), surprise: 1 })).toThrow();
  });

  it("a status word outside the closed set is an error", () => {
    expect(() => parseNearStatus({ ...(goldenJson("near-status-success.json") as object), status: "SUCCESS" })).toThrow();
    expect(() => parseNearStatus({ ...(goldenJson("near-status-success.json") as object), status: "funded" })).toThrow();
  });
});

describe("every other golden response parses with the strict schemas", () => {
  for (const entry of GOLDEN_INDEX.filter((e) => !NEAR.includes(e))) {
    it(`${entry.file}: ${entry.method} ${entry.path} -> ${String(entry.status)}`, () => {
      const body = goldenJson(entry.file);
      if (entry.status >= 400) {
        const error = parseOperatorError(body);
        expect(error.code.length).toBeGreaterThan(0);
        expect(error.message.length).toBeGreaterThan(0);
        // And the page has a specific sentence for it.
        const explained = explainFailure(new OperatorApiError("api", entry.status, error));
        expect(explained.title).not.toBe("The operator refused this");
        return;
      }
      if (entry.path === "/api/health") expect(parseHealth(body).mock).toBe(false);
      else if (entry.path.endsWith("/audit-ufvk-export")) expect(parseViewingKeyExport(body).ufvk.length).toBeGreaterThan(0);
      else if (entry.path.endsWith("/payslips")) expect(parsePayslipsExport(body).payslips.length).toBeGreaterThan(0);
      else if (entry.path.endsWith("/receipt")) expect(parsePublicReceipt(body).network).toBe("testnet");
      else expect(parseCampaign(body).id).toMatch(/^c-/u);
    });
  }
});

describe("what each real-chain state says", () => {
  const load = (file: string) => parseCampaign(goldenJson(file));

  it("a real chain's health is not the mock chain", () => {
    expect(parseHealth(goldenJson("health-real.json"))).toEqual({ network: "testnet", mock: false });
  });

  it("a campaign made on a real chain has a funding address of its own, and no deposit yet", () => {
    const c = load("create-real.json");
    expect(c.walletMatches).toBe(true);
    expect(c.fundingAddress).not.toBeNull();
    expect(c.funding).toBeNull();
    expect(c.fundingProgress).toBeNull();
    expect(c.phase).toEqual({ phase: "awaiting_funding" });
  });

  it("nothing seen at the address yet: no progress", () => {
    const c = load("campaign-real-awaiting-deposit.json");
    expect(c.fundingAddress).not.toBeNull();
    expect(c.fundingProgress).toBeNull();
    expect(c.funding).toBeNull();
  });

  it("a deposit that is too small does not count", () => {
    const c = load("campaign-real-deposit-too-small.json");
    expect(c.fundingProgress?.sufficient).toBe(false);
    expect(BigInt(c.fundingProgress?.amount ?? "0")).toBeLessThan(BigInt(c.fundingRequired));
    expect(c.funding).toBeNull();
  });

  it("a deposit that is enough but not deep enough is still waiting", () => {
    const c = load("campaign-real-deposit-shallow.json");
    expect(c.fundingProgress?.sufficient).toBe(true);
    expect(c.fundingProgress?.confirmations).toBeLessThan(c.fundingProgress?.requiredDepth ?? 0);
    expect(c.funding).toBeNull();
  });

  it("a deposit at the required depth is recorded as the funding, and progress goes away", () => {
    const c = load("campaign-real-funded.json");
    expect(c.funding).not.toBeNull();
    expect(c.fundingProgress).toBeNull();
    expect(c.phase.phase).toBe("funded");
  });

  it("a campaign made with another wallet has no funding address and says so", () => {
    const c = load("campaign-real-wrong-wallet.json");
    expect(c.walletMatches).toBe(false);
    expect(c.fundingAddress).toBeNull();
  });

  it("has the same fields as a campaign from the mock chain", () => {
    const mock = Object.keys(fixtureJson("campaign-funded.json") as object).sort();
    for (const file of ["create-real.json", "campaign-real-funded.json", "campaign-real-wrong-wallet.json"]) {
      expect(Object.keys(goldenJson(file) as object).sort(), file).toEqual(mock);
    }
  });

  it("and the fields the Rust `CampaignView` declares", () => {
    const declared = [...between(apiSource, "struct CampaignView {", "\n}").matchAll(/^ {4}(?:pub )?([a-z_]+):/gmu)]
      .map((m) => m[1] ?? "")
      .sort();
    expect(Object.keys(goldenJson("create-real.json") as object).sort()).toEqual(declared);
  });
});

describe("the payslips of a settled campaign", () => {
  // covers: REQ-PAY-005
  it("parse strictly: one row per payout, in list order, each payslip read by the payslip page's own reader", () => {
    const answer = parsePayslipsExport(goldenJson("payslips.json"));
    expect(answer.network).toBe("testnet");
    expect(answer.campaignId).toMatch(/^c-/u);
    expect(answer.unmatchedOutputs).toBe(0);
    expect(answer.payslips.map((row) => row.number)).toEqual(answer.payslips.map((_, i) => i + 1));
    for (const row of answer.payslips) {
      expect(row.payslip).not.toBeNull();
      // A payslip proves its own row's amount.
      expect(row.payslip?.value).toBe(row.amount.toString());
    }
  });

  it("an extra field anywhere in the answer is refused, never trimmed", () => {
    const body = goldenJson("payslips.json") as { payslips: Record<string, unknown>[] } & Record<string, unknown>;
    const [first, ...rest] = body.payslips;
    expect(() => parsePayslipsExport({ ...body, seed: "x" })).toThrow(ZodError);
    expect(() => parsePayslipsExport({ ...body, payslips: [{ ...first, name: "x" }, ...rest] })).toThrow(ZodError);
    expect(() => parsePayslipsExport({ ...body, payslips: [{ ...first, payslip: { ...(first?.["payslip"] as object), extra: 1 } }, ...rest] })).toThrow(ZodError);
  });

  it("is refused before every batch is final, with a sentence for the page", () => {
    const error = parseOperatorError(goldenJson("error-not-settled.json"));
    expect(error.code).toBe("not_settled");
    expect(explainFailure(new OperatorApiError("api", 409, error)).title).toBe("Not settled yet");
  });
});

describe("the viewing key", () => {
  it("comes with the operator's disclosure warning, word for word", () => {
    const key = parseViewingKeyExport(goldenJson("audit-ufvk-export.json"));
    expect(key.warning).toBe(DISCLOSURE_WARNING);
    expect(key.network).toBe("testnet");
    expect(key.campaignId).toMatch(/^c-/u);
  });

  it("is refused without the acknowledgement, and the refusal carries the same warning", () => {
    const error = parseOperatorError(goldenJson("error-confirmation-required.json"));
    expect(error).toMatchObject({ code: "confirmation_required", warning: DISCLOSURE_WARNING });
  });

  it("an extra field on the export is refused, never trimmed", () => {
    const body = goldenJson("audit-ufvk-export.json") as object;
    expect(() => parseViewingKeyExport({ ...body, seed: "x" })).toThrow(ZodError);
  });
});

describe("no recipient data in any golden response", () => {
  // The payslips of a settled campaign are the one answer that names payouts on purpose (REQ-PAY-005); the viewing-key
  // export carries a key, not a field. Every other answer must have no such field.
  const EXCEPTIONS = ["payslips.json"];

  it("has no address, amount-per-recipient or memo field anywhere but in the payslips", () => {
    for (const file of Object.keys(GOLDEN).filter((name) => !EXCEPTIONS.includes(name))) {
      const text = GOLDEN[file] ?? "";
      expect(text, file).not.toMatch(/"(recipients?|memo|memos|address|addresses|rows|csv)"\s*:\s*(\[|"|\{)/u);
    }
  });

  // covers: REQ-PAY-005
  it("the payslips golden holds only labelled stand-ins, never a real address", () => {
    const answer = goldenJson("payslips.json") as { payslips: { address: string }[] };
    expect(answer.payslips.length).toBeGreaterThan(0);
    for (const row of answer.payslips) expect(row.address).toMatch(/FAKE/u);
  });
});
