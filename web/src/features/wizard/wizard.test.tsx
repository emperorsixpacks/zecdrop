// @vitest-environment jsdom
//
// The five wizard steps against the operator's CAPTURED responses
// (fixtures/contract/operator), through the whole app. The sentinel CSV holds
// recognisable addresses, amounts and memos; after every step none of them may
// be on screen, in the draft store, in browser storage or in the query cache.
import { act, screen, within } from "@testing-library/react";
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

import { useWizardDraft } from "./draft";

const VALID_CSV = CSV["valid.csv"] ?? "";
const ID = FIXTURE_CAMPAIGN_ID;

/** Things that must never be displayed: the sentinel addresses, memos and amounts. */
const SENTINELS: RegExp[] = [
  /u1sentineladdress/u,
  /zs1sentineladdress/u,
  /memo-sentinel/u,
  /(?<![\d.])2\.25(?![\d])/u,
  /(?<![\d.])4\.125(?![\d])/u,
  /(?<![\d.])0\.75(?![\d])/u,
];

/** The page's markup, without the recipients box: what a person typed into the
 * box is theirs to see and fix; nothing ELSE may repeat it. */
function expectNoSentinels(where: string) {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("textarea").forEach((box) => {
    box.remove();
  });
  const html = copy.innerHTML;
  for (const pattern of SENTINELS) expect(html, `${where}: ${String(pattern)}`).not.toMatch(pattern);
}

/** The placeholder key in golden/audit-ufvk-export.json. */
const KEY = "uviewFAKEplaceholderNotAKeyNotAKeyNotAKeyNotAKey";

const mockHealth = () => replyWith("health.json");
const realHealth = () => replyWithGolden("health-real.json");

let operator: FakeOperator;

beforeEach(() => {
  useWizardDraft.getState().reset();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearSession();
  useWizardDraft.getState().reset();
});

