// @vitest-environment jsdom
//
// Copy guard: what a visitor can read must not claim more than a key-less
// verifier can compute. The public can see how much entered the shielded pool,
// in how many outputs, at what fee. It cannot see that the money reached
// different people or matches a payout list; only an auditor can
// (docs/PRIVACY_BOUNDARY.md, docs/LEARNINGS.md).
//
// This renders every page and checks the TEXT A PERSON READS, including
// visually hidden text, for phrases that over-claim.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { OperatorApiError } from "@/api/operator/client";
import { parseCampaign, parseOperatorError, type ProgressEvent } from "@/api/operator/schemas";
import { clearSession } from "@/api/operator/session";
import { describeEvent, describeRun, explainFailure } from "@/features/operator/messages";
import { useWizardDraft } from "@/features/wizard/draft";
import { lensRowsFrom } from "@/features/wizard/list";
import { previewPayouts } from "@/lib/csv-preview";
import { CAMPAIGN_PHASES, phaseLabel, phaseProgress, phaseSentence, type PhaseState } from "@/lib/phase";
import { installFakeOperator, replyWith, replyWithStream, type RouteHandler } from "@/test/fake-operator";
import { CSV, fixtureJson, INDEX } from "@/test/operator-fixtures";
import { BANNED } from "@/test/banned-phrases";
import { readEverything } from "@/test/read-everything";
import { renderApp } from "@/test/render-app";

import { AppRoutes } from "./routes";

const PAGES: [name: string, path: string][] = [
  ["the home page", "/"],
  ["the privacy page", "/privacy"],
  ["the real testnet sample receipt", "/r/demo?demo=real"],
  ["the first real testnet batch", "/r/demo?demo=real-smoke"],
  ["the sample receipt", "/r/demo?demo=1"],
  ["the sample with findings", "/r/demo?demo=findings"],
  ["the sample with a declared-total mismatch", "/r/demo?demo=mismatch"],
  ["an incomplete receipt link", "/r/x"],
  ["the audit page", "/audit"],
  ["the campaigns page", "/campaigns"],
  ["a page that does not exist", "/nope"],
];

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
  useWizardDraft.getState().reset();
});

function textOf(path: string): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const isReceipt = path.startsWith("/r/demo");
  return (isReceipt
    ? screen.findByRole("heading", { level: 2, name: "Status" })
    : screen.findByRole("heading", { level: 1 })
  ).then(() => readEverything());
}

