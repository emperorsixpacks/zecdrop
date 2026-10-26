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
import { explainFailure } from "@/features/operator/messages";
import { between } from "@/test/rust-source";
import { fixtureJson, GOLDEN, GOLDEN_INDEX, goldenJson } from "@/test/operator-fixtures";
import apiSource from "../../../../crates/drop-operator/src/api.rs?raw";

import { OperatorApiError } from "./client";
import { parseCampaign, parseHealth, parseOperatorError, parseViewingKeyExport } from "./schemas";

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

describe("every golden response parses with the strict schemas", () => {
  for (const entry of GOLDEN_INDEX) {
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
  it("has no address, amount-per-recipient or memo field anywhere", () => {
    for (const file of Object.keys(GOLDEN)) {
      const text = GOLDEN[file] ?? "";
      expect(text, file).not.toMatch(/"(recipients?|memo|memos|address|addresses|rows|csv)"\s*:\s*(\[|"|\{)/u);
    }
  });
});
