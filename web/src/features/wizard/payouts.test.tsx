// @vitest-environment jsdom
//
// The three stages (Payouts, Check, Send) against the operator's CAPTURED
// responses (fixtures/contract/operator), through the whole app. The sentinel CSV
// holds recognisable addresses, amounts and memos. The list may be on screen while
// the person works on it (the preview), but once the campaign exists none of it is
// anywhere, and no sentence the page builds ever repeats it.
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import {
  FIXTURE_CAMPAIGN_ID,
  installFakeOperator,
  replyWith,
  replyWithGolden,
  type FakeOperator,
  type RouteHandler,
} from "@/test/fake-operator";
import { CSV, fixtureJson } from "@/test/operator-fixtures";
import { renderApp } from "@/test/render-app";

import { AUDIENCE_STORAGE_KEY, useAudience } from "@/lib/audience";

import { useWizardDraft } from "./draft";

const VALID_CSV = CSV["valid.csv"] ?? "";
const ROW_ERRORS_CSV = CSV["row-errors.csv"] ?? "";
const ID = FIXTURE_CAMPAIGN_ID;

/** Things that must never be repeated by anything the page BUILDS: the sentinel addresses, memos and amounts. */
const SENTINELS: RegExp[] = [
  /u1sentineladdress/u,
  /zs1sentineladdress/u,
  /memo-sentinel/u,
  /(?<![\d.])2\.25(?![\d])/u,
  /(?<![\d.])4\.125(?![\d])/u,
  /(?<![\d.])0\.75(?![\d])/u,
];

/** The page's markup without the list the person is working on: the preview rows and the text boxes. */
function outsideTheList(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("textarea, [data-recipient-preview]").forEach((el) => {
    el.remove();
  });
  return copy.innerHTML;
}

function expectNoSentinels(html: string, where: string) {
  for (const pattern of SENTINELS) expect(html, `${where}: ${String(pattern)}`).not.toMatch(pattern);
}

const mockHealth: RouteHandler = () => replyWith("health.json");
const realHealth: RouteHandler = () => replyWithGolden("health-real.json");

let operator: FakeOperator;

beforeEach(() => {
  useWizardDraft.getState().reset();
  useAudience.setState({ audience: "personal" });
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearSession();
  useWizardDraft.getState().reset();
});

type User = ReturnType<typeof userEvent.setup>;

/** Choose the organisation view, which starts from a file or a pasted list. */
async function openImport(user: User) {
  await user.click(await screen.findByRole("radio", { name: "Organisation" }));
}

/** Paste a list into the drop zone, the way a person does. */
async function pasteList(user: User, csv: string) {
  await openImport(user);
  await user.click(await screen.findByRole("button", { name: "or paste it" }));
  await user.click(screen.getByLabelText("Paste your list"));
  await user.paste(csv);
}

const created = () => ({ status: 201, body: fixtureJson("create-valid.json") });

