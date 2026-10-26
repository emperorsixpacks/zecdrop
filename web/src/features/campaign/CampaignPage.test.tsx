// @vitest-environment jsdom
//
// The campaign page against the operator's CAPTURED responses. Each campaign
// state in fixtures/contract/operator is opened as a person would see it.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseReceiptLink } from "@/api/receipt-query";
import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import {
  FIXTURE_CAMPAIGN_ID,
  installFakeOperator,
  replyWith,
  replyWithGolden,
  replyWithStream,
  type FakeOperator,
  type RouteHandler,
} from "@/test/fake-operator";
import { fixtureJson, goldenJson } from "@/test/operator-fixtures";
import { renderApp } from "@/test/render-app";

const ID = FIXTURE_CAMPAIGN_ID;
const PATH = `/campaign/${ID}`;

const mockHealth: RouteHandler = () => replyWith("health.json");
const realHealth: RouteHandler = () => replyWithGolden("health-real.json");

type Json = Record<string, unknown>;

/** A captured campaign with some fields changed (for states the mock chain cannot produce). */
const campaignWith = (file: string, patch: Json): Json => ({ ...(fixtureJson(file) as Json), ...patch });

let operator: FakeOperator;

function open(routes: Record<string, RouteHandler>, health: RouteHandler = mockHealth) {
  operator = installFakeOperator({ "GET /api/health": health, ...routes });
  return renderApp(PATH, { signedIn: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** The parts of the page behind a click open on request. */
async function openSection(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name }));
}

const quietStream: RouteHandler = () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } });
const summary = () => screen.getByTestId("payout-summary");

describe("a campaign waiting for funding", () => {
  it("shows its status, figures and the practice chain's deposit form", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    expect(await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" })).toBeInTheDocument();
    expect(screen.getByText(ID)).toBeInTheDocument();
    expect(summary()).toHaveTextContent("5 people");
    expect(summary()).toHaveTextContent("11.625 TAZ");
    expect(summary()).toHaveTextContent("+ 0.00035 TAZ fee");
    expect(screen.getByText("Waiting for funds")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Practice mode: record a pretend deposit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Privacy warnings (1)" })).toBeInTheDocument();
  });

  it("keeps the batches behind a click", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    expect(screen.queryByRole("heading", { level: 3, name: /^Batch [01]$/u })).toBeNull();
    await openSection(user, "Batches");
    expect(screen.getAllByRole("heading", { level: 3, name: /^Batch [01]$/u })).toHaveLength(2);
  });

  it("cannot be sent yet, and says why", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    expect(screen.getByRole("button", { name: "Send 5 payouts" })).toBeDisabled();
    expect(screen.getByText("Sending can start once the campaign is funded.")).toBeInTheDocument();
  });

  it("offers no receipt link and no activity log before anything is built", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
    await openSection(user, "Share the receipt");
    expect(screen.getByText(/available once every batch has been built/u)).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-link")).toBeNull();
    expect(operator.to("GET", /\/receipt$/u)).toHaveLength(0);
    expect(operator.to("GET", /\/events$/u)).toHaveLength(0);
  });

  it("records a mock deposit and then offers to send", async () => {
    let funded = false;
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith(funded ? "campaign-funded.json" : "campaign-awaiting-funding.json"),
      "POST /api/campaigns/:id/fund-observed": () => {
        funded = true;
        return replyWith("fund-ok.json");
      },
      "GET /api/campaigns/:id/events": quietStream,
    });
    await user.click(await screen.findByRole("button", { name: "Record mock deposit" }));

    const call = operator.to("POST", /fund-observed$/u)[0];
    expect(call?.body).toMatchObject({ amount: "1162535000" });
    expect((call?.body as { outpoint: string }).outpoint).toMatch(/^[0-9a-f]{64}:0$/u);

    expect(await screen.findByRole("button", { name: "Send 5 payouts" })).toBeEnabled();
    expect(screen.getByText(/in deposit/u)).toBeInTheDocument();
    expect(screen.getByText("Funded.")).toBeInTheDocument();
  });

  it("explains an insufficient deposit with both figures", async () => {
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json"),
      "POST /api/campaigns/:id/fund-observed": () => replyWith("fund-insufficient.json", 422),
    });
    await openSection(user, "Change the deposit");
    const amount = await screen.findByLabelText("Amount (TAZ)");
    await user.clear(amount);
    await user.type(amount, "0.00001");
    await user.click(screen.getByRole("button", { name: "Record mock deposit" }));
    expect(await screen.findByRole("heading", { name: "The deposit is too small" })).toBeInTheDocument();
    expect(screen.getByText(/needs 11.62535 TAZ .* This deposit is 0.00001 TAZ/u)).toBeInTheDocument();
  });
});

