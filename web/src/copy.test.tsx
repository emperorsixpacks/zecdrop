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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { OperatorApiError } from "@/api/operator/client";
import { parseCampaign, parseOperatorError, type ProgressEvent } from "@/api/operator/schemas";
import { clearSession } from "@/api/operator/session";
import { parsePayslipAnswer, PAYSLIP_INVALID_REASONS, PAYSLIP_NOT_PROVEN } from "@/api/payslip-answer";
import { PAYSLIP_PROBLEM_TEXT } from "@/api/payslip-input";
import { payslipLink } from "@/api/payslip-link";
import { SAMPLE_PAYSLIP_TEXT, samplePayslip } from "@/api/payslip-sample";
import { classifyAddress } from "@/lib/address-shape";
import { describeEvent, describeRun, explainFailure } from "@/features/operator/messages";
import { BUTTONS_HINT, describeShape, FEEDBACK_TEXT, PROMISE, SHAPE_NOTE, shareText, WHY_TEXT } from "@/features/get-paid/wording";
import { FAILURE_TEXT, INVALID_TEXT, LINK_FEEDBACK, LINK_NOTICE, LINK_PROBLEM, LINK_WARNING, LOOPBACK_NOTE, QR_CAPTION, SHARE_TEXT, wording } from "@/features/payslip/wording";
import { useWizardDraft } from "@/features/wizard/draft";
import { lensRowsFrom } from "@/features/wizard/list";
import { previewPayouts } from "@/lib/csv-preview";
import { CAMPAIGN_PHASES, phaseLabel, phaseProgress, phaseSentence, type PhaseState } from "@/lib/phase";
import { installFakeOperator, replyWith, replyWithStream, type RouteHandler } from "@/test/fake-operator";
import { CSV, fixtureJson, goldenJson, INDEX } from "@/test/operator-fixtures";
import { BANNED } from "@/test/banned-phrases";
import { readEverything } from "@/test/read-everything";
import { renderApp } from "@/test/render-app";

import { AppRoutes } from "./routes";