describe.each(PAGES)("%s", (_name, path) => {
  it("makes none of the claims the public cannot back up", async () => {
    const text = await textOf(path);
    expect(text.length).toBeGreaterThan(40);
    for (const [label, pattern] of BANNED) {
      expect(text, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });
});

// The operator pages as a signed-in person sees them, with real captured responses.
const OPERATOR_PAGES: [name: string, path: string, campaign: string, settle: () => Promise<unknown>][] = [
  ["the payouts list", "/campaigns", "campaign-settled.json", () => screen.findByRole("list", { name: "Payouts" })],
  ["stage 1: payouts", "/new", "campaign-settled.json", () => screen.findByText("Drop a CSV here")],
  ["stage 2 without payouts", "/new/check", "campaign-settled.json", () => screen.findByRole("heading", { name: "Add the payouts first" })],
  ["stage 2: check", "/new/check", "create-valid.json", () => screen.findByRole("heading", { name: "Check the payouts" })],
  ["stage 3: send", "/new/send", "create-valid.json", () => screen.findByRole("button", { name: "Record mock deposit" })],
  ["a campaign awaiting funding", "/campaign/c-000000000001", "campaign-awaiting-funding.json", () => screen.findByRole("button", { name: "Record mock deposit" })],
  ["a funded campaign", "/campaign/c-000000000001", "campaign-funded.json", () => screen.findByRole("button", { name: "Send 5 payouts" })],
  ["a running campaign", "/campaign/c-000000000001", "campaign-running.json", () => screen.findByRole("heading", { name: "Sending the payouts" })],
  ["a crashed campaign", "/campaign/c-000000000001", "campaign-crashed.json", () => screen.findByRole("button", { name: "Resume sending" })],
  ["a settled campaign", "/campaign/c-000000000001", "campaign-settled.json", () => screen.findByText("Sealed")],
  ["the audit page", "/audit", "campaign-settled.json", () => screen.findByRole("button", { name: "What the audit checks" })],
];

describe.each(OPERATOR_PAGES)("operator: %s", (_name, path, campaign, settle) => {
  it("makes none of the claims the public cannot back up", async () => {
    const receipt = campaign === "campaign-running.json" ? "receipt-running.json" : "receipt-settled.json";
    const routes: Record<string, RouteHandler> = {
      "GET /api/health": () => replyWith("health.json"),
      "GET /api/campaigns": () => replyWith("campaigns-list.json"),
      "GET /api/campaigns/:id": () => replyWith(campaign),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => replyWith(receipt),
    };
    installFakeOperator(routes);
    if (_name === "stage 2: check" || _name === "stage 3: send") {
      const preview = previewPayouts(CSV["valid.csv"] ?? "");
      useWizardDraft.getState().campaignCreated(parseCampaign(fixtureJson("create-valid.json")), preview.kind === "rows" ? lensRowsFrom(preview.rows) : null);
    }
    renderApp(path, { signedIn: true });
    await settle();
    await waitFor(() => {
      expect(screen.queryByText(/^Loading|Getting the receipt/u)).toBeNull();
    });

    const text = await readEverything();
    expect(text.length).toBeGreaterThan(200);
    for (const [label, pattern] of BANNED) {
      expect(text, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });
});

describe("the operator's wording", () => {
  const read = (words: string) => {
    for (const [label, pattern] of BANNED) expect(words, `contains the banned claim: ${label}`).not.toMatch(pattern);
  };

  it("every explanation of a real operator error", () => {
    for (const entry of INDEX.filter((e) => e.status >= 400 && e.status !== 401)) {
      const explained = explainFailure(new OperatorApiError("api", entry.status, parseOperatorError(fixtureJson(entry.file))));
      read(`${explained.title} ${explained.detail}`);
    }
  });

  it("every run state", () => {
    for (const run of [
      { state: "idle" },
      { state: "running" },
      { state: "settled" },
      { state: "halted" },
      { state: "stalled", error: "the node is unreachable." },
      { state: "crashed" },
    ] as const) {
      const d = describeRun(run);
      read(`${d.label} ${d.detail} ${d.action}`);
    }
  });

  it("every progress event", () => {
    const events: ProgressEvent[] = [
      { event: "built", batchIndex: 0, txid: "a".repeat(64), outputs: 3 },
      { event: "broadcast", batchIndex: 0, txid: "a".repeat(64) },
      { event: "confirmed", batchIndex: 0, txid: "a".repeat(64), depth: 3, requiredDepth: 3 },
      { event: "waiting", batchIndex: 0, observedDepth: 1, requiredDepth: 3 },
      { event: "failed", batchIndex: 0, reason: "rejected" },
      { event: "halted", failedBatches: [0] },
      { event: "settled", campaignId: "c-1", batches: 2 },
    ];
    for (const event of events) read(describeEvent(event));
  });
});

describe("every status sentence a campaign can show", () => {
  const states: PhaseState[] = [
    { phase: "draft" },
    { phase: "awaiting_funding" },
    { phase: "funded" },
    { phase: "sending", done: 1, total: 3 },
    { phase: "settled" },
    { phase: "failed" },
  ];

  it("covers every phase", () => {
    expect(states.map((s) => s.phase).sort()).toEqual([...CAMPAIGN_PHASES].sort());
  });

  it.each(states)("%o", (state) => {
    const words = [phaseLabel(state.phase), phaseSentence(state), phaseProgress(state) ?? ""].join(" ");
    for (const [label, pattern] of BANNED) {
      expect(words, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });
});

describe("the guard itself", () => {
  const caught = (sentence: string) => BANNED.some(([, pattern]) => pattern.test(sentence));

  it.each([
    "Verified payouts, on-chain.",
    "Everyone was paid.",
    "The campaign paid out exactly what it was funded.",
    "All recipients were paid.",
    "Complete: all payouts confirmed",
    "The money reached the recipients.",
    "We verify that the funds reached each person.",
    "Payments are guaranteed.",
  ])("catches %j", (sentence) => {
    expect(caught(sentence)).toBe(true);
  });

  it.each([
    "How much entered the shielded pool, in how many outputs, and what it cost.",
    "Only an auditor holding the campaign's viewing key can confirm the count and the sum.",
    "Complete: all batches confirmed",
    "That the shielded value reached different people, or that it matches a payout list.",
  ])("lets the honest sentence %j through", (sentence) => {
    // The last one NAMES the claim in order to deny it; it must not trip the guard.
    expect(caught(sentence)).toBe(false);
  });
});