describe("a funded campaign", () => {
  const fundedRoutes = (): Record<string, RouteHandler> => ({
    "GET /api/campaigns/:id": () => replyWith("campaign-funded.json"),
    "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-ok.json") }),
    "GET /api/campaigns/:id/events": quietStream,
  });

  it("asks once, in a sheet that says what it does and that it cannot be undone", async () => {
    const user = userEvent.setup();
    open(fundedRoutes());
    await user.click(await screen.findByRole("button", { name: "Send 5 payouts" }));

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Send 5 payouts?" })).toBeInTheDocument();
    expect(sheet).toHaveTextContent("This sends 5 payouts, 11.625 TAZ plus 0.00035 TAZ fee. It cannot be undone.");
    // Nothing has been sent by looking at it.
    expect(operator.to("POST", /\/start$/u)).toHaveLength(0);
  });

  it("sends nothing when the sheet is cancelled, or closed with Escape", async () => {
    const user = userEvent.setup();
    open(fundedRoutes());
    await user.click(await screen.findByRole("button", { name: "Send 5 payouts" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "Send 5 payouts" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(operator.to("POST", /\/start$/u)).toHaveLength(0);
  });

  it("starts the run, once, when it is confirmed", async () => {
    const user = userEvent.setup();
    open(fundedRoutes());
    await user.click(await screen.findByRole("button", { name: "Send 5 payouts" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send 5 payouts" }));
    await waitFor(() => {
      expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("says what went wrong in the sheet when the operator refuses, and keeps the sheet", async () => {
    const user = userEvent.setup();
    open({ ...fundedRoutes(), "POST /api/campaigns/:id/start": () => replyWith("start-not-funded.json", 409) });
    await user.click(await screen.findByRole("button", { name: "Send 5 payouts" }));
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "Send 5 payouts" }));
    expect(await within(sheet).findByRole("heading", { name: "Funding comes first" })).toBeInTheDocument();
  });

  it("does not show the mock deposit form once it has a deposit", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-funded.json"), "GET /api/campaigns/:id/events": quietStream });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    expect(screen.queryByRole("button", { name: "Record mock deposit" })).toBeNull();
    expect(screen.getByText("Funded.")).toBeInTheDocument();
  });
});

describe("a funded campaign on testnet", () => {
  it.each([
    ["the practice chain", mockHealth, "campaign-funded.json"],
    ["a real testnet", realHealth, "campaign-real-funded.json"],
  ] as const)("on %s the sheet has no box to tick, and its button is ready", async (_name, health, file) => {
    const user = userEvent.setup();
    open(
      {
        "GET /api/campaigns/:id": () => (file === "campaign-funded.json" ? replyWith(file) : replyWithGolden(file)),
        "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-ok.json") }),
        "GET /api/campaigns/:id/events": quietStream,
      },
      health,
    );
    await user.click(await screen.findByRole("button", { name: /^Send \d+ payouts$/u }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("checkbox")).toBeNull();
    expect(within(sheet).getByRole("button", { name: /^Send \d+ payouts$/u })).toBeEnabled();
  });
});

describe("a funded campaign on mainnet", () => {
  const TICK = "This sends real ZEC and cannot be undone";
  const SEND = "Send 3 payouts";
  const asMainnet = (campaign: unknown): Json => ({ ...(campaign as Json), network: "mainnet" });
  const mainnetHealth: RouteHandler = () => ({ body: { ...(goldenJson("health-real.json") as Json), network: "mainnet" } });

  const routes = (campaign: () => Json = () => asMainnet(goldenJson("campaign-real-funded.json"))): Record<string, RouteHandler> => ({
    "GET /api/campaigns/:id": () => ({ body: campaign() }),
    "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-ok.json") }),
    "GET /api/campaigns/:id/events": quietStream,
  });

  async function openSheet(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: SEND }));
    return await screen.findByRole("dialog");
  }

  it("will not send until the box is ticked, and then sends once", async () => {
    const user = userEvent.setup();
    open(routes(), mainnetHealth);
    const sheet = await openSheet(user);

    const box = within(sheet).getByRole("checkbox", { name: TICK });
    expect(box).not.toBeChecked();
    expect(within(sheet).getByRole("button", { name: SEND })).toBeDisabled();
    await user.click(within(sheet).getByRole("button", { name: SEND }));
    expect(operator.to("POST", /\/start$/u)).toHaveLength(0);

    await user.click(box);
    expect(box).toBeChecked();
    expect(within(sheet).getByRole("button", { name: SEND })).toBeEnabled();
    await user.click(within(sheet).getByRole("button", { name: SEND }));
    await waitFor(() => {
      expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("takes the tick back with a second click", async () => {
    const user = userEvent.setup();
    open(routes(), mainnetHealth);
    const sheet = await openSheet(user);
    await user.click(within(sheet).getByRole("checkbox", { name: TICK }));
    await user.click(within(sheet).getByRole("checkbox", { name: TICK }));
    expect(within(sheet).getByRole("button", { name: SEND })).toBeDisabled();
  });

  it("asks afresh each time the sheet opens: the tick does not carry over", async () => {
    const user = userEvent.setup();
    open(routes(), mainnetHealth);
    const first = await openSheet(user);
    await user.click(within(first).getByRole("checkbox", { name: TICK }));
    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    const second = await openSheet(user);
    expect(within(second).getByRole("checkbox", { name: TICK })).not.toBeChecked();
    expect(within(second).getByRole("button", { name: SEND })).toBeDisabled();
    expect(operator.to("POST", /\/start$/u)).toHaveLength(0);
  });

  it("still says what it sends, in ZEC, and that it cannot be undone", async () => {
    const user = userEvent.setup();
    open(routes(), mainnetHealth);
    const sheet = await openSheet(user);
    expect(sheet).toHaveTextContent("This sends 3 payouts, 4.5 ZEC plus 0.0002 ZEC fee. It cannot be undone.");
    expect(sheet.textContent).not.toMatch(/TAZ/u);
  });

  it.each([
    ["the campaign says mainnet and the operator says testnet", routes(), realHealth],
    ["the operator says mainnet and the campaign says testnet", routes(() => goldenJson("campaign-real-funded.json") as Json), mainnetHealth],
  ])("asks when %s: either one is enough", async (_name, handlers, health) => {
    const user = userEvent.setup();
    open(handlers, health);
    const sheet = await openSheet(user);
    expect(within(sheet).getByRole("checkbox", { name: TICK })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: SEND })).toBeDisabled();
  });

  it("still asks while the operator has not said which network it is on, if the campaign says mainnet", async () => {
    const user = userEvent.setup();
    open(routes(), () => ({ status: 503, body: { error: { code: "chain_unavailable", message: "x" } } }));
    const sheet = await openSheet(user);
    expect(within(sheet).getByRole("button", { name: SEND })).toBeDisabled();
  });

  it("does not ask to resume a run that already started: that rebuilds nothing and sends nothing twice", async () => {
    const user = userEvent.setup();
    open(
      {
        ...routes(() => asMainnet(campaignWith("campaign-crashed.json", {}))),
        "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-resume.json") }),
      },
      mainnetHealth,
    );
    await user.click(await screen.findByRole("button", { name: "Resume sending" }));
    expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: TICK })).toBeNull();
  });
});

