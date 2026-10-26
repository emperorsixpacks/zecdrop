// @vitest-environment jsdom
//
// The "Fund from another coin" row, against a FAKE api that returns the panel's own view
// models. The operator's wire format is tested separately, from its golden files.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperatorApiError } from "@/api/operator/client";
import "@/test/dom";

import type { NearApi, NearDeposit, NearPrice, NearStatus, NearToken } from "./model";
import { NearFundingPanel } from "./NearFundingPanel";

const USDC: NearToken = { id: "nep141:usdc.near", symbol: "USDC", chain: "near", decimals: 6 };
const ETH: NearToken = { id: "nep141:eth.near", symbol: "ETH", chain: "eth", decimals: 18 };
const SOL_USDC: NearToken = { id: "nep141:sol-usdc", symbol: "USDC", chain: "sol", decimals: 6 };
const TOKENS = [USDC, ETH, SOL_USDC];
const REFUND = "refund-account.near";

const price = (token: NearToken, amountIn: string): NearPrice => ({ token, amountIn, amountOut: "545000" });
const deposit = (patch: Partial<NearDeposit> = {}): NearDeposit => ({
  ...price(USDC, "12345678"),
  depositAddress: "near-deposit-address-0001",
  depositMemo: null,
  deadline: "2030-01-01T12:00:00.000Z",
  refundTo: REFUND,
  ...patch,
});
const statusOf = (word: string, patch: Partial<NearStatus> = {}): NearStatus => ({
  status: word,
  step: "await_deposit",
  depositAddress: "near-deposit-address-0001",
  expired: false,
  validUntil: "2030-01-01T12:00:00Z",
  zecTxids: [],
  ...patch,
});

/** The operator's answer when no deposit address has been asked for yet. */
const noSwapYet = () => new OperatorApiError("api", 409, { code: "no_live_quote", message: "no deposit address yet" });

/** `answer` is what the status call says once a deposit address exists; before that, the operator says there is none. */
function fakeApi(patch: Partial<NearApi> = {}, answer: (n: number) => Promise<NearStatus> = () => Promise.resolve(statusOf("pending_deposit"))) {
  let started = false;
  let asked = 0;
  const api = {
    tokens: vi.fn(() => Promise.resolve(TOKENS)),
    preview: vi.fn(({ tokenId }: { tokenId: string }) =>
      Promise.resolve(price(TOKENS.find((t) => t.id === tokenId) ?? USDC, "12345678")),
    ),
    dryQuote: vi.fn(({ tokenId }: { tokenId: string }) =>
      Promise.resolve(price(TOKENS.find((t) => t.id === tokenId) ?? USDC, "12345678")),
    ),
    liveQuote: vi.fn(() => {
      started = true;
      return Promise.resolve(deposit());
    }),
    status: vi.fn(() => (started ? answer(asked++) : Promise.reject(noSwapYet()))),
  };
  // A patch replaces a call wholesale; the result stays typed as the spies, so tests can read their calls.
  return { ...api, ...patch } as typeof api;
}

function renderPanel(
  api: NearApi,
  network: "testnet" | "mainnet",
  options: { wrapper?: (children: ReactNode) => ReactNode; defaultOpen?: boolean; client?: QueryClient } = {},
) {
  const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const panel = (
    <NearFundingPanel
      api={api}
      campaign={{ id: "c-000000000001", network, fundingRequired: "545000" }}
      defaultOpen={options.defaultOpen ?? true}
    />
  );
  return render(<QueryClientProvider client={client}>{options.wrapper ? options.wrapper(panel) : panel}</QueryClientProvider>);
}

const unreachable = () => new OperatorApiError("api", 503, { code: "near_unavailable", message: "no answer" });

afterEach(() => {
  vi.useRealTimers();
});

async function choose(user: ReturnType<typeof userEvent.setup>, label: string) {
  const select = await screen.findByLabelText("Asset to pay with");
  await user.selectOptions(select, label);
}

const FUNDED_LINE = "The campaign counts as funded only when the coin appears on chain.";