async function fillBasics(user: ReturnType<typeof userEvent.setup>, name = "Autumn payout") {
  await user.type(screen.getByLabelText("Campaign name"), name);
  await user.click(screen.getByRole("button", { name: "Next: Recipients" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Recipients" })).toBeInTheDocument();
}

async function pasteCsv(user: ReturnType<typeof userEvent.setup>, csv: string) {
  await user.click(screen.getByLabelText("Recipients (CSV)"));
  await user.paste(csv);
}

describe("Basics", () => {
  beforeEach(() => {
    operator = installFakeOperator({ "GET /api/health": mockHealth });
  });

  it("explains both fees, defaults to the standard one, and defaults to 50 per batch", () => {
    renderApp("/new/basics", { signedIn: true });
    expect(screen.getByRole("heading", { level: 1, name: "Basics" })).toBeInTheDocument();

    const standard = screen.getByRole("radio", { name: /Standard: 5,000 zatoshi per action/u });
    const lower = screen.getByRole("radio", { name: /Lower: 1,000 zatoshi per action/u });
    expect(standard).toBeChecked();
    expect(lower).not.toBeChecked();
    // 50 payouts = 51 actions: 255,000 vs 51,000 zatoshi.
    expect(screen.getByText("A batch of 50 costs 0.00255 TAZ.")).toBeInTheDocument();
    expect(screen.getByText("A batch of 50 costs 0.00051 TAZ.")).toBeInTheDocument();

    expect(screen.getByLabelText("Payouts per batch")).toHaveValue("50");
    expect(screen.getByText(/so 50 payouts takes about 1 minute/u)).toBeInTheDocument();
  });

  it("says nothing about a single batch on the mock chain", async () => {
    renderApp("/new/basics", { signedIn: true });
    // Wait for the operator to say it is the mock chain, so "no note" is not just "not loaded yet".
    await screen.findByText("Mock chain:");
    expect(screen.queryByTestId("single-batch-note")).toBeNull();
  });

  it("on a real chain, says this build sends one batch per campaign", async () => {
    operator = installFakeOperator({ "GET /api/health": realHealth });
    renderApp("/new/basics", { signedIn: true });
    const note = await screen.findByTestId("single-batch-note");
    expect(note).toHaveTextContent("one batch per campaign");
    expect(note).toHaveTextContent("batch size to 330");
  });

  it("keeps the choice of the lower fee", async () => {
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await user.click(screen.getByRole("radio", { name: /Lower: 1,000/u }));
    expect(useWizardDraft.getState().feePolicy).toBe("zebra_main");
  });

  it("will not move on without a name, and says why", async () => {
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await user.click(screen.getByRole("button", { name: "Next: Recipients" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the campaign a name.");
    expect(screen.getByRole("heading", { level: 1, name: "Basics" })).toBeInTheDocument();
  });

  it.each([
    ["1", /at least 2 payouts/u],
    ["331", /At most 330/u],
    ["ten", /whole number/u],
  ])("rejects a batch size of %s", async (value, message) => {
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await user.type(screen.getByLabelText("Campaign name"), "x");
    const size = screen.getByLabelText("Payouts per batch");
    await user.clear(size);
    await user.type(size, value);
    await user.click(screen.getByRole("button", { name: "Next: Recipients" }));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(operator.to("POST", "/api/campaigns")).toHaveLength(0);
  });
});

describe("Recipients", () => {
  it("sends the name, CSV, batch size and fee policy to the operator once, then forgets the CSV", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => ({ status: 201, body: fixtureJson("create-valid.json") }),
    });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, VALID_CSV);
    expect(screen.getByText(/6 lines|5 lines/u)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Auditor" })).toBeInTheDocument();

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
    expect(draft.created?.id).toBe(ID);
    expect(JSON.stringify(draft)).not.toMatch(/sentinel/u);
    expectNoSentinels("after create");
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  // covers: REQ-IMP-001, REQ-PRIV-002
  it("shows import problems by line number without repeating anything from the file", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => replyWith("create-row-errors.json", 422),
    });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, CSV["row-errors.csv"] ?? "");
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));

    const box = await screen.findByRole("alert", { name: "" }).catch(() => screen.getByRole("alert"));
    const errors = (fixtureJson("create-row-errors.json") as { error: { error_count: number; errors: { line: number; message: string }[] } }).error;
    expect(screen.getByRole("heading", { level: 3, name: `${String(errors.error_count)} problems in the CSV` })).toBeInTheDocument();
    for (const e of errors.errors) {
      expect(within(box).getByText(`Line ${String(e.line)}:`)).toBeInTheDocument();
      expect(box).toHaveTextContent(e.message);
    }
    expect(screen.getByText("Nothing was created. Fix these lines and check again.")).toBeInTheDocument();
    expectNoSentinels("after an import failure");
    // Still on the step, with the text still there to fix.
    expect(screen.getByLabelText("Recipients (CSV)")).toHaveValue(CSV["row-errors.csv"] ?? "");
    expect(useWizardDraft.getState().created).toBeNull();
  });

  it("says how many problems there are when the operator lists only the first ones", async () => {
    const real = (fixtureJson("create-row-errors.json") as { error: { errors: unknown[] } }).error;
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => ({
        status: 422,
        body: { error: { ...real, error_count: real.errors.length + 500 } },
      }),
    });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, CSV["row-errors.csv"] ?? "");
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    expect(await screen.findByText(`Showing the first ${String(real.errors.length)} of ${String(real.errors.length + 500)}.`, { exact: false })).toBeInTheDocument();
  });

  it("explains a missing header row", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => replyWith("create-header-missing.json", 422),
    });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, CSV["header-missing.csv"] ?? "");
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    expect(await screen.findByText("1 problem in the CSV")).toBeInTheDocument();
    expect(screen.getByText(/the first row must be a header/u)).toBeInTheDocument();
    expectNoSentinels("after a header failure");
  });

  it("does not call the operator with an empty box", async () => {
    operator = installFakeOperator({ "GET /api/health": mockHealth });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add the recipients");
    expect(operator.to("POST", "/api/campaigns")).toHaveLength(0);
  });

  it("sends people back to the basics when they skip them", () => {
    operator = installFakeOperator({ "GET /api/health": mockHealth });
    renderApp("/new/recipients", { signedIn: true });
    expect(screen.getByRole("heading", { name: "Finish the basics first" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Recipients (CSV)")).toBeNull();
  });

  it("reads a chosen file without putting its content on the page", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => ({ status: 201, body: fixtureJson("create-valid.json") }),
    });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);

    const file = new File([VALID_CSV], "payroll.csv", { type: "text/csv" });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement, file);
    expect(await screen.findByText("payroll.csv")).toBeInTheDocument();
    expect(screen.queryByLabelText("Recipients (CSV)")).toBeNull();
    expectNoSentinels("after choosing a file");

    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    await screen.findByRole("heading", { level: 1, name: "Auditor" });
    expect(operator.to("POST", "/api/campaigns")[0]?.body).toMatchObject({ csv: VALID_CSV });
    expect(useWizardDraft.getState().csvFileName).toBeNull();
  });

  it("locks the earlier steps once the campaign exists, and offers to start over", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => ({ status: 201, body: fixtureJson("create-valid.json") }),
    });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    await screen.findByRole("heading", { level: 1, name: "Auditor" });

    await user.click(screen.getByRole("link", { name: /Basics/u }));
    expect(await screen.findByRole("heading", { name: "Basics (locked)" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Campaign name")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Start a new campaign" }));
    expect(await screen.findByLabelText("Campaign name")).toHaveValue("");
    expect(useWizardDraft.getState().created).toBeNull();
  });

  it("reports an unreachable operator in words", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (target.endsWith("/health")) return Promise.resolve(new Response(JSON.stringify(fixtureJson("health.json"))));
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    expect(await screen.findByRole("heading", { name: "Can't reach the operator" })).toBeInTheDocument();
    expect(useWizardDraft.getState().created).toBeNull();
  });
});