describe("a run in progress", () => {
  function openRunning() {
    return open({
      "GET /api/campaigns/:id": () => replyWith("campaign-running.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-running.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-running.json"),
    });
  }

  it("shows the sending timeline, with the step it is on", async () => {
    openRunning();
    expect(await screen.findByRole("heading", { level: 1, name: "In progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sending the payouts" })).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "Sending progress" })).getAllByRole("listitem");
    expect(steps.map((s) => s.getAttribute("data-state"))).toEqual(["done", "done", "done", "active", "next", "next", "next"]);
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Confirming 1");
    expect(screen.getByRole("progressbar", { name: "Batches confirmed" })).toHaveAttribute("aria-valuenow", "0");
  });

  it("counts the time, and says how it counts", async () => {
    openRunning();
    await screen.findByRole("heading", { name: "Sending the payouts" });
    // This page did not start the run, so it says it is watching, not that it is timing it.
    expect(screen.getByTestId("elapsed")).toHaveTextContent(/^Watching for \d+:\d\d$/u);
  });

  it("says the wait is an estimate, and not on the practice chain", async () => {
    openRunning();
    await screen.findByRole("heading", { name: "Sending the payouts" });
    expect(screen.queryByText(/These are estimates/u)).toBeNull();
  });

  it("shows the live activity behind a click, and nothing to start or resume", async () => {
    const user = userEvent.setup();
    openRunning();
    await screen.findByRole("heading", { name: "Sending the payouts" });
    await openSection(user, "Activity");
    expect(await screen.findByText("Batch 0: transaction built (3 shielded outputs).")).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Activity log" })).toBeInTheDocument();
    // The captured transcript ends without a terminal event, as a stream cut off mid-run does: the page reconnects.
    expect(screen.getByTestId("stream-status")).toHaveTextContent(/Live|dropped/u);
    expect(screen.queryByRole("button", { name: /^Send|Resume|Try again/u })).toBeNull();
  });

  it("estimates the wait on a real chain, in words that say it is an estimate", async () => {
    open(
      {
        "GET /api/campaigns/:id": () => replyWith("campaign-running.json"),
        "GET /api/campaigns/:id/events": quietStream,
        "GET /api/campaigns/:id/receipt": () => replyWith("receipt-running.json"),
      },
      realHealth,
    );
    expect(await screen.findByText(/Usually about .* to build, then about .* to confirm\. These are estimates\./u)).toBeInTheDocument();
  });
});

