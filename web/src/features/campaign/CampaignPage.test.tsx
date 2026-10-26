// @vitest-environment jsdom
//
// The campaign page against the operator's CAPTURED responses. Each campaign
// state in fixtures/contract/operator is opened as a person would see it.
import { screen, within } from "@testing-library/react";
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
import { fixtureJson } from "@/test/operator-fixtures";
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

describe("a campaign waiting for funding", () => {
  it("shows its phase, totals and batches, and the mock chain's deposit form", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    expect(await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" })).toBeInTheDocument();
    expect(screen.getByText(ID)).toBeInTheDocument();
    expect(screen.getByText("Awaiting funding")).toBeInTheDocument();
    expect(screen.getByText("11.625 TAZ")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3, name: /^Batch [01]$/u }).length).toBe(2);
    expect(await screen.findByRole("heading", { name: "Mock chain: record a pretend deposit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Privacy warnings (1)" })).toBeInTheDocument();
  });

  it("cannot be started yet, and says why", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    expect(screen.queryByRole("button", { name: "Start sending" })).toBeNull();
    expect(screen.getByText("Sending can start once the campaign is funded.")).toBeInTheDocument();
  });

  it("offers no receipt link and no activity log before anything is built", async () => {
    open({ "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    expect(screen.getByText(/available once every batch has been built/u)).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-link")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull();
    expect(operator.to("GET", /\/receipt$/u)).toHaveLength(0);
    expect(operator.to("GET", /\/events$/u)).toHaveLength(0);
  });

  it("records a mock deposit and then offers to start", async () => {
    let funded = false;
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith(funded ? "campaign-funded.json" : "campaign-awaiting-funding.json"),
      "POST /api/campaigns/:id/fund-observed": () => {
        funded = true;
        return replyWith("fund-ok.json");
      },
      "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
    });
    await user.click(await screen.findByRole("button", { name: "Record mock deposit" }));

    const call = operator.to("POST", /fund-observed$/u)[0];
    expect(call?.body).toMatchObject({ amount: "1162535000" });
    expect((call?.body as { outpoint: string }).outpoint).toMatch(/^[0-9a-f]{64}:0$/u);

    expect(await screen.findByRole("button", { name: "Start sending" })).toBeEnabled();
    expect(screen.getByText(/in deposit/u)).toBeInTheDocument();
  });

  it("explains an insufficient deposit with both figures", async () => {
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json"),
      "POST /api/campaigns/:id/fund-observed": () => replyWith("fund-insufficient.json", 422),
    });
    const amount = await screen.findByLabelText("Amount (TAZ)");
    await user.clear(amount);
    await user.type(amount, "0.00001");
    await user.click(screen.getByRole("button", { name: "Record mock deposit" }));
    expect(await screen.findByRole("heading", { name: "The deposit is too small" })).toBeInTheDocument();
    expect(screen.getByText(/needs 11.62535 TAZ .* This deposit is 0.00001 TAZ/u)).toBeInTheDocument();
  });
});

describe("a funded campaign", () => {
  it("starts the run when asked", async () => {
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-funded.json"),
      "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-ok.json") }),
      "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
    });
    await user.click(await screen.findByRole("button", { name: "Start sending" }));
    expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
  });

  it("does not show the mock deposit form once it has a deposit", async () => {
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-funded.json"),
      "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
    });
    await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" });
    expect(screen.queryByRole("button", { name: "Record mock deposit" })).toBeNull();
  });
});

describe("a run in progress", () => {
  it("shows batches as sent, with progress and the live activity", async () => {
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-running.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-running.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-running.json"),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "In progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sending: Sending" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Batches confirmed" })).toHaveAttribute("aria-valuenow", "0");
    expect(await screen.findByText("Batch 0: transaction built (3 shielded outputs).")).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Activity log" })).toBeInTheDocument();
    // The captured transcript ends without a terminal event, as a stream cut off mid-run does: the page reconnects.
    expect(screen.getByTestId("stream-status")).toHaveTextContent(/Live|dropped/u);
    expect(screen.queryByRole("button", { name: /Start|Resume/u })).toBeNull();
  });
});

describe("a run that stopped unexpectedly", () => {
  it("offers to resume and promises nothing is built twice", async () => {
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-crashed.json"),
      "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
      "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-resume.json") }),
    });
    expect(await screen.findByRole("heading", { name: "Sending: Stopped unexpectedly" })).toBeInTheDocument();
    expect(screen.getByText(/never built a second time/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume sending" }));
    expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
  });
});