describe("Stage 1: Payouts", () => {
  beforeEach(() => {
    operator = installFakeOperator({ "GET /api/health": mockHealth, "POST /api/campaigns": created });
  });

  // covers: REQ-IMP-002
  it("starts with the people being paid, one to fill in, and keeps a file one switch away", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    expect(screen.getByRole("heading", { level: 1, name: "Add the payouts" })).toBeInTheDocument();
    const list = screen.getByTestId("people-list");
    expect(within(list).getByRole("group", { name: "Person 1" })).toBeInTheDocument();
    expect(within(list).getByLabelText("Address")).toHaveValue("");
    expect(within(list).getByLabelText("Amount")).toHaveValue("");
    expect(within(list).getByLabelText("Note they'll see")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add a person" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    // No spreadsheet is asked for, and no options; an organisation's view has both.
    expect(screen.queryByText("Drop a CSV here")).toBeNull();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
    await openImport(user);
    expect(screen.getByText("Drop a CSV here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "or paste it" })).toBeInTheDocument();
  });

  it("the first screen says in one line what to do and that nothing is sent yet, and the line goes once a list is imported", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    expect(screen.getByText("Add the people you're paying. Nothing is sent yet.")).toBeInTheDocument();
    await pasteList(user, "address,amount\nu1x,1\n");
    await screen.findByTestId("payout-table");
    expect(screen.queryByText("Add the people you're paying. Nothing is sent yet.")).toBeNull();
  });

  describe("who it is for", () => {
    it("is personal until the person says otherwise: the people list, no file, no options", () => {
      renderApp("/new", { signedIn: true });
      expect(screen.getByRole("radio", { name: "Personal" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByText("Family, friends or a few people, typed in one by one.")).toBeInTheDocument();
      expect(screen.getByTestId("people-list")).toBeInTheDocument();
      expect(screen.queryByText("Drop a CSV here")).toBeNull();
      expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
      expect(localStorage.getItem(AUDIENCE_STORAGE_KEY)).toBeNull();
    });

    it("for an organisation: a file first, the options, and the people list one click away, and the choice is remembered", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await user.click(screen.getByRole("radio", { name: "Organisation" }));
      expect(screen.getByText("Import your list, or add people one by one. Nothing is sent yet.")).toBeInTheDocument();
      expect(screen.getByText("Drop a CSV here")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
      expect(screen.queryByTestId("people-list")).toBeNull();
      expect(localStorage.getItem(AUDIENCE_STORAGE_KEY)).toBe("organisation");

      await user.click(screen.getByRole("button", { name: "Add people one by one instead" }));
      expect(screen.getByTestId("people-list")).toBeInTheDocument();
      expect(screen.queryByText("Drop a CSV here")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Import a list instead" }));
      expect(screen.getByText("Drop a CSV here")).toBeInTheDocument();
    });

    it("for an organisation with no list yet, Continue says what to do and sends nothing", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await user.click(screen.getByRole("radio", { name: "Organisation" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByText("Import a list, or add people one by one.")).toHaveAttribute("role", "alert");
      expect(operator.to("POST", "/api/campaigns")).toHaveLength(0);
    });

    it("keeps a list typed in when the view changes, and sends it the same", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      const list = screen.getByTestId("people-list");
      await user.click(within(list).getByLabelText("Address"));
      await user.paste("u1sentineladdressaaaaaaaaaaaaaaaaaaaa");
      await user.click(within(list).getByLabelText("Amount"));
      await user.keyboard("1");
      await user.click(screen.getByRole("radio", { name: "Organisation" }));
      await user.click(screen.getByRole("button", { name: "Add people one by one instead" }));
      expect(within(screen.getByTestId("people-list")).getByLabelText("Address")).toHaveValue("u1sentineladdressaaaaaaaaaaaaaaaaaaaa");
    });
  });

  it("offers a default name, so the field can be left alone", () => {
    renderApp("/new", { signedIn: true });
    const field = screen.getByLabelText("Name this payout run");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", expect.stringMatching(/^Payout, \d{1,2} [A-Z][a-z]{2}$/u));
  });

  it("shows the tracker with Payouts as the step you are on", () => {
    renderApp("/new", { signedIn: true });
    const tracker = screen.getByRole("navigation", { name: "Progress" });
    expect(within(tracker).getByText("Payouts").closest("[aria-current='step']")).not.toBeNull();
    expect(within(tracker).getByText("Check")).toBeInTheDocument();
    expect(within(tracker).getByText("Send")).toBeInTheDocument();
  });

  it("shows the list as soon as it is pasted: how many people, the total, and the rows", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);

    expect(screen.getByTestId("payout-count")).toHaveTextContent("5 people");
    expect(screen.getByTestId("payout-total")).toHaveTextContent("11.625 TAZ");
    const rows = within(screen.getByTestId("payout-table")).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("1.5 TAZ");
    // The drop zone has gone, and Continue is the one thing to do.
    expect(screen.queryByText("Drop a CSV here")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    // Nothing was sent anywhere yet.
    expect(operator.to("POST", "/api/campaigns")).toHaveLength(0);
  });

  it("says plainly what a list without a header needs, before anything is sent", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, CSV["header-missing.csv"] ?? "");
    expect(screen.getByRole("alert")).toHaveTextContent("The first row should name the columns");
    expect(operator.to("POST", "/api/campaigns")).toHaveLength(0);
  });

  it("replaces the list on request, and edits it as text", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);

    await user.click(screen.getByRole("button", { name: "Edit as text" }));
    const box = screen.getByLabelText("Payout list as text");
    expect(box).toHaveValue(VALID_CSV);
    fireEvent.change(box, { target: { value: "address,amount\nu1x,1\n" } });
    expect(screen.getByTestId("payout-count")).toHaveTextContent("1 person");
    expect(screen.getByTestId("payout-total")).toHaveTextContent("1 TAZ");

    await user.click(screen.getByRole("button", { name: "Use a different list" }));
    expect(screen.getByText("Drop a CSV here")).toBeInTheDocument();
    expect(useWizardDraft.getState().csvText).toBe("");
  });

  it("reads a chosen file, shows its name, and keeps its content off the rest of the page", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await openImport(user);
    const file = new File([VALID_CSV], "payroll.csv", { type: "text/csv" });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement, file);
    expect(await screen.findByText("payroll.csv")).toBeInTheDocument();
    expect(screen.getByTestId("payout-count")).toHaveTextContent("5 people");
    expectNoSentinels(outsideTheList(), "after choosing a file");
  });

  it("refuses a file over 32 MB without reading it", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await openImport(user);
    const big = new File(["x"], "big.csv", { type: "text/csv" });
    Object.defineProperty(big, "size", { value: 33 * 1024 * 1024 });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement, big);
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than 32 MB");
    expect(screen.getByText("Drop a CSV here")).toBeInTheDocument();
  });

  describe("options", () => {
    it("are closed until asked for, and then explain both fees with the standard one chosen", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await pasteList(user, VALID_CSV);
      expect(screen.queryByRole("radio", { name: /Standard/u })).toBeNull();

      await user.click(screen.getByRole("button", { name: "Options" }));
      expect(screen.getByRole("radio", { name: /Standard \(recommended\)/u })).toBeChecked();
      expect(screen.getByRole("radio", { name: /Lower/u })).not.toBeChecked();
      expect(screen.getByText("0.00255 TAZ for 50 payouts")).toBeInTheDocument();
      expect(screen.getByText("0.00051 TAZ for 50 payouts")).toBeInTheDocument();
      expect(screen.getByLabelText("Payouts per batch")).toHaveValue("50");
      expect(screen.getByText(/50 payouts take about 1 minute/u)).toBeInTheDocument();
    });

    it("keep the technical detail behind a question mark, not on the page", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await pasteList(user, VALID_CSV);
      await user.click(screen.getByRole("button", { name: "Options" }));
      expect(document.body.textContent).not.toMatch(/zatoshi|ZIP-317/u);
      await user.click(screen.getByRole("button", { name: "About the network fee" }));
      expect(await screen.findByText(/5,000 zatoshi per action/u)).toBeInTheDocument();
      expect(screen.getByText(/ZIP-317/u)).toBeInTheDocument();
    });

    it("remember the lower fee", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await pasteList(user, VALID_CSV);
      await user.click(screen.getByRole("button", { name: "Options" }));
      await user.click(screen.getByRole("radio", { name: /Lower/u }));
      expect(useWizardDraft.getState().feePolicy).toBe("zebra_main");
    });

    it.each([
      ["1", /at least 2 payouts/u],
      ["331", /At most 330/u],
      ["ten", /whole number/u],
    ])("refuse a batch size of %s, and nothing is sent", async (value, message) => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await pasteList(user, VALID_CSV);
      await user.click(screen.getByRole("button", { name: "Options" }));
      const size = screen.getByLabelText("Payouts per batch");
      await user.clear(size);
      await user.type(size, value);
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(operator.to("POST", "/api/campaigns")).toHaveLength(0);
    });

    it("on the practice chain, add no note about one batch per campaign", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await pasteList(user, VALID_CSV);
      await user.click(screen.getByRole("button", { name: "Options" }));
      await screen.findByLabelText("Payouts per batch");
      expect(screen.queryByTestId("single-batch-note")).toBeNull();
    });
  });

  describe("Continue", () => {
    it("sends the name, list, batch size and fee once, forgets the list, and goes to Check", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await user.type(screen.getByLabelText("Name this payout run"), "Autumn payout");
      await pasteList(user, VALID_CSV);
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Check the payouts" })).toBeInTheDocument();

      const posts = operator.to("POST", "/api/campaigns");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toEqual({
        name: "Autumn payout",
        csv: VALID_CSV,
        max_outputs_per_batch: 50,
        fee_policy: "zip317_text",
      });
      expect(posts[0]?.headers.get("Authorization")).toMatch(/^Bearer [0-9a-f]{64}$/u);

      const draft = useWizardDraft.getState();
      expect(draft.csvText).toBe("");
      expect(draft.csvFileName).toBeNull();
      expect(draft.created?.id).toBe(ID);
      // The CSV text is gone. The parsed rows stay for the Check stage's lens, in memory, and nothing else does.
      expect(draft.list).toHaveLength(5);
      expect(JSON.stringify({ ...draft, list: null })).not.toMatch(/sentinel/u);
      expectNoSentinels(document.body.innerHTML, "after create");
      // The one thing kept is the choice of view, which holds nothing of the list.
      expect(Object.keys({ ...localStorage })).toEqual([AUDIENCE_STORAGE_KEY]);
      expect(sessionStorage.length).toBe(0);
    });

    it("uses the default name when none is typed", async () => {
      const user = userEvent.setup();
      renderApp("/new", { signedIn: true });
      await pasteList(user, VALID_CSV);
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", { level: 1, name: "Check the payouts" });
      expect((operator.to("POST", "/api/campaigns")[0]?.body as { name: string }).name).toMatch(/^Payout, \d{1,2} [A-Z][a-z]{2}$/u);
    });
  });

  // covers: REQ-IMP-001, REQ-PRIV-002
  describe("when the operator finds problems", () => {
    beforeEach(() => {
      operator = installFakeOperator({
        "GET /api/health": mockHealth,
        "POST /api/campaigns": () => replyWith("create-row-errors.json", 422),
      });
    });

    async function toProblems(user: User) {
      renderApp("/new", { signedIn: true });
      await pasteList(user, ROW_ERRORS_CSV);
      await user.click(screen.getByRole("button", { name: "Continue" }));
      return await screen.findByText(/problems to fix\./u);
    }

    const real = (fixtureJson("create-row-errors.json") as { error: { error_count: number; errors: { line: number; message: string }[] } }).error;

    it("says how many, puts each in the row it is about, and creates nothing", async () => {
      const summary = await toProblems(userEvent.setup());
      expect(summary).toHaveTextContent(`${String(real.error_count)} problems to fix.`);
      expect(summary).toHaveAttribute("role", "alert");
      for (const e of real.errors) {
        expect(screen.getAllByText(`Line ${String(e.line)}: ${e.message}`).length, `line ${String(e.line)}`).toBeGreaterThan(0);
      }
      expect(useWizardDraft.getState().created).toBeNull();
      // Still the same page, list intact, so it can be fixed.
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      expect(useWizardDraft.getState().csvText).toBe(ROW_ERRORS_CSV);
    });

    it("never repeats anything from the list in what it says, and keeps the list itself to the preview", async () => {
      await toProblems(userEvent.setup());
      expectNoSentinels(outsideTheList(), "after an import failure");
      for (const message of screen.getAllByText(/^Line \d+:/u)) expectNoSentinels(message.textContent ?? "", "a problem sentence");
      // The one thing kept is the choice of view, which holds nothing of the list.
      expect(Object.keys({ ...localStorage })).toEqual([AUDIENCE_STORAGE_KEY]);
      expect(sessionStorage.length).toBe(0);
    });

    it("can show only the rows with problems", async () => {
      const user = userEvent.setup();
      await toProblems(user);
      const table = screen.getByTestId("payout-table");
      const all = within(table).getAllByRole("listitem").length;
      await user.click(screen.getByRole("button", { name: /Show only the \d+ rows with problems/u }));
      const only = within(table).getAllByRole("listitem").length;
      expect(only).toBeLessThan(all);
      expect(only).toBeGreaterThan(0);
      await user.click(screen.getByRole("button", { name: "Show all rows" }));
      expect(within(table).getAllByRole("listitem")).toHaveLength(all);
    });

    it("says when the operator lists only the first ones", async () => {
      operator = installFakeOperator({
        "GET /api/health": mockHealth,
        "POST /api/campaigns": () => ({ status: 422, body: { error: { ...real, error_count: real.errors.length + 500 } } }),
      });
      const summary = await toProblems(userEvent.setup());
      expect(summary).toHaveTextContent(`${String(real.errors.length + 500)} problems to fix.`);
    });

    it("a changed list drops the old verdict", async () => {
      const user = userEvent.setup();
      await toProblems(user);
      await user.click(screen.getByRole("button", { name: "Edit as text" }));
      await user.type(screen.getByLabelText("Payout list as text"), "x");
      expect(screen.queryByText(/problems to fix\./u)).toBeNull();
    });
  });

  it("explains a missing header row in the operator's own sentence", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => replyWith("create-header-missing.json", 422),
    });
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, CSV["header-missing.csv"] ?? "");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/1 problem to fix\./u)).toBeInTheDocument();
    expect(screen.getByText(/the first row must be a header/u)).toBeInTheDocument();
    expectNoSentinels(outsideTheList(), "after a header failure");
  });

  it("reports an unreachable operator in words, and keeps the list", async () => {
    installFakeOperator({ "GET /api/health": mockHealth });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (target.endsWith("/health")) return Promise.resolve(new Response(JSON.stringify(fixtureJson("health.json"))));
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Can't reach the operator" })).toBeInTheDocument();
    expect(useWizardDraft.getState().created).toBeNull();
    expect(useWizardDraft.getState().csvText).toBe(VALID_CSV);
  });

  // covers: REQ-OPS-003
  it("says in words when a mainnet campaign is over the operator's limit, and keeps the list to fix", async () => {
    const said =
      "this operator caps a mainnet campaign at 0.1 ZEC of funding and this one needs 0.5 ZEC; raise the cap with --mainnet-max-funding-zat (in zatoshi) only if you mean to";
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => ({ status: 422, body: { error: { code: "mainnet_cap_exceeded", message: said } } }),
    });
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const alert = (await screen.findByRole("heading", { name: "That campaign is over the mainnet limit" })).closest("[role='alert']") as HTMLElement;
    expect(alert).toHaveTextContent("This operator caps a mainnet campaign at 0.1 ZEC of funding and this one needs 0.5 ZEC;");
    expect(alert).toHaveTextContent("To get under the cap, shorten the list or lower the amounts.");
    expect(alert.textContent).not.toContain("mainnet_cap_exceeded");
    // Nothing was created, the list is still there to fix, and the same button tries again.
    expect(useWizardDraft.getState().created).toBeNull();
    expect(useWizardDraft.getState().csvText).toBe(VALID_CSV);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expectNoSentinels(outsideTheList(), "after the cap refusal");
  });

  it("on a real chain, says one batch per campaign", async () => {
    installFakeOperator({ "GET /api/health": realHealth, "POST /api/campaigns": created });
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Options" }));
    const note = await screen.findByTestId("single-batch-note");
    expect(note).toHaveTextContent("one batch per campaign");
    expect(note).toHaveTextContent("Set 330");
  });

  it("after the payouts are added, the first stage is a place to continue from, not to edit", async () => {
    installFakeOperator({ "GET /api/health": mockHealth, "POST /api/campaigns": created });
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check the payouts" });

    await user.click(screen.getByRole("link", { name: "Payouts" }).closest("a") ?? screen.getByRole("link", { name: "Payouts" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Payouts" })).toBeInTheDocument();
  });
});

describe("Stage 2: Check", () => {
  it("asks for the payouts first when there are none", () => {
    installFakeOperator({ "GET /api/health": mockHealth });
    renderApp("/new/check", { signedIn: true });
    expect(screen.getByRole("heading", { name: "Add the payouts first" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add the payouts" })).toHaveAttribute("href", "/new");
  });

  async function toCheck() {
    operator = installFakeOperator({ "GET /api/health": mockHealth, "POST /api/campaigns": created });
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check the payouts" });
    return user;
  }

  // covers: REQ-PRIV-003
  it("opens with one big line: how many people, the total and the fee", async () => {
    await toCheck();
    const line = screen.getByTestId("payout-summary");
    expect(line).toHaveTextContent("5 people");
    expect(line).toHaveTextContent("11.625 TAZ");
    expect(line).toHaveTextContent("+ 0.00035 TAZ fee");
    expect(screen.getByText(/^To fund:/u)).toHaveTextContent(/^To fund: 11\.62535 TAZ\. \d+ batch(es)? of up to \d+ payouts\.$/u);
    expect(screen.getByText(/Takes about \d+ seconds? to build\./u)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Privacy warnings (1)" })).toBeInTheDocument();
    expectNoSentinels(document.body.innerHTML, "on the check stage");
  });

  it("keeps the batches and the list fingerprint behind a click", async () => {
    const user = await toCheck();
    const created = fixtureJson("create-valid.json") as { manifest_commitment: string };
    expect(screen.queryByTestId("manifest-commitment")).toBeNull();
    await user.click(screen.getByRole("button", { name: "List fingerprint" }));
    expect(screen.getByTestId("manifest-commitment")).toHaveTextContent(created.manifest_commitment);
    expect(screen.getByRole("button", { name: "Copy list fingerprint" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batches" }));
    expect(screen.getAllByRole("heading", { level: 3, name: /^Batch \d$/u }).length).toBeGreaterThan(0);
  });

  // covers: REQ-PRIV-002
  describe("the lens on the real list", () => {
    const rows = () => screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-revealed"));

    it("starts public: five rows, every address and amount a bar, none of the list in the page", async () => {
      await toCheck();
      expect(rows()).toHaveLength(5);
      expect(rows().map((r) => r.firstElementChild?.textContent)).toEqual(["Person 1", "Person 2", "Person 3", "Person 4", "Person 5"]);
      expect(screen.getAllByRole("img", { name: "hidden" })).toHaveLength(10);
      expectNoSentinels(document.body.innerHTML, "the public view");
    });

    it("'One person' reveals one real row, and nothing of the others", async () => {
      const user = await toCheck();
      await user.click(screen.getByRole("radio", { name: "One person" }));
      expect(rows().map((r) => r.getAttribute("data-revealed"))).toEqual(["true", "false", "false", "false", "false"]);
      expect(rows()[0]).toHaveTextContent("1.5 TAZ");
      expect(rows()[0]).toHaveTextContent("memo-sentinel-one");
      expect(document.body.innerHTML).not.toMatch(/(?<![\d.])(2\.25|0\.75|4\.125)(?![\d])/u);
      expect(document.body.innerHTML).not.toMatch(/memo-sentinel-(two|four)/u);

      await user.selectOptions(screen.getByLabelText("Who?"), "Person 2");
      expect(rows()[1]).toHaveTextContent("2.25 TAZ");
      expect(document.body.innerHTML).not.toMatch(/memo-sentinel-one/u);
    });

    it("'Auditor' reveals every row; going back to 'Public' takes it all out of the page again", async () => {
      const user = await toCheck();
      await user.click(screen.getByRole("radio", { name: "Auditor" }));
      expect(rows().every((r) => r.getAttribute("data-revealed") === "true")).toBe(true);
      expect(document.body.innerHTML).toMatch(/memo-sentinel-four/u);
      await user.click(screen.getByRole("radio", { name: "Public" }));
      expectNoSentinels(document.body.innerHTML, "back in the public view");
    });
  });

  it("explains each warning in the core's own sentence, one tap away", async () => {
    const user = await toCheck();
    const chip = screen.getAllByRole("listitem").find((li) => /Only \d+ people|Batch \d/u.test(li.textContent ?? ""));
    expect(chip).toBeDefined();
    await user.click(within(chip as HTMLElement).getByRole("button", { name: /^Why:/u }));
    expect(await screen.findByText(/the public total narrows down every amount|each can work out the other's amount|reveals each amount/u)).toBeInTheDocument();
  });

  it("goes on to Send, and lets go of the list on the way", async () => {
    const user = await toCheck();
    expect(useWizardDraft.getState().list).not.toBeNull();
    expect(screen.getByRole("link", { name: "Looks right, continue" })).toHaveAttribute("href", "/new/send");
    await user.click(screen.getByRole("link", { name: "Looks right, continue" }));
    expect(useWizardDraft.getState().list).toBeNull();
    expect(useWizardDraft.getState().created?.id).toBe(ID);
  });

  it("starts over: the draft goes, and so does the list, and the first stage is open again", async () => {
    const user = await toCheck();
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(useWizardDraft.getState().created).toBeNull();
    expect(useWizardDraft.getState().list).toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: "Add the payouts" })).toBeInTheDocument();
  });

  it("does not show a list that was let go of, and says so", async () => {
    await toCheck();
    useWizardDraft.getState().releaseList();
    expect(await screen.findByText(/The list is not kept once you leave this step/u)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Auditor" })).toBeNull();
  });
});

describe("Stage 3: Send", () => {
  it("asks for the payouts first when there are none", () => {
    installFakeOperator({ "GET /api/health": mockHealth });
    renderApp("/new/send", { signedIn: true });
    expect(screen.getByRole("heading", { name: "Add the payouts first" })).toBeInTheDocument();
  });

  async function toSend(routes: Record<string, RouteHandler>, health: RouteHandler = mockHealth) {
    operator = installFakeOperator({
      "GET /api/health": health,
      "POST /api/campaigns": created,
      "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
      ...routes,
    });
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await pasteList(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check the payouts" });
    await user.click(screen.getByRole("link", { name: "Looks right, continue" }));
    await screen.findByRole("heading", { level: 1, name: "Fund and send" });
    return user;
  }

  it("on the practice chain: records a pretend deposit, asks once, sends, and lands on the campaign page with the draft cleared", async () => {
    let funded = false;
    const user = await toSend({
      "GET /api/campaigns/:id": () => replyWith(funded ? "campaign-funded.json" : "create-valid.json"),
      "POST /api/campaigns/:id/fund-observed": () => {
        funded = true;
        return replyWith("fund-ok.json");
      },
      "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-ok.json") }),
    });
    expect(await screen.findByText("Sentinel campaign")).toBeInTheDocument();
    expect(screen.getByTestId("payout-summary")).toHaveTextContent("11.625 TAZ");
    // Not yet: there is nothing to send until it is funded.
    expect(screen.getByRole("button", { name: "Send 5 payouts" })).toBeDisabled();
    expect(screen.getByText("Sending can start once the campaign is funded.")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Record mock deposit" }));
    await user.click(await screen.findByRole("button", { name: "Send 5 payouts" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send 5 payouts" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" })).toBeInTheDocument();
    expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
    expect(useWizardDraft.getState().created).toBeNull();
    expect(useWizardDraft.getState().list).toBeNull();
    expectNoSentinels(document.body.innerHTML, "on the campaign page after starting");
  });

  it("lets go of the list as soon as the third stage opens", async () => {
    await toSend({ "GET /api/campaigns/:id": () => replyWith("create-valid.json") });
    expect(useWizardDraft.getState().list).toBeNull();
    expectNoSentinels(document.body.innerHTML, "on the send stage");
  });

  it("on a real chain: asks 'Is it funded?' and shows where to send the deposit instead of the practice form", async () => {
    await toSend({ "GET /api/campaigns/:id": () => replyWithGolden("create-real.json") }, realHealth);
    expect(await screen.findByRole("heading", { name: "Is it funded?" })).toBeInTheDocument();
    expect(await screen.findByTestId("funding-address")).toHaveTextContent("tFAKEfundingAddressNotARealAddress0000");
    expect(screen.queryByRole("button", { name: "Record mock deposit" })).toBeNull();
  });

  it("lets people go back to check, or fund and start later from the campaign's own page", async () => {
    await toSend({ "GET /api/campaigns/:id": () => replyWith("create-valid.json") });
    expect(screen.getByRole("link", { name: "Fund and start later" })).toHaveAttribute("href", `/campaign/${ID}`);
    expect(screen.getByRole("link", { name: "Back to check" })).toHaveAttribute("href", "/new/check");
  });
});

describe("the old five-step addresses", () => {
  it.each(["/new/basics", "/new/recipients", "/new/auditor", "/new/review", "/new/fund", "/new/bogus"])("%s is not a page", (path) => {
    installFakeOperator({ "GET /api/health": mockHealth });
    renderApp(path, { signedIn: true });
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});