describe("a run that stopped unexpectedly", () => {
  it("offers to resume and promises nothing is built twice", async () => {
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-crashed.json"),
      "GET /api/campaigns/:id/events": quietStream,
      "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-resume.json") }),
    });
    expect(await screen.findByRole("heading", { name: "Sending the payouts" })).toBeInTheDocument();
    // Said on the step itself, and again for assistive technology in the live line under the timeline.
    expect(screen.getAllByText(/never built a second time/u)).toHaveLength(2);
    // Resuming asks nothing: it rebuilds nothing and sends nothing twice.
    await user.click(screen.getByRole("button", { name: "Resume sending" }));
    expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a halted run", () => {
  it("shows the failed step with the reason, and offers no restart", async () => {
    const batches = (fixtureJson("campaign-running.json") as { batches: Json[] }).batches.map((b, i) =>
      i === 0 ? { ...b, state: "failed", reason: "rejected by the node" } : b,
    );
    open({
      "GET /api/campaigns/:id": () => ({ body: campaignWith("campaign-running.json", { run: { state: "halted" }, batches }) }),
      "GET /api/campaigns/:id/events": quietStream,
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-running.json"),
    });
    expect(await screen.findByRole("heading", { name: "Sending the payouts" })).toBeInTheDocument();
    const failed = within(screen.getByRole("list", { name: "Sending progress" })).getAllByRole("listitem").find((li) => li.getAttribute("data-state") === "failed");
    expect(failed).toBeDefined();
    expect(failed).toHaveTextContent("rejected by the node");
    expect(failed).toHaveTextContent("(failed)");
    // What happened, and what to do about it.
    expect(screen.getByText(/They need attention\. The operator's terminal says why\./u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Send|Resume|Try again/u })).toBeNull();
  });
});