describe("a halted run", () => {
  it("says which batches need attention and offers no restart", async () => {
    const batches = (fixtureJson("campaign-running.json") as { batches: Json[] }).batches.map((b, i) =>
      i === 0 ? { ...b, state: "failed", reason: "rejected by the node" } : b,
    );
    open({
      "GET /api/campaigns/:id": () => ({ body: campaignWith("campaign-running.json", { run: { state: "halted" }, batches }) }),
      "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-running.json"),
    });
    expect(await screen.findByRole("heading", { name: "Sending: Stopped" })).toBeInTheDocument();
    expect(screen.getAllByText(/rejected by the node/u).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Start|Resume|Try again/u })).toBeNull();
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

  it("shows every batch confirmed and the complete label", async () => {
    openSettled();
    expect(await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Batches confirmed" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("2 of 2 batches confirmed")).toBeInTheDocument();
    expect(screen.getByText("Complete: all batches confirmed")).toBeInTheDocument();
    expect(await screen.findByText("All 2 batches are confirmed.")).toBeInTheDocument();
  });

  it("builds a receipt link from the operator's receipt that the public page accepts", async () => {
    openSettled();
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
  });

  it("says what the link reveals and what it does not", async () => {
    openSettled();
    await screen.findByTestId("receipt-link");
    const card = screen.getByRole("heading", { name: "Share the receipt" }).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText(/transaction id of every batch, the declared total and the manifest commitment/u)).toBeInTheDocument();
    expect(within(card).getByText(/verifier that answers the link learns which receipt was viewed/u)).toBeInTheDocument();
    expect(within(card).getByText(/Recipient addresses, per-recipient amounts and memos are not in the link/u)).toBeInTheDocument();
    expect(within(card).getByText(/a batch of equal amounts, lets the amounts be worked out/u)).toBeInTheDocument();
    expect(within(card).getByText(/funding address and amount are public and can be linked/u)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Read the full privacy boundary" })).toHaveAttribute("href", "/privacy");
  });

  it("says the link is only a path when no public host is configured", async () => {
    openSettled();
    await screen.findByTestId("receipt-link");
    expect(screen.getByText(/This is the path only/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy receipt link" })).toBeInTheDocument();
  });

  it("refuses to offer a link when the receipt still has an unbuilt batch", async () => {
    const receipt = fixtureJson("receipt-settled.json") as { batches: Json[] };
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => ({
        body: { ...receipt, batches: receipt.batches.map((b, i) => (i === 1 ? { ...b, txid: null } : b)) },
      }),
    });
    expect(await screen.findByText("No link can be made yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-link")).toBeNull();
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
    const user = userEvent.setup();
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
    expect(user).toBeDefined();
  });
});

describe("a real chain", () => {
  // The golden files are written by the operator's own Rust test: the real
  // handlers over an in-memory real-chain backend.
  const campaign = (file: string): RouteHandler => () => replyWithGolden(file);

  it("shows the funding address, the amount to send, and what is public about it", async () => {
    open({ "GET /api/campaigns/:id": campaign("campaign-real-awaiting-deposit.json") }, realHealth);
    expect(await screen.findByTestId("funding-address")).toHaveTextContent("tFAKEfundingAddressNotARealAddress0000");
    expect(screen.getByText(/The funding address, the amount and the address you send from are public/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy funding address" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Mock chain: record a pretend deposit" })).toBeNull();
    expect(screen.getByText("No deposit seen yet. This page checks again every few seconds.")).toBeInTheDocument();
    // Not the mock chain: no banner.
    expect(screen.queryByText("Mock chain:")).toBeNull();
  });

  it("reports a deposit that is enough but still confirming", async () => {
    open({ "GET /api/campaigns/:id": campaign("campaign-real-deposit-shallow.json") }, realHealth);
    expect(await screen.findByText(/has 2 of 3 confirmations/u)).toBeInTheDocument();
    expect(screen.queryByText(/does not count/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Start sending" })).toBeNull();
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
        "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
      },
      realHealth,
    );
    await user.click(await screen.findByRole("button", { name: "Check for the deposit now" }));
    expect(operator.to("POST", /check-funding$/u)).toHaveLength(1);
    expect(await screen.findByText(/in deposit/u)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Start sending" })).toBeEnabled();
  });

  it("explains a wallet mismatch and offers no way to fund or start", async () => {
    open({ "GET /api/campaigns/:id": campaign("campaign-real-wrong-wallet.json") }, realHealth);
    expect(await screen.findByText("This campaign belongs to a different wallet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start sending" })).toBeNull();
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
    await user.click(await screen.findByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Show the viewing key" }));
    expect(await screen.findByDisplayValue("uviewFAKEplaceholderNotAKeyNotAKeyNotAKeyNotAKey")).toBeInTheDocument();
    expect(operator.to("GET", /audit-ufvk-export$/u)[0]?.headers.get("X-Zecdrop-Confirm-Disclosure")).toBe("I-UNDERSTAND");
  });
});

describe("what never appears", () => {
  it("no recipient address, memo or amount is on the page, whatever the state", async () => {
    for (const file of ["campaign-awaiting-funding.json", "campaign-funded.json", "campaign-running.json", "campaign-crashed.json", "campaign-settled.json"]) {
      const view = open({
        "GET /api/campaigns/:id": () => replyWith(file),
        "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
        "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
      });
      await screen.findByRole("heading", { name: "Batches" });
      const html = document.body.innerHTML;
      expect(html, file).not.toMatch(/sentineladdress|memo-sentinel/u);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the page's data out of browser storage", async () => {
    open({
      "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
    });
    await screen.findByTestId("receipt-link");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