describe("the steps after the campaign exists", () => {
  it.each(["auditor", "review", "fund"])("%s asks for the campaign first", (slug) => {
    operator = installFakeOperator({ "GET /api/health": mockHealth });
    renderApp(`/new/${slug}`, { signedIn: true });
    expect(screen.getByRole("heading", { name: "Create the campaign first" })).toBeInTheDocument();
  });

  async function createThen(path: string) {
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    await screen.findByRole("heading", { level: 1, name: "Auditor" });
    if (path !== "auditor") await user.click(screen.getByRole("link", { name: new RegExp(`^Next: ${path}`, "u") }));
    return user;
  }

  // covers: REQ-PRIV-003
  it("Review shows the totals, the commitment, the batches and the privacy warnings", async () => {
    operator = installFakeOperator({
      "GET /api/health": mockHealth,
      "POST /api/campaigns": () => ({ status: 201, body: fixtureJson("create-valid.json") }),
    });
    await createThen("Review");
    expect(await screen.findByRole("heading", { level: 1, name: "Review" })).toBeInTheDocument();

    const created = fixtureJson("create-valid.json") as { manifest_commitment: string };
    expect(screen.getByTestId("manifest-commitment")).toHaveTextContent(created.manifest_commitment);
    expect(screen.getByText("11.625 TAZ")).toBeInTheDocument(); // declared total
    expect(screen.getByText("0.00035 TAZ")).toBeInTheDocument(); // fee
    expect(screen.getByText("11.62535 TAZ")).toBeInTheDocument(); // funding required
    expect(screen.getByRole("heading", { name: "Privacy warnings (1)" })).toBeInTheDocument();
    expect(screen.getAllByText(/two recipients/iu).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: /Batch [01]/u }).length).toBeGreaterThan(0);
    expectNoSentinels("on the review step");
  });
});

