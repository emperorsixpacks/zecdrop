// @vitest-environment jsdom
//
// The wording of the NEAR panel, in every state it can be in, against the list of
// claims this project must not make (src/test/banned-phrases.ts): no "swap
// guaranteed", "instant", "trustless", and above all nothing that calls the
// campaign funded because a service said so.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OperatorApiError } from "@/api/operator/client";
import "@/test/dom";
import { BANNED } from "@/test/banned-phrases";
import { readEverything } from "@/test/read-everything";

import type { NearApi, NearDeposit, NearToken } from "./model";
import { NearFundingPanel } from "./NearFundingPanel";
import { describeNearStatus, KNOWN_NEAR_STATUSES, NEAR_FUNDED_ONLY_ON_CHAIN } from "./status";

const USDC: NearToken = { id: "usdc", symbol: "USDC", chain: "near", decimals: 6 };
const deposit: NearDeposit = {
  token: USDC,
  amountIn: "12345678",
  amountOut: "545000",
  depositAddress: "near-deposit-address-0001",
  depositMemo: "memo-1",
  deadline: "2030-01-01T12:00:00.000Z",
  refundTo: "refund-account.near",
};

function api(status: string): NearApi {
  let started = false;
  return {
    tokens: vi.fn(() => Promise.resolve([USDC])),
    preview: vi.fn(() => Promise.resolve({ token: USDC, amountIn: "12345678", amountOut: "545000" })),
    dryQuote: vi.fn(() => Promise.resolve({ token: USDC, amountIn: "12345678", amountOut: "545000" })),
    liveQuote: vi.fn(() => {
      started = true;
      return Promise.resolve(deposit);
    }),
    status: vi.fn(() =>
      started
        ? Promise.resolve({
            status,
            step: "await_deposit",
            depositAddress: deposit.depositAddress,
            expired: false,
            validUntil: "2030-01-01T12:00:00Z",
            zecTxids: [],
          })
        : Promise.reject(new OperatorApiError("api", 409, { code: "no_live_quote", message: "none yet" })),
    ),
  };
}

function renderPanel(network: "testnet" | "mainnet", fake: NearApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NearFundingPanel api={fake} campaign={{ id: "c-000000000001", network, fundingRequired: "545000" }} defaultOpen />
    </QueryClientProvider>,
  );
}

const read = () => document.body.textContent ?? "";
const expectClean = (text: string, where: string) => {
  for (const [label, pattern] of BANNED) expect(text, `${where}: contains the banned claim "${label}"`).not.toMatch(pattern);
};

describe("the NEAR panel's wording is free of claims it cannot back up", () => {
  it("on a testnet campaign, before and after a preview", async () => {
    const user = userEvent.setup();
    renderPanel("testnet", api("pending_deposit"));
    await user.selectOptions(await screen.findByLabelText("Asset to pay with"), "USDC on near");
    expectClean(read(), "before the preview");
    await user.click(screen.getByRole("button", { name: "Show a price preview" }));
    await screen.findByTestId("near-price");
    expectClean(read(), "after the preview");
    expectClean(await readEverything(), "the preview, with every explanation opened");
  });

  it("on a mainnet campaign: quote, confirmation and deposit", async () => {
    const user = userEvent.setup();
    renderPanel("mainnet", api("pending_deposit"));
    await user.selectOptions(await screen.findByLabelText("Asset to pay with"), "USDC on near");
    expectClean(read(), "before the quote");
    await user.type(screen.getByLabelText("Your refund address"), "refund-account.near");
    await user.click(screen.getByRole("button", { name: "Get a price quote" }));
    await screen.findByTestId("near-price");
    expectClean(read(), "the quote and the confirmation");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create the deposit address" }));
    await screen.findByTestId("near-deposit");
    expectClean(read(), "the deposit instructions");
    expectClean(await readEverything(), "the deposit instructions, with every explanation opened");
  });

  it.each([...KNOWN_NEAR_STATUSES, "A_STATUS_NOBODY_HAS_HEARD_OF"])("the status %s", (status) => {
    const d = describeNearStatus(status);
    expectClean(`${d.title} ${d.detail}`, status);
  });

  it("the line that stays on screen", () => {
    expectClean(NEAR_FUNDED_ONLY_ON_CHAIN, "the persistent line");
  });
});

describe("the guard itself catches the claims it is for", () => {
  const caught = (sentence: string) => BANNED.some(([, pattern]) => pattern.test(sentence));

  it.each([
    "Your swap is guaranteed.",
    "An instant swap.",
    "Funded instantly.",
    "A trustless bridge into ZEC.",
    "Risk-free funding.",
    "There is no risk.",
    "The campaign is automatically funded.",
    "The campaign is funded once the service says so.",
    "The swap funds the campaign.",
    "A safe and secure transfer.",
  ])("catches %j", (sentence) => {
    expect(caught(sentence)).toBe(true);
  });

  it.each([
    "The campaign counts as funded only when the coin appears on chain.",
    "The service says it sent the ZEC. That is the service's report, not proof.",
    "Nothing is created. There is no deposit address.",
    "The campaign has not been funded by this.",
  ])("lets %j through", (sentence) => {
    expect(caught(sentence)).toBe(false);
  });
});
