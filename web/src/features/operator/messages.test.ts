import { describe, expect, it } from "vitest";

import { OperatorApiError } from "@/api/operator/client";
import { KNOWN_ERROR_CODES, parseOperatorError, parseProgressEvent, type RunState } from "@/api/operator/schemas";
import { fixtureJson, INDEX } from "@/test/operator-fixtures";
import { SseParser } from "@/api/operator/events";
import { FIXTURES } from "@/test/operator-fixtures";

import { describeEvent, describeRun, explainFailure, explainStatus } from "./messages";
import apiSource from "../../../../crates/drop-operator/src/api.rs?raw";
import httpSource from "../../../../crates/drop-operator/src/http.rs?raw";
import guardSource from "../../../../crates/drop-operator/src/guard.rs?raw";
import stateSource from "../../../../crates/drop-operator/src/state.rs?raw";

const GENERIC = "The operator refused this";

describe("explainFailure", () => {
  const api = (file: string, status: number) =>
    new OperatorApiError("api", status, parseOperatorError(fixtureJson(file)));

  it("gives every error the real operator produced a specific, human sentence", () => {
    const failures = INDEX.filter((e) => e.status >= 400 && e.status !== 401);
    expect(failures.length).toBeGreaterThanOrEqual(20);
    for (const entry of failures) {
      const explained = explainFailure(api(entry.file, entry.status));
      expect(explained.title, entry.file).not.toBe(GENERIC);
      expect(explained.title.length, entry.file).toBeGreaterThan(8);
      expect(explained.detail.length, entry.file).toBeGreaterThan(8);
    }
  });

  it("never shows a raw error code", () => {
    for (const entry of INDEX.filter((e) => e.status >= 400)) {
      const explained = explainFailure(
        entry.status === 401 ? new OperatorApiError("unauthorized", 401) : api(entry.file, entry.status),
      );
      expect(`${explained.title} ${explained.detail}`, entry.file).not.toMatch(/[a-z]+_[a-z]+_?[a-z]*/u);
    }
  });

  it("says how much was needed and how much was given, in TAZ", () => {
    expect(explainFailure(api("fund-insufficient.json", 422))).toEqual({
      title: "The deposit is too small",
      detail: "The campaign needs 11.62535 TAZ (the total plus fees). This deposit is 0.00001 TAZ.",
    });
  });

  it("names the deposit that is already recorded", () => {
    expect(explainFailure(api("fund-conflict.json", 409)).detail).toBe(
      "This campaign already has a deposit of 11.62535 TAZ. It cannot be changed.",
    );
  });

  it("passes on the operator's own reason when the campaign's account cannot be set up", () => {
    const error = new OperatorApiError("api", 500, {
      code: "account_registry_error",
      message: "the account registry is full; no campaign was created",
    });
    expect(explainFailure(error)).toEqual({
      title: "The campaign's account could not be set up",
      detail: "the account registry is full; no campaign was created. The operator's terminal has more detail.",
    });
  });

  it("an insufficient_funding answer without figures still reads well", () => {
    const error = new OperatorApiError("api", 409, { code: "insufficient_funding", message: "the recorded deposit does not cover this plan" });
    expect(explainFailure(error).detail).toBe("the recorded deposit does not cover this plan");
  });

  it("treats a rejected or missing token as 'open the link again'", () => {
    for (const kind of ["no_token", "unauthorized"] as const) {
      const explained = explainFailure(new OperatorApiError(kind));
      expect(explained.title).toMatch(/link/u);
      expect(explained.detail).toMatch(/terminal/u);
    }
  });

  it("separates 'the operator is down' from 'the operator said no'", () => {
    expect(explainFailure(new OperatorApiError("unreachable")).title).toBe("Can't reach the operator");
    expect(explainFailure(new OperatorApiError("invalid_response")).title).toMatch(/does not understand/u);
  });

  it("for a code it does not know, uses the operator's own words under a heading chosen by status", () => {
    const unknown = (status: number) =>
      explainFailure(new OperatorApiError("api", status, { code: "brand_new_code", message: "Something specific." }));
    expect(unknown(422)).toEqual({ title: "The operator can't do that", detail: "Something specific." });
    expect(unknown(409).title).toBe("The operator can't do that");
    expect(unknown(400).title).toBe("The operator did not accept this request");
    expect(unknown(403).title).toBe("The operator refused this");
    expect(unknown(404).title).toBe("Not found");
    expect(unknown(421).title).toBe("The operator does not accept this address");
    expect(unknown(500).title).toBe("The operator hit a problem");
    expect(unknown(503).title).toBe("The operator hit a problem");
    expect(unknown(418)).toEqual({ title: GENERIC, detail: "Something specific." });
    // The code itself is never what a person reads.
    for (const status of [400, 403, 404, 409, 421, 422, 500, 503, 418]) {
      expect(JSON.stringify(unknown(status))).not.toContain("brand_new_code");
    }
  });

  it("for an error with no envelope, explains the status alone", () => {
    const bare = (status: number) => explainFailure(new OperatorApiError("api", status, null));
    expect(bare(421)).toEqual({
      title: "The operator does not accept this address",
      detail: "Open the link the operator printed in its terminal; it uses the address the operator expects.",
    });
    expect(bare(502).title).toBe("The operator hit a problem");
    expect(bare(403).title).toBe("The operator refused this");
    expect(explainStatus(null)).toEqual({ title: GENERIC, detail: "No reason was given." });
  });

  it("has a specific sentence for every error code the operator source can raise", () => {
    // A drift alarm: if the core adds an error code, this fails until the web
    // says something useful about it instead of the generic refusal.
    const sources = [apiSource, httpSource, stateSource, guardSource].join("\n");
    const codes = new Set<string>();
    for (const m of sources.matchAll(/ApiError::(?:conflict|bad_request|unprocessable|forbidden)\(\s*"([a-z_]+)"/gu)) codes.add(m[1] ?? "");
    for (const m of sources.matchAll(/ApiError::new\(\s*[^,"]+(?:::[A-Z_]+)?,\s*"([a-z_]+)"/gu)) codes.add(m[1] ?? "");
    for (const m of sources.matchAll(/ApiError::not_found\(/gu)) if (m) codes.add("not_found");
    codes.add("internal_error");
    // The client turns every 401 into the `unauthorized` kind before any code is read.
    codes.delete("unauthorized");
    expect([...codes].length).toBeGreaterThanOrEqual(15);
    for (const code of codes) {
      // Known to the schema (so parsed strictly), and given a sentence of its own. Status 418 is
      // one no status rule covers, so only a code-specific sentence can avoid the generic title.
      expect(KNOWN_ERROR_CODES as readonly string[], `${code} is raised by the operator but not in KNOWN_ERROR_CODES`).toContain(code);
      const explained = explainFailure(new OperatorApiError("api", 418, { code, message: "x" }));
      expect(explained.title, code).not.toBe(GENERIC);
      expect(`${explained.title} ${explained.detail}`, code).not.toMatch(/[a-z]+_[a-z]+/u);
    }
  });

  it("every code the page knows has a sentence of its own", () => {
    for (const code of KNOWN_ERROR_CODES) {
      if (code === "unauthorized") continue; // the client turns every 401 into its own kind
      const explained = explainFailure(new OperatorApiError("api", 418, { code, message: "x" }));
      expect(explained.title, code).not.toBe(GENERIC);
    }
  });

  it("copes with a non-operator error", () => {
    expect(explainFailure(new Error("boom")).title).toBe("Something went wrong");
    expect(explainFailure("text").title).toBe("Something went wrong");
  });
});

describe("describeRun", () => {
  const states: RunState[] = [
    { state: "idle" },
    { state: "running" },
    { state: "settled" },
    { state: "halted" },
    { state: "stalled", error: "the node is unreachable." },
    { state: "crashed" },
  ];

  it.each(states)("%o has a label, a detail, and an honest action", (run) => {
    const d = describeRun(run);
    expect(d.label.length).toBeGreaterThan(3);
    expect(d.detail.length).toBeGreaterThan(10);
    expect(d.canStart).toBe(d.action.length > 0);
  });

  it("only offers to start when starting does something", () => {
    expect(states.filter((s) => describeRun(s).canStart).map((s) => s.state)).toEqual(["idle", "stalled", "crashed"]);
  });

  it("promises no double-building, which is what the engine guarantees (REQ-RES-001)", () => {
    expect(describeRun({ state: "crashed" }).detail).toMatch(/never built a second time/u);
    expect(describeRun({ state: "stalled", error: "x." }).detail).toMatch(/nothing is built twice/u);
  });

  it("includes the stall's own error text", () => {
    expect(describeRun({ state: "stalled", error: "the node is unreachable." }).detail).toContain("the node is unreachable.");
  });
});

describe("describeEvent over a real run", () => {
  const events = (() => {
    const out: ReturnType<typeof parseProgressEvent>[] = [];
    new SseParser((m) => out.push(parseProgressEvent(JSON.parse(m.data)))).push(FIXTURES["events-settled.sse.txt"] ?? "");
    return out;
  })();

  it("has a sentence for every event, and none shows a txid or a raw field name", () => {
    expect(events.length).toBeGreaterThan(6);
    for (const event of events) {
      const text = describeEvent(event);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/[0-9a-f]{16}/u);
      expect(text).not.toMatch(/batch_index|required_depth|observed_depth/u);
    }
  });

  it("reads naturally for the key moments", () => {
    expect(describeEvent({ event: "built", batchIndex: 0, txid: "a".repeat(64), outputs: 3 })).toBe(
      "Batch 0: transaction built (3 shielded outputs).",
    );
    expect(describeEvent({ event: "broadcast", batchIndex: 1, txid: "a".repeat(64) })).toBe("Batch 1: sent to the network.");
    expect(describeEvent({ event: "confirmed", batchIndex: 0, txid: "a".repeat(64), depth: 2, requiredDepth: 3 })).toBe(
      "Batch 0: 2 of 3 confirmations.",
    );
    expect(describeEvent({ event: "waiting", batchIndex: 1, observedDepth: 0, requiredDepth: 3 })).toBe(
      "Batch 1: waiting for the next block (0 of 3 confirmations).",
    );
    expect(describeEvent({ event: "settled", campaignId: "c-1", batches: 2 })).toBe("All 2 batches are confirmed.");
    expect(describeEvent({ event: "settled", campaignId: "c-1", batches: 1 })).toBe("All 1 batch is confirmed.");
  });

  it("failures name the batch and carry the reason", () => {
    expect(describeEvent({ event: "failed", batchIndex: 2, reason: "rejected by the node" })).toBe("Batch 2: failed. rejected by the node");
    expect(describeEvent({ event: "halted", failedBatches: [2] })).toBe("Stopped: batch 2 failed and needs attention.");
    expect(describeEvent({ event: "halted", failedBatches: [1, 3] })).toBe("Stopped: batches 1, 3 failed and need attention.");
  });

  it("never claims money reached anyone", () => {
    for (const event of events) expect(describeEvent(event)).not.toMatch(/paid|received|delivered|reached/iu);
  });
});