const PAGES: [name: string, path: string][] = [
  ["the home page", "/"],
  ["the privacy page", "/privacy"],
  ["the payslip page", "/payslip"],
  ["the get-paid page", "/get-paid"],
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

// What the receipt page says when the verifier gives no receipt, one sentence per kind of refusal.
describe.each([
  ["a verifier that does not serve the link's network", 400, { error: { code: "network_not_configured", message: "x" } }, "This verifier does not serve that network"],
  ["a request the verifier refused as malformed", 400, { error: { code: "invalid_parameter", message: "x" } }, "The verifier couldn't read this link"],
  ["transactions the verifier has no record of", 404, {}, "The verifier has no record of these transactions"],
] as const)("the receipt page with %s", (_name, status, body, title) => {
  it("makes none of the claims the public cannot back up", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/r/x?network=mainnet&tx=${"a".repeat(64)}&commitment=${"e".repeat(64)}&declared_total=1`]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: title });
    const text = await readEverything();
    expect(text.length).toBeGreaterThan(40);
    for (const [label, pattern] of BANNED) {
      expect(text, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });
});

// What the payslip page says when the verifier answers a payslip, for every verdict, and when it gives no answer.
describe("the payslip page, after a check", () => {
  const slip = samplePayslip();
  const answer = (change: Record<string, unknown>) => ({
    network: slip.network,
    txid: slip.txid,
    action: slip.action,
    verdict: "verified",
    reason: null,
    confirmations: 19,
    required_depth: 3,
    ironwood_actions: 8,
    not_proven: [...PAYSLIP_NOT_PROVEN],
    ...change,
  });
  const none = { confirmations: null, ironwood_actions: null };
  const cases: [name: string, status: number, body: unknown, heading: string][] = [
    ["a verified payslip", 200, answer({}), "Verified"],
    ["a pending payslip", 200, answer({ verdict: "pending", confirmations: 1 }), "Matches, not final yet"],
    ["a transaction the verifier cannot find", 200, answer({ verdict: "not_found", ...none }), "Transaction not found"],
    ...PAYSLIP_INVALID_REASONS.map((reason): [string, number, unknown, string] => [
      `an invalid payslip (${reason})`,
      200,
      answer({ verdict: "invalid", reason, ...none }),
      "Not verified",
    ]),
    ["a verifier that is not set up for the network", 400, { error: { code: "network_not_configured", message: "x" } }, "This verifier does not serve testnet"],
    ["a verifier that cannot read the chain", 503, { error: { code: "chain_unavailable", message: "x" } }, "The verifier can't read the chain right now"],
    ["a verifier that is busy", 503, { error: { code: "overloaded", message: "x" } }, "The verifier can't be reached right now"],
    ["a payslip the verifier does not accept", 400, { error: { code: "invalid_payslip", message: "x" } }, "The verifier did not accept this payslip"],
    ["a request the verifier calls too large", 413, { error: { code: "payload_too_large", message: "x" } }, "The verifier says the request is too large"],
    ["an answer in the wrong format", 200, { hello: "there" }, "The verifier's answer wasn't in the expected format"],
  ];

  it.each(cases)("%s: makes none of the claims the public cannot back up", async (_name, status, body, heading) => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/payslip"]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Payslip"), { target: { value: SAMPLE_PAYSLIP_TEXT } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Check payslip" }));
    await screen.findByRole("heading", { level: 2, name: heading });

    const text = await readEverything();
    expect(text.length).toBeGreaterThan(40);
    for (const [label, pattern] of BANNED) {
      expect(text, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });

  const read = (words: string) => {
    for (const [label, pattern] of BANNED) expect(words, `contains the banned claim: ${label}`).not.toMatch(pattern);
  };

  it("every sentence it can say about an answer", () => {
    for (const reason of PAYSLIP_INVALID_REASONS) read(INVALID_TEXT[reason]);
    for (const change of [{}, { verdict: "pending", confirmations: 0 }, { verdict: "not_found", ...none }]) {
      const said = wording(parsePayslipAnswer(answer(change)));
      read(`${said.heading} ${said.lines.join(" ")}`);
    }
  });

  it("every sentence it can say about a check that gets no answer, and about a paste it refuses", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      for (const say of Object.values(FAILURE_TEXT)) {
        const said = say(network);
        read(`${said.title} ${said.text}`);
      }
    }
    for (const sentence of Object.values(PAYSLIP_PROBLEM_TEXT)) read(sentence);
  });
});

// What the payslip page says about a payslip as a link or a QR code, and about a link that does not hold one.
describe("the payslip page, with a link", () => {
  const link = payslipLink(samplePayslip(), "https://zecdrop.example");
  const fragment = link.slice(link.indexOf("#"));

  it.each([
    ["opened from a link", `/payslip${fragment}`],
    ["opened from a link that holds no payslip", "/payslip#payslip=%%%"],
  ])("%s: makes none of the claims the public cannot back up", async (_name, path) => {
    const words = await textOf(path);
    expect(words.length).toBeGreaterThan(200);
    for (const [label, pattern] of BANNED) {
      expect(words, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });

  it("with the link and its QR code shown: makes none of the claims the public cannot back up", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/payslip"]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Payslip"), { target: { value: SAMPLE_PAYSLIP_TEXT } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Make a link" }));
    await user.click(screen.getByRole("button", { name: "Show QR code" }));
    await screen.findByRole("img", { name: "QR code of the payslip link" });

    const words = await readEverything();
    expect(words).toContain(LINK_WARNING);
    for (const [label, pattern] of BANNED) {
      expect(words, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });

  it("every sentence it can say about a link", () => {
    for (const sentence of [LINK_WARNING, LINK_NOTICE, LINK_PROBLEM, QR_CAPTION, LOOPBACK_NOTE, SHARE_TEXT, ...Object.values(LINK_FEEDBACK)]) {
      for (const [label, pattern] of BANNED) expect(sentence, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });
});

// What the get-paid page says about each address a person can paste, and what it says after Share or Copy.
describe("the get-paid page, after an address is pasted", () => {
  const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const addresses: [name: string, text: string][] = [
    ["a real-money unified address", `u1${BECH32.repeat(4).slice(0, 104)}`],
    ["a testnet address", `utest1${BECH32.repeat(4).slice(0, 104)}`],
    ["a transparent address", "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L"],
    ["a Sapling address", `zs1${BECH32.repeat(3).slice(0, 75)}`],
    ["something that is not an address", "hello there"],
    ["an address that is too short", "u1qpz"],
    ["an address in mixed case", `U1${BECH32.repeat(4).slice(0, 104)}`],
  ];

  it.each(addresses)("%s: makes none of the claims the public cannot back up", async (_name, text) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/get-paid"]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Your address"), { target: { value: text } });
    await screen.findByTestId("shape");

    const words = await readEverything();
    expect(words.length).toBeGreaterThan(200);
    for (const [label, pattern] of BANNED) {
      expect(words, `contains the banned claim: ${label}`).not.toMatch(pattern);
    }
  });

  const read = (words: string) => {
    for (const [label, pattern] of BANNED) expect(words, `contains the banned claim: ${label}`).not.toMatch(pattern);
  };

  it("every sentence it can say about an address", () => {
    for (const [, text] of addresses) {
      const said = describeShape(classifyAddress(text));
      if (said !== null) read(`${said.title} ${said.text}`);
    }
    for (const sentence of Object.values(WHY_TEXT)) read(sentence);
    read(`${PROMISE} ${SHAPE_NOTE} ${BUTTONS_HINT}`);
  });

  it("every sentence it can say after Share or Copy, and what it shares", () => {
    for (const sentence of Object.values(FEEDBACK_TEXT)) read(sentence);
    read(shareText("u1".padEnd(106, "q")));
  });
});

// The operator pages as a signed-in person sees them, with real captured responses.
const OPERATOR_PAGES: [name: string, path: string, campaign: string, settle: () => Promise<unknown>][] = [
  ["the payouts list", "/campaigns", "campaign-settled.json", () => screen.findByRole("list", { name: "Payouts" })],
  ["stage 1: payouts", "/new", "campaign-settled.json", () => screen.findByTestId("people-list")],
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

describe("operator: a funded mainnet campaign", () => {
  it("reads, with its sheet open, none of the claims the public cannot back up", async () => {
    installFakeOperator({
      "GET /api/health": () => ({ body: { ...(goldenJson("health-real.json") as object), network: "mainnet" } }),
      "GET /api/campaigns/:id": () => ({ body: { ...(goldenJson("campaign-real-funded.json") as object), network: "mainnet" } }),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
    });
    renderApp("/campaign/c-000000000001", { signedIn: true });
    await screen.findByRole("button", { name: "Send 3 payouts" });

    const text = await readEverything();
    expect(text).toContain("This sends real ZEC and cannot be undone");
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

  it("the sentence for a mainnet campaign over the operator's limit", () => {
    const over = new OperatorApiError("api", 422, {
      code: "mainnet_cap_exceeded",
      message:
        "this operator caps a mainnet campaign at 0.1 ZEC of funding and this one needs 0.5 ZEC; raise the cap with --mainnet-max-funding-zat (in zatoshi) only if you mean to",
    });
    const explained = explainFailure(over, "ZEC");
    read(`${explained.title} ${explained.detail}`);
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