describe("a settled campaign", () => {
  function openSettled() {
    return open({
      "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
    });
  }

  it("seals it: the stamp, every batch confirmed, and the status sentence", async () => {
    const user = userEvent.setup();
    openSettled();
    expect(await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" })).toBeInTheDocument();
    expect(await screen.findByText("Sealed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All 2 batches are confirmed" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Batches confirmed" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("2 of 2 batches confirmed")).toBeInTheDocument();
    expect(screen.getByText("Complete: all batches confirmed")).toBeInTheDocument();
    // The timeline is for a run; once it is sealed, the stamp and the actions take its place.
    expect(screen.queryByRole("list", { name: "Sending progress" })).toBeNull();
    await openSection(user, "Activity");
    expect(await screen.findByText("All 2 batches are confirmed.")).toBeInTheDocument();
  });

  it("offers the three things to do next, by name", async () => {
    openSettled();
    expect(await screen.findByRole("link", { name: "Open public receipt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy receipt link" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Give an auditor access" })).toBeInTheDocument();
  });

  it("builds a receipt link from the operator's receipt that the public page accepts", async () => {
    const user = userEvent.setup();
    openSettled();
    await openSection(user, "Share the receipt");
    const link = await screen.findByTestId("receipt-link");
    const receipt = fixtureJson("receipt-settled.json") as { batches: { txid: string }[]; manifest_commitment: string; declared_total: string };

    const [path, query] = (link.textContent ?? "").split("?");
    expect(path).toBe(`/r/${ID}`);
    const parsed = parseReceiptLink(new URLSearchParams(query));
    expect(parsed).toEqual({
      ok: true,
      query: {
        network: "testnet",
        txids: receipt.batches.map((b) => b.txid),
        commitment: receipt.manifest_commitment,
        declaredTotal: receipt.declared_total,
      },
    });
    // "Open public receipt" goes to that same link.
    expect(await screen.findByRole("link", { name: "Open public receipt" })).toHaveAttribute("href", link.textContent);
  });

  it("copies the receipt link", async () => {
    const user = userEvent.setup();
    openSettled();
    await openSection(user, "Share the receipt");
    const link = (await screen.findByTestId("receipt-link")).textContent ?? "";
    // Installed after userEvent.setup(), which installs its own clipboard stub.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy receipt link" }));
    expect(writeText).toHaveBeenLastCalledWith(link);
  });

  it("says what the link reveals and what it does not", async () => {
    const user = userEvent.setup();
    openSettled();
    await openSection(user, "Share the receipt");
    await screen.findByTestId("receipt-link");
    expect(screen.getByText(/transaction id of every batch, the declared total and the manifest commitment/u)).toBeInTheDocument();
    expect(screen.getByText(/verifier that answers the link learns which receipt was viewed/u)).toBeInTheDocument();
    expect(screen.getByText(/Recipient addresses, per-recipient amounts and memos are not in the link/u)).toBeInTheDocument();
    expect(screen.getByText(/a batch of equal amounts, lets the amounts be worked out/u)).toBeInTheDocument();
    expect(screen.getByText(/funding address and amount are public and can be linked/u)).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "How privacy works" })).toHaveAttribute("href", "/privacy");
  });

  it("says the link is only a path when no public host is configured", async () => {
    const user = userEvent.setup();
    openSettled();
    await openSection(user, "Share the receipt");
    await screen.findByTestId("receipt-link");
    expect(screen.getByText(/This is the path only/u)).toBeInTheDocument();
  });

  it("opens the auditor section from the action, and the irreversible confirmation is still there", async () => {
    const user = userEvent.setup();
    openSettled();
    expect(await screen.findByRole("button", { name: "Auditor access" })).toHaveAttribute("aria-expanded", "false");
    await user.click(await screen.findByRole("button", { name: "Give an auditor access" }));
    expect(screen.getByRole("button", { name: "Auditor access" })).toHaveAttribute("aria-expanded", "true");
    // The irreversible-disclosure warning is the first thing in it. (The practice chain has no real
    // keys, so there is nothing to confirm or show here; the real-chain tests cover the confirmation.)
    expect(await screen.findByText("This cannot be undone")).toBeInTheDocument();
    expect(screen.getByText(/no real viewing keys/u)).toBeInTheDocument();
  });

  it("refuses to offer a link when the receipt still has an unbuilt batch", async () => {
    const user = userEvent.setup();
    const receipt = fixtureJson("receipt-settled.json") as { batches: Json[] };
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => ({
        body: { ...receipt, batches: receipt.batches.map((b, i) => (i === 1 ? { ...b, txid: null } : b)) },
      }),
    });
    await openSection(user, "Share the receipt");
    expect(await screen.findByText("No link can be made yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-link")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy receipt link" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Open public receipt" })).toBeNull();
  });
});