describe("Auditor", () => {
  async function toAuditor(healthReply: () => { body: unknown }, userOptions: Parameters<typeof userEvent.setup>[0] = {}) {
    operator = installFakeOperator({
      "GET /api/health": healthReply,
      "POST /api/campaigns": () => ({ status: 201, body: fixtureJson("create-valid.json") }),
      "GET /api/campaigns/:id/audit-ufvk-export": () => replyWithGolden("audit-ufvk-export.json"),
    });
    const user = userEvent.setup(userOptions);
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    await screen.findByRole("heading", { level: 1, name: "Auditor" });
    return user;
  }

  it("on the mock chain says there is no key to export and offers no button", async () => {
    await toAuditor(mockHealth);
    expect(await screen.findByText(/The mock chain has no real viewing keys/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show the viewing key" })).toBeNull();
    expect(operator.to("GET", /audit-ufvk-export/u)).toHaveLength(0);
  });

  it("states that disclosure cannot be undone before anything is requested", async () => {
    await toAuditor(realHealth);
    expect(await screen.findByText("This cannot be undone")).toBeInTheDocument();
    expect(screen.getByText(/Giving it away cannot be undone/u)).toBeInTheDocument();
    expect(screen.getByText(/each recipient address, amount and memo/u)).toBeInTheDocument();
  });

  it("releases the key only after the person says they understand, and keeps it out of the cache", async () => {
    const user = await toAuditor(realHealth);
    const button = await screen.findByRole("button", { name: "Show the viewing key" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(operator.to("GET", /audit-ufvk-export/u)).toHaveLength(0);

    await user.click(screen.getByRole("checkbox", { name: /I understand that whoever receives this key/u }));
    expect(button).toBeEnabled();
    await user.click(button);

    const key = KEY;
    expect(await screen.findByDisplayValue(key)).toBeInTheDocument();
    // The operator's reply carries the warning again; it is shown beside the key.
    expect(screen.getAllByText(/Giving it away cannot be undone/u).length).toBeGreaterThanOrEqual(2);
    const call = operator.to("GET", /audit-ufvk-export/u)[0];
    expect(call?.headers.get("X-Zecdrop-Confirm-Disclosure")).toBe("I-UNDERSTAND");

    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(JSON.stringify(useWizardDraft.getState())).not.toContain(key);

    await user.click(screen.getByRole("button", { name: "Hide key" }));
    expect(screen.queryByDisplayValue(key)).toBeNull();
  });

  it("hides the key again by itself after two minutes", async () => {
    // Fake timers must be in place BEFORE the key appears, because that is when the timer starts.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = await toAuditor(realHealth, { advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Show the viewing key" }));
    const key = KEY;
    await screen.findByDisplayValue(key);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_000);
    });
    expect(screen.getByDisplayValue(key)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByDisplayValue(key)).toBeNull();
  });
});

describe("Fund & Send", () => {
  /** Creates the campaign through the wizard and walks to the last step. */
  async function toFund(routes: Record<string, RouteHandler>, health: RouteHandler = mockHealth) {
    operator = installFakeOperator({
      "GET /api/health": health,
      "POST /api/campaigns": () => ({ status: 201, body: fixtureJson("create-valid.json") }),
      "GET /api/campaigns/:id/events": () => ({ status: 200, body: null, raw: { text: "", contentType: "text/event-stream" } }),
      ...routes,
    });
    const user = userEvent.setup();
    renderApp("/new/basics", { signedIn: true });
    await fillBasics(user);
    await pasteCsv(user, VALID_CSV);
    await user.click(screen.getByRole("button", { name: "Check and create campaign" }));
    await screen.findByRole("heading", { level: 1, name: "Auditor" });
    await user.click(screen.getByRole("link", { name: /^Next: Review/u }));
    await screen.findByRole("heading", { level: 1, name: "Review" });
    await user.click(screen.getByRole("link", { name: /^Next: Fund/u }));
    await screen.findByRole("heading", { level: 1, name: "Fund & Send" });
    return user;
  }

  it("on the mock chain: records a pretend deposit, starts, and lands on the campaign page with the draft cleared", async () => {
    let funded = false;
    const user = await toFund({
      "GET /api/campaigns/:id": () => replyWith(funded ? "campaign-funded.json" : "create-valid.json"),
      "POST /api/campaigns/:id/fund-observed": () => {
        funded = true;
        return replyWith("fund-ok.json");
      },
      "POST /api/campaigns/:id/start": () => ({ status: 202, body: fixtureJson("start-ok.json") }),
    });

    expect(screen.getByText("11.62535 TAZ")).toBeInTheDocument();
    expect(screen.getByText("Sending can start once the campaign is funded.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start sending" })).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Record mock deposit" }));
    const start = await screen.findByRole("button", { name: "Start sending" });
    await user.click(start);

    expect(await screen.findByRole("heading", { level: 1, name: "Sentinel campaign" })).toBeInTheDocument();
    expect(operator.to("POST", /\/start$/u)).toHaveLength(1);
    expect(useWizardDraft.getState().created).toBeNull();
    expectNoSentinels("on the campaign page after starting");
  });

  it("on a real chain: shows where to send the deposit instead of the mock form", async () => {
    await toFund({ "GET /api/campaigns/:id": () => replyWithGolden("create-real.json") }, realHealth);
    expect(await screen.findByTestId("funding-address")).toHaveTextContent("tFAKEfundingAddressNotARealAddress0000");
    expect(screen.queryByRole("button", { name: "Record mock deposit" })).toBeNull();
  });

  it("lets people fund and start later from the campaign's own page", async () => {
    const user = await toFund({ "GET /api/campaigns/:id": () => replyWith("create-valid.json") });
    const link = screen.getByRole("link", { name: "fund and start later" });
    expect(link).toHaveAttribute("href", `/campaign/${ID}`);
    expect(user).toBeDefined();
  });
});
