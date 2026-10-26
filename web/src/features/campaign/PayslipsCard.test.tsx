// @vitest-environment jsdom
//
// The Payslips section of a settled campaign (REQ-PAY-005), against the operator's own answers: the golden files its
// Rust test writes over a real-chain backend (fake, labelled values), and the mock chain's captured refusal. The payslips
// are on the page only after the person asks, only in this component's state, and a link is made only when asked.
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { FIXTURE_CAMPAIGN_ID, installFakeOperator, replyWith, replyWithGolden, replyWithStream, type FakeOperator, type RouteHandler } from "@/test/fake-operator";
import { goldenJson } from "@/test/operator-fixtures";
import { renderApp } from "@/test/render-app";
import { LINK_WARNING } from "@/features/payslip/wording";

import { PAYSLIPS_VISIBLE_MS, PAYSLIPS_WORDING } from "./payslips-wording";

const PATH = `/campaign/${FIXTURE_CAMPAIGN_ID}`;

interface GoldenRow {
  number: number;
  address: string;
  amount: string;
  memo: string | null;
  payslip: { rseed: string; receiver: string; txid: string } | null;
}
const GOLDEN = goldenJson("payslips.json") as { payslips: GoldenRow[] };
const SECRETS = GOLDEN.payslips.flatMap((row) => (row.payslip === null ? [] : [row.payslip.rseed, row.payslip.receiver]));

let operator: FakeOperator;

function open(routes: Record<string, RouteHandler>, health: RouteHandler = () => replyWithGolden("health-real.json")) {
  operator = installFakeOperator({
    "GET /api/health": health,
    "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
    "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
    "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
    ...routes,
  });
  return renderApp(PATH, { signedIn: true });
}

const payslipsAnswer: RouteHandler = () => replyWithGolden("payslips.json");

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

type User = ReturnType<typeof userEvent.setup>;

async function openPayslips(user: User) {
  await user.click(await screen.findByRole("button", { name: "Payslips" }));
}