describe("failures", () => {
  it("says a missing campaign is not found, and shows no data", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-not-found.json", 404) });
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Campaign" })).toBeInTheDocument();
  });

  it("sends a refused token back to the explainer", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("unauthorized-wrong-token.json", 401) });
    expect(await screen.findByRole("heading", { level: 1, name: "Open the operator link" })).toBeInTheDocument();
  });

  it("keeps showing the last good data when a refresh fails", async () => {
    let calls = 0;
    const view = open({
      "GET /api/campaigns/:id": () => {
        calls += 1;
        return calls === 1 ? replyWith("campaign-awaiting-funding.json") : replyWith("campaign-not-found.json", 404);
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    await view.client.invalidateQueries();
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sentinel campaign" })).toBeInTheDocument();
  });
});

describe("a real chain", () => {
  // The golden files are written by the operator's own Rust test: the real
  // handlers over an in-memory real-chain backend.
  const campaign = (file: string): RouteHandler => () => replyWithGolden(file);

  it("asks 'Is it funded?', with the address to copy, the amount to send, and Waiting for funds", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id": campaign("campaign-real-awaiting-deposit.json") }, realHealth);
    expect(await screen.findByRole("heading", { name: "Is it funded?" })).toBeInTheDocument();
    expect(screen.getByTestId("funding-address")).toHaveTextContent("tFAKEfundingAddressNotARealAddress0000");
    expect(screen.getByRole("button", { name: "Copy funding address" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for funds")).toBeInTheDocument();
    expect(screen.getByText("No deposit seen yet. This page checks again every few seconds.")).toBeInTheDocument();
    // What is public about the deposit is one tap away, not a paragraph on the page.
    expect(screen.queryByText(/The funding address, the amount and the address you send from are public/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "About the deposit" }));
    expect(await screen.findByText(/The funding address, the amount and the address you send from are public/u)).toBeInTheDocument();
    // Not the mock chain: no pretend deposit.
    expect(screen.queryByRole("heading", { name: "Practice mode: record a pretend deposit" })).toBeNull();
    expect(screen.queryByText("Mock chain:")).toBeNull();
  });

  it("offers 'Open in wallet': a zcash link with this address and exactly the amount to send, and nothing else", async () => {
    open({ "GET /api/campaigns/:id": campaign("campaign-real-awaiting-deposit.json") }, realHealth);
    const link = await screen.findByRole("link", { name: "Open in wallet" });
    expect(link).toHaveAttribute("href", "zcash:tFAKEfundingAddressNotARealAddress0000?amount=4.5002");
    // Copying stays available beside it, and the page says what to do when no wallet app opens.
    expect(screen.getByRole("button", { name: "Copy funding address" })).toBeInTheDocument();
    expect(screen.getByText("Opens a wallet app that handles zcash links. If nothing opens, copy the address.")).toBeInTheDocument();
  });

  describe("the row 'Fund from another coin'", () => {
    const nearRoutes = (): Record<string, RouteHandler> => ({
      "GET /api/campaigns/:id": campaign("campaign-real-awaiting-deposit.json"),
      "GET /api/near/tokens": () => replyWithGolden("near-tokens.json"),
      "POST /api/near/preview": () => replyWithGolden("near-preview.json"),
    });

    it("sits closed under the funding address, and the price service is not asked until it is opened", async () => {
      open(nearRoutes(), realHealth);
      const row = await screen.findByRole("button", { name: "Fund from another coin" });
      expect(row).toHaveAttribute("aria-expanded", "false");
      // Under the address, before the waiting line.
      const address = screen.getByTestId("funding-address");
      expect(address.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(operator.calls.filter((c) => c.path.includes("/near/"))).toHaveLength(0);
    });

    it("opens to a real price preview on a testnet campaign, asked for with the campaign's size and nothing else", async () => {
      const user = userEvent.setup();
      open(nearRoutes(), realHealth);
      await user.click(await screen.findByRole("button", { name: "Fund from another coin" }));
      await user.selectOptions(await screen.findByLabelText("Asset to pay with"), "USDC on near");
      await user.click(screen.getByRole("button", { name: "Show a price preview" }));
      const shown = await screen.findByTestId("near-price");
      expect(shown).toHaveTextContent("Nothing is created. There is no deposit address.");
      expect(shown).toHaveTextContent("you would send about 7.679013 USDC on near");

      const asked = operator.to("POST", "/api/near/preview");
      expect(asked).toHaveLength(1);
      expect(asked[0]?.body).toEqual({
        origin_asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        amount_zat: "450020000",
      });
      // A testnet campaign never reaches the routes that create or follow a swap.
      expect(operator.calls.filter((c) => /dry-quote|live-quote|near\/status/u.test(c.path))).toHaveLength(0);
      // And the page is still the funding page.
      expect(screen.getByTestId("funding-address")).toBeInTheDocument();
      expect(screen.getByText("The campaign counts as funded only when the coin appears on chain.")).toBeInTheDocument();
    });

    it("when the price service cannot be reached, says so inside the row and leaves the rest of the page alone", async () => {
      const user = userEvent.setup();
      open({ ...nearRoutes(), "GET /api/near/tokens": () => replyWithGolden("error-near-unavailable.json", 503) }, realHealth);
      await user.click(await screen.findByRole("button", { name: "Fund from another coin" }));
      expect(await screen.findByRole("heading", { name: "The price service could not be reached" })).toBeInTheDocument();
      expect(screen.getByTestId("funding-address")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Check for the deposit now" })).toBeEnabled();
    });

    it("is not on the practice chain, where nothing real can be paid", async () => {
      open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
      await screen.findByRole("heading", { name: "Practice mode: record a pretend deposit" });
      expect(screen.queryByRole("button", { name: "Fund from another coin" })).toBeNull();
    });

    it("is gone once the campaign is funded", async () => {
      open({ "GET /api/campaigns/:id": campaign("campaign-real-funded.json") }, realHealth);
      expect(await screen.findByText("Funded.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Fund from another coin" })).toBeNull();
    });
  });

  it("reports a deposit that is enough but still confirming", async () => {
    open({ "GET /api/campaigns/:id": campaign("campaign-real-deposit-shallow.json") }, realHealth);
    expect(await screen.findByText(/has 2 of 3 confirmations/u)).toBeInTheDocument();
    expect(screen.queryByText(/does not count/u)).toBeNull();
    expect(screen.getByRole("button", { name: /^Send \d+ payouts?$/u })).toBeDisabled();
  });

  it("says a too-small deposit does not count", async () => {
    open({ "GET /api/campaigns/:id": campaign("campaign-real-deposit-too-small.json") }, realHealth);
    expect(await screen.findByText(/so it does not count/u)).toBeInTheDocument();
  });

  it("asks the operator to look for the deposit when told to, and then shows it funded", async () => {
    let looked = false;
    const user = userEvent.setup();
    open(
      {
        "GET /api/campaigns/:id": () => replyWithGolden(looked ? "campaign-real-funded.json" : "campaign-real-awaiting-deposit.json"),
        "POST /api/campaigns/:id/check-funding": () => {
          looked = true;
          return replyWithGolden("campaign-real-funded.json");
        },
        "GET /api/campaigns/:id/events": quietStream,
      },
      realHealth,
    );
    await user.click(await screen.findByRole("button", { name: "Check for the deposit now" }));
    expect(operator.to("POST", /check-funding$/u)).toHaveLength(1);
    expect(await screen.findByText(/in deposit/u)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Send \d+ payouts?$/u })).toBeEnabled();
  });

  it("explains a wallet mismatch and offers no way to fund or send", async () => {
    open({ "GET /api/campaigns/:id": campaign("campaign-real-wrong-wallet.json") }, realHealth);
    expect(await screen.findByText("This campaign belongs to a different wallet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send \d+ payouts?$/u })).toBeDisabled();
    expect(screen.getByText("Sending is not possible with this wallet.")).toBeInTheDocument();
    expect(screen.queryByTestId("funding-address")).toBeNull();
  });

  it("when the chain is unavailable, says so and keeps the page", async () => {
    const user = userEvent.setup();
    open(
      {
        "GET /api/campaigns/:id": campaign("campaign-real-awaiting-deposit.json"),
        "POST /api/campaigns/:id/check-funding": () => replyWithGolden("error-chain-unavailable.json", 503),
      },
      realHealth,
    );
    await user.click(await screen.findByRole("button", { name: "Check for the deposit now" }));
    expect(await screen.findByRole("heading", { name: "The operator can't reach its Zcash node" })).toBeInTheDocument();
    expect(screen.getByTestId("funding-address")).toBeInTheDocument();
  });

  it("shows the viewing key only after the person agrees, with the operator's own warning", async () => {
    const user = userEvent.setup();
    open(
      {
        "GET /api/campaigns/:id": campaign("campaign-real-awaiting-deposit.json"),
        "GET /api/campaigns/:id/audit-ufvk-export": () => replyWithGolden("audit-ufvk-export.json"),
      },
      realHealth,
    );
    await openSection(user, "Auditor access");
    await user.click(await screen.findByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Show the viewing key" }));
    expect(await screen.findByDisplayValue("uviewFAKEplaceholderNotAKeyNotAKeyNotAKeyNotAKey")).toBeInTheDocument();
    expect(operator.to("GET", /audit-ufvk-export$/u)[0]?.headers.get("X-Zecdrop-Confirm-Disclosure")).toBe("I-UNDERSTAND");
  });
});

describe("what never appears", () => {
  it("no recipient address, memo or amount is on the page, whatever the state", async () => {
    const user = userEvent.setup();
    for (const file of ["campaign-awaiting-funding.json", "campaign-funded.json", "campaign-running.json", "campaign-crashed.json", "campaign-settled.json"]) {
      const view = open({
        "GET /api/campaigns/:id": () => replyWith(file),
        "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
        "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
      });
      await openSection(user, "Batches");
      await screen.findByRole("heading", { level: 3, name: "Batch 0" });
      const html = document.body.innerHTML;
      expect(html, file).not.toMatch(/sentineladdress|memo-sentinel/u);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the page's data out of browser storage", async () => {
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
    });
    await openSection(user, "Share the receipt");
    await screen.findByTestId("receipt-link");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