describe("the row", () => {
  it("is closed to begin with, and asks the service nothing until it is opened", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderPanel(api, "testnet", { defaultOpen: false });
    const row = screen.getByRole("button", { name: "Fund from another coin" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Asset to pay with")).toBeNull();
    expect(api.tokens).not.toHaveBeenCalled();

    await user.click(row);
    expect(await screen.findByLabelText("Asset to pay with")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(api.tokens).toHaveBeenCalledTimes(1);
  });

  it("is a row, not a section: no heading of its own", () => {
    renderPanel(fakeApi(), "testnet", { defaultOpen: false });
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("on a testnet campaign: a price preview", () => {
  it("says it is a price check, and a Why? explains mainnet ZEC only and what size of campaign it prices", async () => {
    const user = userEvent.setup();
    renderPanel(fakeApi(), "testnet");
    expect(await screen.findByText(/Price check only/u)).toHaveTextContent("NEAR Intents works with mainnet ZEC.");
    await user.click(screen.getByRole("button", { name: "Why a price check only" }));
    const why = (await screen.findByText(/mainnet ZEC only/u)).closest("p");
    // Mainnet ZEC, not the testnet coin: the preview is for a campaign this size on mainnet.
    expect(why).toHaveTextContent("a campaign of this size (0.00545 ZEC) on mainnet");
    expect(document.body.textContent).not.toMatch(/TAZ/u);
  });

  it("lists the assets, sorted, and can narrow them by typing", async () => {
    const user = userEvent.setup();
    renderPanel(fakeApi(), "testnet");
    const select = await screen.findByLabelText("Asset to pay with");
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["Choose an asset…", "ETH on eth", "USDC on near", "USDC on sol"]);

    await user.type(screen.getByLabelText("Find an asset"), "sol");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose an asset…", "USDC on sol"]);
    expect(screen.getByText("1 asset")).toBeInTheDocument();
  });

  it("shows a preview for the chosen asset, rounded up, labelled as a preview that creates nothing", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderPanel(api, "testnet");
    await choose(user, "USDC on near");
    await user.click(screen.getByRole("button", { name: "Show a price preview" }));

    const shown = await screen.findByTestId("near-price");
    expect(within(shown).getByText("Preview")).toBeInTheDocument();
    expect(shown).toHaveTextContent("To fund a campaign this size on mainnet (0.00545 ZEC) you would send about 12.345678 USDC on near.");
    expect(shown).toHaveTextContent("Nothing is created. There is no deposit address.");
    expect(api.preview).toHaveBeenCalledWith({ tokenId: USDC.id, fundingRequired: "545000" });
  });

  it("sets the amount in the proportional figures: tabular ones would put a gap around its decimal point", async () => {
    const user = userEvent.setup();
    renderPanel(fakeApi(), "testnet");
    await choose(user, "USDC on near");
    await user.click(screen.getByRole("button", { name: "Show a price preview" }));
    const amount = (await screen.findByTestId("near-price")).querySelector("strong");
    expect(amount).toHaveTextContent("12.345678 USDC");
    expect(amount?.className ?? "").not.toMatch(/tabular|mono|tnum/u);
  });

  it("never asks for a real quote, a deposit address or the status of a swap", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderPanel(api, "testnet");
    await choose(user, "ETH on eth");
    await user.click(screen.getByRole("button", { name: "Show a price preview" }));
    await screen.findByTestId("near-price");
    expect(api.dryQuote).not.toHaveBeenCalled();
    expect(api.liveQuote).not.toHaveBeenCalled();
    expect(api.status).not.toHaveBeenCalled();
    expect(screen.queryByTestId("near-deposit")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText("Your refund address")).toBeNull();
    expect(screen.queryByText(/deposit address\b/iu)).toBeInTheDocument(); // only in "There is no deposit address."
    expect(document.body.textContent).not.toMatch(/Create the deposit address/u);
  });

  it("clears the preview when another asset is chosen", async () => {
    const user = userEvent.setup();
    renderPanel(fakeApi(), "testnet");
    await choose(user, "USDC on near");
    await user.click(screen.getByRole("button", { name: "Show a price preview" }));
    await screen.findByTestId("near-price");
    await choose(user, "ETH on eth");
    expect(screen.queryByTestId("near-price")).toBeNull();
  });

  it("will not ask for a preview before an asset is chosen", async () => {
    renderPanel(fakeApi(), "testnet");
    await screen.findByLabelText("Asset to pay with");
    expect(screen.getByRole("button", { name: "Show a price preview" })).toBeDisabled();
  });

  it("always carries the line that the campaign counts as funded only when the coin is on chain", async () => {
    renderPanel(fakeApi(), "testnet");
    await screen.findByLabelText("Asset to pay with");
    expect(screen.getByText(FUNDED_LINE)).toBeInTheDocument();
  });
});

describe("when the price service cannot be reached", () => {
  it("the asset list says so, calmly, and tries again on request", async () => {
    let up = false;
    const api = fakeApi({ tokens: vi.fn(() => (up ? Promise.resolve(TOKENS) : Promise.reject(unreachable()))) });
    const user = userEvent.setup();
    renderPanel(api, "testnet");
    expect(await screen.findByRole("heading", { name: "The price service could not be reached" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing was created/u)).toBeInTheDocument();

    up = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Asset to pay with")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed preview says so and leaves the form usable", async () => {
    const user = userEvent.setup();
    renderPanel(fakeApi({ preview: vi.fn(() => Promise.reject(unreachable())) }), "testnet");
    await choose(user, "USDC on near");
    await user.click(screen.getByRole("button", { name: "Show a price preview" }));
    expect(await screen.findByRole("heading", { name: "The price service could not be reached" })).toBeInTheDocument();
    expect(screen.queryByTestId("near-price")).toBeNull();
    expect(screen.getByRole("button", { name: "Show a price preview" })).toBeEnabled();
  });

  it.each([502, 503, 504])("a %i from the operator is the same thing", async (status) => {
    renderPanel(fakeApi({ tokens: vi.fn(() => Promise.reject(new OperatorApiError("api", status, null))) }), "testnet");
    expect(await screen.findByRole("heading", { name: "The price service could not be reached" })).toBeInTheDocument();
  });

  it("the operator itself being unreachable is said as that, not as the price service", async () => {
    renderPanel(fakeApi({ tokens: vi.fn(() => Promise.reject(new OperatorApiError("unreachable"))) }), "testnet");
    expect(await screen.findByRole("heading", { name: "Can't reach the operator" })).toBeInTheDocument();
  });

  it("any other refusal is explained like any operator error, never as a crash", async () => {
    renderPanel(
      fakeApi({ tokens: vi.fn(() => Promise.reject(new OperatorApiError("api", 409, { code: "not_applicable", message: "x" }))) }),
      "testnet",
    );
    expect(await screen.findByRole("heading", { name: "Nothing to check on the mock chain" })).toBeInTheDocument();
    renderPanel(fakeApi({ tokens: vi.fn(() => Promise.reject(new Error("boom"))) }), "testnet");
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
  });

  it("says when the service lists no assets", async () => {
    renderPanel(fakeApi({ tokens: vi.fn(() => Promise.resolve([])) }), "testnet");
    expect(await screen.findByText("The service lists no assets right now.")).toBeInTheDocument();
  });

  it("a deposit address the operator could not keep is shown, so it is not stranded", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      liveQuote: vi.fn(() =>
        Promise.reject(
          new OperatorApiError("api", 500, {
            code: "near_quote_not_saved",
            message: "kept nowhere",
            depositAddress: "stranded-address.near",
            deadline: "2030-01-01T12:00:00Z",
          }),
        ),
      ),
    });
    await toQuote(api, user);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Create the deposit address" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("stranded-address.near");
    expect(alert).toHaveTextContent(/will not track it/u);
  });
});

async function toQuote(api: NearApi, user: ReturnType<typeof userEvent.setup>, client?: QueryClient) {
  renderPanel(api, "mainnet", client === undefined ? {} : { client });
  await choose(user, "USDC on near");
  await user.type(screen.getByLabelText("Your refund address"), REFUND);
  await user.click(screen.getByRole("button", { name: "Get a price quote" }));
  await screen.findByTestId("near-price");
}

describe("on a mainnet campaign: quote, confirm, deposit", () => {
  it("asks first where a swap stands, and with none shows the form", async () => {
    const api = fakeApi();
    renderPanel(api, "mainnet");
    expect(await screen.findByLabelText("Asset to pay with")).toBeInTheDocument();
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("near-deposit")).toBeNull();
  });

  it("a price quote needs a refund address the operator will accept", async () => {
    const user = userEvent.setup();
    renderPanel(fakeApi(), "mainnet");
    await choose(user, "USDC on near");
    const ask = screen.getByRole("button", { name: "Get a price quote" });
    expect(ask).toBeDisabled();
    const refund = screen.getByLabelText("Your refund address");
    await user.type(refund, "has a space");
    expect(ask).toBeDisabled();
    await user.clear(refund);
    await user.type(refund, "<script>");
    expect(ask).toBeDisabled();
    await user.clear(refund);
    await user.type(refund, REFUND);
    expect(ask).toBeEnabled();
  });

  it("a price quote creates nothing: no deposit address is asked for until the person confirms", async () => {
    const api = fakeApi();
    await toQuote(api, userEvent.setup());
    expect(api.dryQuote).toHaveBeenCalledWith({ campaignId: "c-000000000001", tokenId: USDC.id, refundTo: REFUND });
    expect(within(screen.getByTestId("near-price")).getByText("Price quote")).toBeInTheDocument();
    expect(api.liveQuote).not.toHaveBeenCalled();
    expect(screen.queryByTestId("near-deposit")).toBeNull();
  });

  it("the deposit address needs its own 'I understand', saying that real money moves", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    await toQuote(api, user);

    expect(screen.getByRole("heading", { name: "Next: a deposit address" })).toBeInTheDocument();
    expect(screen.getByText(/creates a deposit address, and what you send there is real money/u)).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create the deposit address" });
    expect(create).toBeDisabled();
    await user.click(create);
    expect(api.liveQuote).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: /I understand that this creates a deposit address/u }));
    expect(create).toBeEnabled();
    await user.click(create);
    await screen.findByTestId("near-deposit");
    expect(api.liveQuote).toHaveBeenCalledTimes(1);
    expect(api.liveQuote).toHaveBeenCalledWith({ campaignId: "c-000000000001", tokenId: USDC.id });
  });

  it("then shows the amount, the address with a copy button, the deadline, the refund address, and starts following the swap", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    await toQuote(api, user);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Create the deposit address" }));

    const shown = await screen.findByTestId("near-deposit");
    expect(within(shown).getByRole("heading", { name: "Send 12.345678 USDC on near" })).toBeInTheDocument();
    expect(within(shown).getByTestId("near-deposit-address")).toHaveTextContent("near-deposit-address-0001");
    expect(within(shown).getByRole("button", { name: "Copy deposit address" })).toBeInTheDocument();
    expect(within(shown).queryByTestId("near-deposit-memo")).toBeNull();
    expect(shown).toHaveTextContent(/Send it before/u);
    expect(shown).toHaveTextContent(`A late or short deposit goes back to ${REFUND}`);
    expect(await screen.findByTestId("near-status")).toHaveTextContent("Waiting for the deposit");
    expect(api.status).toHaveBeenCalledWith({ campaignId: "c-000000000001" }, expect.anything());
    expect(screen.getByText(FUNDED_LINE)).toBeInTheDocument();
  });

  it("shows a memo with its own copy button when the chain needs one", async () => {
    const api = fakeApi({ liveQuote: vi.fn(() => Promise.resolve(deposit({ depositMemo: "memo-123" }))) });
    const user = userEvent.setup();
    await toQuote(api, user);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Create the deposit address" }));
    const shown = await screen.findByTestId("near-deposit");
    expect(within(shown).getByTestId("near-deposit-memo")).toHaveTextContent("memo-123");
    expect(within(shown).getByText(/Memo \(required with this deposit\)/u)).toBeInTheDocument();
    expect(within(shown).getByRole("button", { name: "Copy deposit memo" })).toBeInTheDocument();
  });

  it("a failed real quote shows why and no deposit address", async () => {
    const api = fakeApi({ liveQuote: vi.fn(() => Promise.reject(unreachable())) });
    const user = userEvent.setup();
    await toQuote(api, user);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Create the deposit address" }));
    expect(await screen.findByRole("heading", { name: "The price service could not be reached" })).toBeInTheDocument();
    expect(screen.queryByTestId("near-deposit")).toBeNull();
    expect(api.status).toHaveBeenCalledTimes(1); // only the first look, before anything existed
  });

  it("choosing another asset after a quote takes the tick away", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    await toQuote(api, user);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await choose(user, "ETH on eth");
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Get a price quote" }));
    await screen.findByTestId("near-price");
    expect(screen.getByRole("checkbox", { name: /I understand/u })).not.toBeChecked();
  });

  it("changing the refund address after a quote takes the quote and the tick away", async () => {
    const user = userEvent.setup();
    await toQuote(fakeApi(), user);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await user.type(screen.getByLabelText("Your refund address"), "x");
    expect(screen.queryByTestId("near-price")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("closing the row does not lose the deposit address: opening it again shows it, and asks for no new one", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
    await toQuote(api, user, client);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Create the deposit address" }));
    await screen.findByTestId("near-deposit");

    const row = screen.getByRole("button", { name: "Fund from another coin" });
    await user.click(row);
    await waitFor(() => {
      expect(screen.queryByTestId("near-deposit")).toBeNull();
    });
    await user.click(row);
    const again = await screen.findByTestId("near-deposit");
    expect(within(again).getByRole("heading", { name: "Send 12.345678 USDC on near" })).toBeInTheDocument();
    expect(api.liveQuote).toHaveBeenCalledTimes(1);
  });

  it("a swap that was started before the page was opened is shown from what the operator kept", async () => {
    const api = fakeApi({ status: vi.fn(() => Promise.resolve(statusOf("processing", { step: "await_swap" }))) });
    renderPanel(api, "mainnet");
    const shown = await screen.findByTestId("near-deposit");
    expect(within(shown).getByRole("heading", { name: "A swap for this campaign is already under way" })).toBeInTheDocument();
    expect(within(shown).getByTestId("near-deposit-address")).toHaveTextContent("near-deposit-address-0001");
    expect(await screen.findByTestId("near-status")).toHaveTextContent("Swap in progress");
    expect(screen.queryByLabelText("Asset to pay with")).toBeNull();
    expect(api.liveQuote).not.toHaveBeenCalled();
    expect(api.dryQuote).not.toHaveBeenCalled();
  });

  it("if the first look at the swap fails, it says so and offers no form to start another", async () => {
    const user = userEvent.setup();
    let up = false;
    const api = fakeApi({ status: vi.fn(() => (up ? Promise.reject(noSwapYet()) : Promise.reject(unreachable()))) });
    renderPanel(api, "mainnet");
    expect(await screen.findByRole("heading", { name: "The price service could not be reached" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Asset to pay with")).toBeNull();
    up = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Asset to pay with")).toBeInTheDocument();
  });
});

describe("following the swap", () => {
  async function toDeposit(answer: (n: number) => Promise<NearStatus>) {
    const api = fakeApi({}, answer);
    const user = userEvent.setup();
    await toQuote(api, user);
    await user.click(screen.getByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Create the deposit address" }));
    await screen.findByTestId("near-deposit");
    return { api, user };
  }

  it.each([
    ["pending_deposit", "Waiting for the deposit"],
    ["known_deposit_tx", "Deposit seen"],
    ["processing", "Swap in progress"],
    ["success", "Paid to the deposit address, says the service"],
    ["incomplete_deposit", "The deposit was smaller than quoted"],
    ["refunded", "Refunded"],
    ["failed", "The swap failed"],
  ])("%s is shown as %j, and the campaign is not called funded", async (word, title) => {
    await toDeposit(() => Promise.resolve(statusOf(word)));
    const card = await screen.findByTestId("near-status");
    expect(within(card).getByText(title)).toBeInTheDocument();
    expect(screen.getByText(FUNDED_LINE)).toBeInTheDocument();
    expect(screen.queryByText(/^Funded$/u)).toBeNull();
  });

  it("success is the service's report: it names the transaction to look for, and says the chain decides", async () => {
    const txid = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    await toDeposit(() => Promise.resolve(statusOf("success", { step: "verify_on_chain", zecTxids: [txid] })));
    const card = await screen.findByTestId("near-status");
    expect(card).toHaveTextContent("not proof");
    expect(card).toHaveTextContent("a1b2c3d4…6d7e8f90");
    expect(card).toHaveTextContent("The operator looks for the coin itself.");
    expect(card.textContent).not.toMatch(/is funded|now funded|has been funded|was funded/iu);
  });

  it("a lapsed deposit address says so, whatever else the service reports", async () => {
    await toDeposit(() => Promise.resolve(statusOf("pending_deposit", { expired: true })));
    const card = await screen.findByTestId("near-status");
    expect(within(card).getByText(/This deposit address has expired\. Do not send to it\./u)).toBeInTheDocument();
  });

  it("the word 'unknown' says to investigate, and stops following it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = await toDeposit(() => Promise.resolve(statusOf("unknown", { step: "investigate" })));
    const card = await screen.findByTestId("near-status");
    expect(card).toHaveTextContent("The service reported something this page does not know");
    expect(card).toHaveTextContent("Do not send more");
    const calls = api.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(api.status.mock.calls.length).toBe(calls);
  });

  it("a word this page has never heard of is shown as text, and also stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = await toDeposit(() => Promise.resolve(statusOf("mystery_state", { step: "investigate" })));
    const card = await screen.findByTestId("near-status");
    expect(card).toHaveTextContent('"mystery_state"');
    expect(card).toHaveTextContent("Do not send more");
    const calls = api.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(api.status.mock.calls.length).toBe(calls);
  });

  it("keeps asking while the swap can still change, and stops when it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = ["pending_deposit", "processing", "refunded"];
    const { api } = await toDeposit((n) => Promise.resolve(statusOf(answers[Math.min(n, answers.length - 1)] ?? "")));
    await waitFor(() => {
      expect(api.status).toHaveBeenCalledTimes(2); // the first look, then the one after the address was made
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(await screen.findByText("Refunded")).toBeInTheDocument();
    const calls = api.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.status.mock.calls.length).toBe(calls);
  });

  it("a failed status check says so and can be retried, and does not hide the deposit address", async () => {
    let up = false;
    const { user } = await toDeposit(() => (up ? Promise.resolve(statusOf("processing")) : Promise.reject(unreachable())));
    expect(await screen.findByRole("heading", { name: "The price service could not be reached" })).toBeInTheDocument();
    expect(screen.getByTestId("near-deposit-address")).toBeInTheDocument();
    up = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Swap in progress")).toBeInTheDocument();
  });
});

describe("what the panel never does", () => {
  it("mentions no login, token or key, and offers no field for one", async () => {
    renderPanel(fakeApi(), "testnet");
    await screen.findByLabelText("Asset to pay with");
    expect(document.body.textContent).not.toMatch(/\bJWT\b|\bbearer\b|\blog ?in\b|\bsign ?in\b|api key|password/iu);
    expect(document.querySelector("input[type='password']")).toBeNull();
  });

  it("shows no recipient data, and loads nothing from another host", async () => {
    renderPanel(fakeApi(), "testnet");
    await screen.findByLabelText("Asset to pay with");
    expect(document.body.textContent).not.toMatch(/u1[a-z0-9]{20,}|memo-sentinel|sentineladdress/u);
    for (const element of document.querySelectorAll("[src],[href]")) {
      const target = element.getAttribute("src") ?? element.getAttribute("href") ?? "";
      expect(target, element.outerHTML).not.toMatch(/^(https?:)?\/\//u);
    }
  });

  it("keeps the refund address in the page only: not in storage, not in the address bar", async () => {
    const user = userEvent.setup();
    await toQuote(fakeApi(), user);
    expect(JSON.stringify({ ...localStorage })).not.toContain(REFUND);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(REFUND);
    expect(window.location.href).not.toContain(REFUND);
  });
});