describe("the Payslips section of a settled campaign", () => {
  // covers: REQ-PAY-005
  it("asks nothing until the person asks, then lists every person with their payslip, asked for with the disclosure header", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id/payslips": payslipsAnswer });
    await openPayslips(user);
    expect(screen.getByText(PAYSLIPS_WORDING.lead)).toBeInTheDocument();
    expect(screen.getByText(PAYSLIPS_WORDING.warning)).toBeInTheDocument();
    expect(operator.to("GET", /\/payslips$/u)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Show payslips" }));
    const list = await screen.findByRole("list", { name: "Payslips" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(GOLDEN.payslips.length);
    for (const [i, row] of GOLDEN.payslips.entries()) {
      expect(rows[i]).toHaveTextContent(`Person ${String(row.number)}`);
      if (row.memo !== null) expect(rows[i]).toHaveTextContent(row.memo);
    }
    const asked = operator.to("GET", /\/payslips$/u);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.headers.get("X-Zecdrop-Confirm-Disclosure")).toBe("I-UNDERSTAND");
    // No secret of a payslip is on the page until a link is asked for.
    for (const secret of SECRETS) expect(document.body.innerHTML).not.toContain(secret);
  });

  // covers: REQ-PAY-005
  it("sends one person's payslip as a link that holds it after the #, with the warning first", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id/payslips": payslipsAnswer });
    await openPayslips(user);
    await user.click(screen.getByRole("button", { name: "Show payslips" }));
    const first = within(await screen.findByRole("list", { name: "Payslips" })).getAllByRole("listitem")[0] as HTMLElement;
    await user.click(within(first).getByRole("button", { name: "Send payslip" }));
    expect(within(first).getByText(LINK_WARNING)).toBeInTheDocument();
    await user.click(within(first).getByRole("button", { name: "Make a link" }));
    const link = within(first).getByRole<HTMLTextAreaElement>("textbox").value;
    expect(link).toMatch(/\/payslip#payslip=[A-Za-z0-9_-]+$/u);
    const [before] = link.split("#");
    for (const secret of SECRETS) expect(before).not.toContain(secret);
    // This page's own address is untouched.
    expect(window.location.href).not.toContain("payslip=");
    // Only one person's at a time.
    await user.click(within(first).getByRole("button", { name: "Close" }));
    expect(within(first).queryByText(LINK_WARNING)).toBeNull();
  });

  // covers: REQ-PAY-005
  it("hides the payslips again on request, and by itself after ten minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    open({ "GET /api/campaigns/:id/payslips": payslipsAnswer });
    await openPayslips(user);
    await user.click(screen.getByRole("button", { name: "Show payslips" }));
    await screen.findByRole("list", { name: "Payslips" });
    await user.click(screen.getByRole("button", { name: "Hide payslips" }));
    expect(screen.queryByRole("list", { name: "Payslips" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show payslips" }));
    await screen.findByRole("list", { name: "Payslips" });
    act(() => {
      vi.advanceTimersByTime(PAYSLIPS_VISIBLE_MS + 1);
    });
    expect(screen.queryByRole("list", { name: "Payslips" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show payslips" })).toBeInTheDocument();
  });

  it("opens from the Send payslips action beside the receipt", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id/payslips": payslipsAnswer });
    await user.click(await screen.findByRole("button", { name: "Send payslips" }));
    expect(await screen.findByRole("button", { name: "Show payslips" })).toBeVisible();
  });

  it("says why there are none on the mock chain, and asks the operator nothing", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id/payslips": () => replyWith("payslips-mock.json", 409) }, () => replyWith("health.json"));
    await openPayslips(user);
    expect(screen.getByText(PAYSLIPS_WORDING.mock)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show payslips" })).toBeNull();
    expect(operator.to("GET", /\/payslips$/u)).toHaveLength(0);
  });

  it("says in words when the operator says the campaign is not settled", async () => {
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id/payslips": () => replyWithGolden("error-not-settled.json", 409) });
    await openPayslips(user);
    await user.click(screen.getByRole("button", { name: "Show payslips" }));
    expect(await screen.findByText("Not settled yet")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Payslips" })).toBeNull();
  });

  it("says when a payout has no payslip, and when an output matches no payout", async () => {
    const answer = goldenJson("payslips.json") as { payslips: GoldenRow[]; unmatched_outputs: number };
    const user = userEvent.setup();
    open({
      "GET /api/campaigns/:id/payslips": () => ({
        status: 200,
        body: { ...answer, payslips: answer.payslips.map((row, i) => (i === 0 ? { ...row, payslip: null } : row)), unmatched_outputs: 1 },
      }),
    });
    await openPayslips(user);
    await user.click(screen.getByRole("button", { name: "Show payslips" }));
    const first = within(await screen.findByRole("list", { name: "Payslips" })).getAllByRole("listitem")[0] as HTMLElement;
    expect(within(first).getByText(PAYSLIPS_WORDING.missing)).toBeInTheDocument();
    expect(within(first).queryByRole("button", { name: "Send payslip" })).toBeNull();
    expect(screen.getByText(/1 output matches no payout\. Run the audit\./u)).toBeInTheDocument();
  });
});

describe("what the Payslips section keeps", () => {
  // covers: REQ-PAY-005
  it("keeps the payslips out of storage, the console and every request but the export", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const stored: string[] = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
      stored.push(`${key}=${value}`);
    });
    const user = userEvent.setup();
    open({ "GET /api/campaigns/:id/payslips": payslipsAnswer });
    await openPayslips(user);
    await user.click(screen.getByRole("button", { name: "Show payslips" }));
    const first = within(await screen.findByRole("list", { name: "Payslips" })).getAllByRole("listitem")[0] as HTMLElement;
    await user.click(within(first).getByRole("button", { name: "Send payslip" }));
    await user.click(within(first).getByRole("button", { name: "Make a link" }));
    await user.click(within(first).getByRole("button", { name: "Show QR code" }));
    await user.click(screen.getByRole("button", { name: "Hide payslips" }));

    const needles = [...SECRETS, ...GOLDEN.payslips.map((row) => row.address)];
    for (const needle of needles) {
      expect(logged.join("\n")).not.toContain(needle);
      expect(stored.join("\n")).not.toContain(needle);
      for (const call of operator.calls) expect(`${call.path} ${JSON.stringify(call.body ?? null)}`).not.toContain(needle);
      // Hidden means gone from the page.
      expect(document.body.innerHTML).not.toContain(needle);
    }
    expect(window.location.href).not.toMatch(/payslip/u);
  });
});
