// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import "@/test/dom";
import mismatch from "../../../../fixtures/contract/public-receipt-declared-mismatch.json?raw";
import findings from "../../../../fixtures/contract/public-receipt-findings.json?raw";
import golden from "../../../../fixtures/contract/public-receipt.json?raw";

import { RECEIPT_SOURCE_WORDING } from "./funding-source-wording";
import ReceiptPage from "./ReceiptPage";

// ---- Harness ---------------------------------------------------------------

const wire = () => JSON.parse(golden) as Record<string, unknown>;
const TX = "a".repeat(64);
const COMMITMENT = "e".repeat(64);

/** A link that matches the golden receipt exactly. */
const GOOD_LINK =
  `/r/camp-01?network=testnet&tx=${TX}&commitment=${COMMITMENT}&declared_total=534500000`;

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/r/:id" element={<ReceiptPage />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every call gets a fresh Response (a body can be read only once). */
function verifierSays(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The hook retries connectivity failures with a backoff (1s, then 2s); step
 * through it so the final error state is reached without really waiting. */
async function waitOutRetries() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
}

const batchTable = () => screen.getByRole("table", { name: "Payout batches" });
const batchCards = () => screen.getByRole("list", { name: "Payout batches" });

const ALL_SECTIONS = ["Transaction", "Funding address", "List fingerprint", "What this proves and what it does not", "Details"] as const;

/** Show a receipt, then open the parts behind a click that a test needs. The summary
 * is always there; the transaction table, the funding address, the fingerprint and
 * the "what this proves" text open on request. "Transactions" is the same section
 * when there is more than one batch. */
async function showReceipt(path: string, ...sections: string[]) {
  const user = userEvent.setup();
  const view = renderAt(path);
  await screen.findByRole("heading", { level: 2, name: "Status" });
  for (const name of sections) await user.click(screen.getByRole("button", { name }));
  return { user, view };
}

const verdict = () => screen.getByTestId("verdict");

// ---- The sample receipt ----------------------------------------------------

describe("/r/demo?demo=1", () => {
  it("works with no backend and says plainly that it is a sample", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { user } = await showReceipt("/r/demo?demo=1");

    expect(screen.getByText("Sample data: a campaign in progress")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/not a real campaign/u)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows status in plain language, with progress while sending", async () => {
    await showReceipt("/r/demo?demo=1");

    expect(screen.getByText("Sending: 1 of 2 batches confirmed")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Batches confirmed" });
    expect(bar).toHaveAttribute("aria-valuetext", "1 of 2 batches confirmed");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
  });

  it("starts with one verdict line: where it stands, how many payouts, the total, the fee", async () => {
    await showReceipt("/r/demo?demo=1");
    expect(verdict()).toHaveTextContent(/^Sending: \d+ payouts in 2 batches, 5\.345 TAZ, fee 0\.00035 TAZ$/u);
    // The same total, in the strip of where the funds went.
    const strip = screen.getByRole("list", { name: "Where the funds went" });
    expect(within(strip).getByText("5.345 TAZ")).toBeInTheDocument();
    expect(within(strip).getByText(/^\d+ outputs$/u)).toBeInTheDocument();
  });

  it("shows the totals in TAZ (the testnet coin), not zatoshi", async () => {
    await showReceipt("/r/demo?demo=1");
    expect(verdict()).toHaveTextContent("5.345 TAZ");
    expect(verdict()).toHaveTextContent("fee 0.00035 TAZ");
    expect(verdict().textContent).not.toMatch(/zatoshi|\b\d{7,}\b/u);
  });

  it("puts the batches in a real table with proper headers, behind 'Transactions'", async () => {
    await showReceipt("/r/demo?demo=1");
    expect(screen.queryByRole("table", { name: "Payout batches" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Transactions" }));

    const table = within(batchTable());
    const headers = table.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual([
      "Batch",
      "Transaction",
      "Into the shielded pool",
      "Fee",
      "Shielded outputs",
      "Pool",
      "Status",
    ]);
    const rows = table.getAllByRole("row").slice(1); // skip the header row
    expect(rows).toHaveLength(2);

    const first = within(rows[0] as HTMLElement);
    expect(first.getByRole("rowheader")).toHaveTextContent("0");
    expect(first.getByText("4.85 TAZ")).toBeInTheDocument();
    expect(first.getByText("0.0002 TAZ")).toBeInTheDocument();
    expect(first.getByText("Ironwood")).toBeInTheDocument();
    expect(first.getByText("Confirming")).toBeInTheDocument();
    expect(first.getByText("5 confirmations")).toBeInTheDocument();
  });

  it("gives a built batch a short id, a copy button and an explorer link", async () => {
    await showReceipt("/r/demo?demo=1", "Transactions");
    const row = within(within(batchTable()).getAllByRole("row")[1] as HTMLElement);

    expect(row.getByText("aaaaaaaa…aaaaaaaa")).toHaveAttribute("title", TX);
    expect(
      row.getByRole("button", { name: "Copy transaction id for batch 0" }),
    ).toBeInTheDocument();

    const link = row.getByRole("link", { name: /Explorer for batch 0/u });
    expect(link).toHaveAttribute("href", expect.stringContaining(TX));
    expect(link).toHaveAttribute("href", expect.stringMatching(/^https:\/\//u));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleName(/opens in a new tab/u);
  });

  it("shows a batch that is not built yet as pending, with nothing to copy", async () => {
    await showReceipt("/r/demo?demo=1", "Transactions");
    const row = within(within(batchTable()).getAllByRole("row")[2] as HTMLElement);

    expect(row.getByText("Not built yet")).toBeInTheDocument();
    expect(row.getByText("Not sent yet")).toBeInTheDocument();
    expect(row.queryByRole("button")).toBeNull();
    expect(row.queryByRole("link")).toBeNull();
  });

  it("offers the same batches as cards for narrow screens", async () => {
    await showReceipt("/r/demo?demo=1", "Transactions");

    const cards = within(batchCards()).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByRole("heading", { name: "Batch 0" })).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText("Confirming")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("Not built yet")).toBeInTheDocument();
  });

  it("copies a transaction id and the fingerprint", async () => {
    const { user } = await showReceipt("/r/demo?demo=1", "Transactions", "List fingerprint");
    // Installed after userEvent.setup(), which installs its own clipboard stub.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const row = within(within(batchTable()).getAllByRole("row")[1] as HTMLElement);
    await user.click(row.getByRole("button", { name: "Copy transaction id for batch 0" }));
    expect(writeText).toHaveBeenLastCalledWith(TX);

    await user.click(screen.getByRole("button", { name: "Copy list fingerprint" }));
    expect(writeText).toHaveBeenLastCalledWith(COMMITMENT);
  });

  it("shows the fingerprint in full and explains what it is for", async () => {
    await showReceipt("/r/demo?demo=1", "List fingerprint");

    expect(screen.getByText(COMMITMENT)).toBeInTheDocument();
    expect(screen.getByText(/salted fingerprint/u)).toBeInTheDocument();
    expect(screen.getByText(/the public cannot check it/u)).toBeInTheDocument();
    // The technical name is still there, for anyone who looks for it.
    expect(screen.getByText(/manifest commitment/u)).toBeInTheDocument();
  });

  it("keeps the technical names out of the page until asked", async () => {
    await showReceipt("/r/demo?demo=1");
    expect(document.body.textContent).not.toMatch(/manifest|commitment|zatoshi|ZIP-317/iu);
  });

  it("says what it proves AND what it does not, in the boundary doc's terms", async () => {
    await showReceipt("/r/demo?demo=1", "What this proves and what it does not");

    const proves = screen
      .getByRole("heading", { level: 3, name: "Anyone can check, from chain data alone" })
      .closest("section") as HTMLElement;
    expect(proves).toHaveTextContent("How much transparent value left the funding address.");
    expect(proves).toHaveTextContent(
      "exactly that amount, minus the fee, entered the shielded pool in each batch transaction",
    );
    expect(proves).toHaveTextContent("binding signature fixes this number");
    expect(proves).toHaveTextContent("In how many shielded outputs it went, at what fee");
    expect(proves).toHaveTextContent("funded = change + shielded + fee");
    // What the deposit spent is a fact anyone can read; who paid it is not (REQ-VER-007).
    expect(proves).toHaveTextContent("Whether the deposit came out of the shielded pool, which names no payer address");
    // Three items at most, in each list.
    expect(within(proves).getAllByRole("listitem").length).toBeLessThanOrEqual(3);

    const doesNot = screen
      .getByRole("heading", { level: 3, name: "What this does not prove" })
      .closest("section") as HTMLElement;
    expect(doesNot).toHaveTextContent("reached different people, or that it matches a payout list");
    expect(doesNot).toHaveTextContent("A payment to the operator's own address");
    expect(doesNot).toHaveTextContent("a hidden shielded spend all look identical to the public");
    expect(doesNot).toHaveTextContent(
      "Only an auditor holding the campaign's viewing key can confirm the count and the sum",
    );
    expect(doesNot).toHaveTextContent("a batch of one, or of equal amounts");
    expect(doesNot).toHaveTextContent("or who paid the deposit");
    expect(doesNot).toHaveTextContent("a deposit's amount and time are public even when it names no address");
    expect(doesNot).toHaveTextContent("verifier's source of chain data is dishonest");
    expect(within(doesNot).getAllByRole("listitem").length).toBeLessThanOrEqual(3);

    expect(within(doesNot).getByRole("link", { name: "audit page" })).toHaveAttribute("href", "/audit");
    expect(screen.getByRole("link", { name: "how privacy works" })).toHaveAttribute("href", "/privacy");
  });

  it("is honest about how far this has been checked: public testnet yes, mainnet and audit no", async () => {
    await showReceipt("/r/demo?demo=1", "What this proves and what it does not");
    const note = screen.getByText(/transaction shape has been confirmed on public testnet/u);
    expect(note).toHaveTextContent("has not been independently audited");
    expect(note).toHaveTextContent("mainnet is untested");
    // The sentence it replaced is no longer true and must not come back.
    expect(document.body.textContent).not.toMatch(/not yet confirmed on a live network|checked offline/u);
  });

  it("does not turn the output count into information about people", async () => {
    await showReceipt("/r/demo?demo=1", ...ALL_SECTIONS.map((name) => (name === "Transaction" ? "Transactions" : name)));
    // "N shielded outputs" is public and fine; "N recipients" is not a claim this page makes.
    expect(document.body.textContent).not.toMatch(/number of recipients|how many (people|recipients)/iu);
    // The public view names its rows by what the chain shows: outputs, not people.
    expect(screen.getAllByText(/^Output \d+$/u).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\bPerson \d/u);
  });

  it("does not claim the value reached third parties", async () => {
    await showReceipt("/r/demo?demo=1");
    expect(document.body.textContent).not.toMatch(/was paid to|reached the recipients/iu);
  });

  it("is not available without the demo flag", async () => {
    verifierSays(200, wire());
    renderAt("/r/demo");
    expect(await screen.findByText("This receipt link is incomplete")).toBeInTheDocument();
  });
});

describe("the public view on a receipt", () => {
  it("is the public lens only: one bar per output, no address and no amount, and a note on what an auditor sees", async () => {
    await showReceipt("/r/demo?demo=real", ...ALL_SECTIONS);
    const rows = screen.getByRole("heading", { name: "What the public sees" }).closest("section") as HTMLElement;
    const items = within(rows).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    for (const [i, item] of items.entries()) {
      expect(item).toHaveTextContent(`Output ${String(i + 1)}`);
      expect(item.getAttribute("data-revealed")).toBe("false");
      expect(within(item).getAllByRole("img", { name: "hidden" })).toHaveLength(2);
    }
    expect(rows).toHaveTextContent("Who got each output, and how much, stays hidden");
    expect(rows).toHaveTextContent("An auditor with the campaign's viewing key can see every row");
    // There is no switch: this page cannot know more than the public does.
    expect(within(rows).queryByRole("radio")).toBeNull();
  });

  it("shows the first dozen outputs and counts the rest", async () => {
    const big = { ...wire(), batches: [{ ...(wire()["batches"] as Record<string, unknown>[])[0], shielded_actions: 40 }] };
    verifierSays(200, big);
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    const section = screen.getByRole("heading", { name: "What the public sees" }).closest("section") as HTMLElement;
    expect(within(section).getAllByRole("listitem")).toHaveLength(12);
    expect(section).toHaveTextContent("And 28 more outputs, hidden the same way.");
  });

  it("says when a batch's output count could not be established, and invents no rows for it", async () => {
    await showReceipt("/r/demo?demo=findings");
    const section = screen.getByRole("heading", { name: "What the public sees" }).closest("section") as HTMLElement;
    expect(section.textContent).toMatch(/could not be established/u);
  });
});

// ---- The other two samples -------------------------------------------------

describe("/r/demo?demo=findings", () => {
  it("shows what a verifier that could not confirm everything looks like", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/r/demo?demo=findings");

    const heading = await screen.findByRole("heading", { level: 2, name: "What the verifier found" });
    const card = heading.closest("section") as HTMLElement;
    expect(within(card).getByRole("heading", { level: 3, name: "Needs attention (5)" })).toBeInTheDocument();
    expect(within(card).getByRole("heading", { level: 3, name: "Not final yet (3)" })).toBeInTheDocument();
    expect(screen.getByText("Needs attention: a batch failed")).toBeInTheDocument();
    // The verdict sits above the findings, and says what it could not establish.
    expect(verdict()).toHaveTextContent("fee Unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows no raw finding codes to people", async () => {
    renderAt("/r/demo?demo=findings");
    await screen.findByRole("heading", { level: 2, name: "What the verifier found" });
    const text = document.body.textContent ?? "";
    for (const code of [
      "tx_not_found",
      "tx_unparseable",
      "prevout_unresolved",
      "negative_fee",
      "balance_mismatch",
      "unexpected_pool",
      "mixed_funding_sources",
      "batch_pending",
      "declared_total_mismatch",
    ]) {
      expect(text, code).not.toContain(code);
    }
  });

  it("explains a signature mismatch carefully, without claiming wrongdoing", async () => {
    renderAt("/r/demo?demo=findings");
    const sentence = await screen.findByText(
      "Batch 6: the shielded value balance does not match the transaction's own signature.",
    );
    expect(sentence).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/fraud|forged|tamper|stolen|scam|malicious/iu);
  });
});

describe("/r/demo?demo=mismatch", () => {
  it("shows a declared total that does not add up, calmly, for an unnamed campaign", async () => {
    renderAt("/r/demo?demo=mismatch");
    const heading = await screen.findByRole("heading", { level: 2, name: "What the verifier found" });
    const card = heading.closest("section") as HTMLElement;
    expect(card).toHaveTextContent(
      "The batches add up to a different total than the one declared for this campaign.",
    );
    expect(screen.getByText("Sample data: a declared total that does not add up")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/stolen|lost|fraud|scam|missing funds/iu);
  });
});

// ---- The real samples: batches mined on public testnet ---------------------

const ADDRESS = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";

/** The two real samples, with what is true of each. */
const REAL_SAMPLES = [
  {
    path: "/r/demo?demo=real",
    label: "the 8-output batch (the default sample)",
    txid: "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955",
    line: "Real batch on public testnet, captured at height 4,533,356",
    heights: ["Mined on public testnet at height 4,478,289", "captured at height 4,533,356"],
    verdict: "Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ",
    declared: "0.005 TAZ",
    outputs: "8",
  },
  {
    path: "/r/demo?demo=real-smoke",
    label: "the first batch, a smaller one",
    txid: "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3",
    line: "The first real batch on public testnet, captured at height 4,533,356",
    heights: ["Mined on public testnet at height 4,478,065", "captured at height 4,533,356"],
    verdict: "Settled: 3 payouts, 0.0006 TAZ, fee 0.0002 TAZ",
    declared: "0.0006 TAZ",
    outputs: "3",
  },
] as const;

describe.each(REAL_SAMPLES)("$path: $label", ({ path, txid, line, heights, verdict: sentence, declared, outputs }) => {
  it("works with no backend, and says what it is in one line: captured on public testnet, not live", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { user } = await showReceipt(path);

    expect(screen.getByText(line)).toBeInTheDocument();
    // The provenance is one click away, and says what the one line cannot.
    expect(screen.queryByText(/confirmations are shown as of the capture/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Details" }));
    const details = screen.getByText(/confirmations are shown as of the capture/u).closest("div") as HTMLElement;
    for (const text of heights) expect(details).toHaveTextContent(text);
    expect(details).toHaveTextContent("Testnet coins have no value");
    // Explorers are third parties; the page says they can lag, and does not promise the link opens it.
    expect(details).toHaveTextContent("Explorers are third parties and can lag behind the chain");
    expect(details.textContent).not.toMatch(/opens it/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call itself an example or placeholder data, because it is neither", async () => {
    await showReceipt(path, "Details");
    expect(document.body.textContent).not.toMatch(/not a real campaign|placeholders|example data|Sample data/u);
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it("shows the real transaction with an explorer link to that txid on the default testnet explorer (ZecBlock)", async () => {
    await showReceipt(path, "Transaction");
    const links = screen.getAllByRole("link").filter((a) => (a.getAttribute("href") ?? "").includes(txid));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(`https://testnet.zecblock.com/tx/${txid}`);
    }
  });

  it("opens with the verdict, in TAZ, the testnet coin, and says it has no value", async () => {
    await showReceipt(path);
    expect(verdict()).toHaveTextContent(sentence);
    expect(document.body.textContent).not.toMatch(/\d ZEC\b/u);
    expect(screen.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeInTheDocument();
  });

  it("reads as ONE batch with several shielded outputs, not several batches", async () => {
    await showReceipt(path, "Transaction");
    expect(screen.getByText("Complete: all batches confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What the verifier found" })).toBeNull();

    // The verdict counts payouts and does not talk of batches when there is one.
    expect(verdict().textContent).not.toMatch(/batch/u);
    // The funds strip says how many outputs came out, and what went into the pool.
    const strip = within(screen.getByRole("list", { name: "Where the funds went" }));
    expect(strip.getByText(`${outputs} outputs`)).toBeInTheDocument();
    expect(strip.getByText(declared)).toBeInTheDocument();

    // The section is "Transaction", and its table has one row, with the outputs as a column.
    const rows = within(batchTable()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    const headers = within(batchTable()).getAllByRole("columnheader").map((h) => h.textContent);
    const column = headers.indexOf("Shielded outputs");
    expect(column).toBeGreaterThanOrEqual(0);
    // Row cells in column order, including the row header.
    const cells = Array.from((rows[0] as HTMLElement).children);
    expect(cells[column]).toHaveTextContent(new RegExp(`^${outputs}$`, "u"));
  });

  it("shows the real funding address, short, with copy and a link to its page on the default testnet explorer", async () => {
    await showReceipt(path, "Funding address");
    const card = screen.getByTestId("funding-section");
    const shown = within(card).getByTestId("funding-address");
    expect(shown).toHaveTextContent("tmU6c1aX…B3nkZGkD");
    expect(shown).toHaveAttribute("title", ADDRESS);
    expect(within(card).getByRole("link", { name: /Explorer/u })).toHaveAttribute(
      "href",
      `https://testnet.zecblock.com/address/${ADDRESS}`,
    );
    expect(within(card).queryByText("Unknown")).toBeNull();
  });

  it("shows no recipient, no individual amount and no memo", async () => {
    await showReceipt(path, "Transaction", "Funding address", "List fingerprint", "What this proves and what it does not", "Details");
    expect(document.body.textContent).not.toMatch(/\bu1[a-z0-9]{20,}|\bzs1|memo/iu);
  });
});

describe("the samples' links", () => {
  it("'Sample receipt' opens the 8-output batch", () => {
    expect(SAMPLE_RECEIPT_HREF).toBe("/r/demo?demo=real");
  });
});

describe("the sample switcher", () => {
  const SHORT = ["Real batch", "First batch", "In progress", "With findings", "Total mismatch"];

  it.each([
    ["/r/demo?demo=real", "Real batch"],
    ["/r/demo?demo=real-smoke", "First batch"],
    ["/r/demo?demo=1", "In progress"],
    ["/r/demo?demo=findings", "With findings"],
    ["/r/demo?demo=mismatch", "Total mismatch"],
  ])("on %s it is one compact control with the five samples, set to %s", async (path, current) => {
    renderAt(path);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    const select = screen.getByLabelText("Sample");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(SHORT);
    expect(select).toHaveDisplayValue(current);
    // A control, not a sentence of links.
    expect(screen.queryAllByRole("link").filter((a) => (a.getAttribute("href") ?? "").startsWith("/r/demo"))).toHaveLength(0);
  });

  it("says which sample you are looking at, and what it shows, behind 'Details'", async () => {
    const { user } = await showReceipt("/r/demo?demo=findings");
    expect(screen.queryByText(/could not confirm everything, and reports each problem/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/could not confirm everything, and reports each problem/u)).toBeInTheDocument();
  });

  it("switches sample when another is chosen", async () => {
    const { user } = await showReceipt("/r/demo?demo=1");
    await user.selectOptions(screen.getByLabelText("Sample"), "With findings");
    expect(await screen.findByRole("heading", { level: 2, name: "What the verifier found" })).toBeInTheDocument();
    expect(screen.getByLabelText("Sample")).toHaveDisplayValue("With findings");
  });

  it("is not there on a real link, which is not a sample", async () => {
    verifierSays(200, wire());
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(screen.queryByLabelText("Sample")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });
});

// ---- Live receipts ---------------------------------------------------------

// ---- The funding address ---------------------------------------------------

describe("the funding address", () => {
  const card = () => screen.getByTestId("funding-section");
  const REAL_ADDRESS = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";

  it("is shown short, with the full address to copy, and the sentence about comparing it", async () => {
    await showReceipt("/r/demo?demo=1", "Funding address");
    const placeholder = "tFAKEfundingAddressNotARealAddress0000";
    expect(within(card()).getByTestId("funding-address")).toHaveTextContent("tFAKEfun…ress0000");
    expect(within(card()).getByTestId("funding-address")).toHaveAttribute("title", placeholder);
    expect(within(card()).getByRole("button", { name: "Copy funding address" })).toBeInTheDocument();
    expect(card()).toHaveTextContent(
      "Every batch on this receipt spends from this address; compare it with the address the campaign published.",
    );
  });

  it("shows it short, in the strip of where the funds went, without opening anything", async () => {
    await showReceipt("/r/demo?demo=real");
    const strip = within(screen.getByRole("list", { name: "Where the funds went" }));
    expect(strip.getByText("tmU6c1…nkZGkD")).toHaveAttribute("title", REAL_ADDRESS);
  });

  it("says that batches not built yet are not included, when there are some", async () => {
    await showReceipt("/r/demo?demo=1", "Funding address"); // one of its two batches has no transaction yet
    expect(card()).toHaveTextContent("Batches that are not built yet are not included.");
  });

  it("says the campaign id is only a label, and what actually ties a receipt to a campaign", async () => {
    await showReceipt("/r/demo?demo=1", "Funding address");
    expect(card()).toHaveTextContent("only a label from whoever made the link");
    expect(card()).toHaveTextContent("funding address and the list fingerprint");
  });

  it("is Unknown, never blank, when the verifier could not establish one", async () => {
    await showReceipt("/r/demo?demo=findings", "Funding address"); // funding_address is null in this golden
    expect(within(card()).getByText("Unknown")).toBeInTheDocument();
    expect(card()).toHaveTextContent("could not establish one address that every batch spends from");
    expect(within(card()).queryByTestId("funding-address")).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Copy funding address" })).toBeNull();
    expect(within(card()).queryByRole("link")).toBeNull();
    // And the strip says so too.
    const strip = within(screen.getByRole("list", { name: "Where the funds went" }));
    expect(strip.getAllByText("Unknown").length).toBeGreaterThan(0);
  });

  it("gets no explorer link when the text is not an address a link can safely hold", async () => {
    await showReceipt("/r/demo?demo=1", "Funding address"); // the golden carries an obvious placeholder
    expect(within(card()).queryByRole("link")).toBeNull();
  });

  it("links a real address to the explorer's address page for the receipt's network", async () => {
    verifierSays(200, { ...wire(), funding_address: REAL_ADDRESS });
    const user = userEvent.setup();
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    await user.click(screen.getByRole("button", { name: "Funding address" }));
    const link = within(card()).getByRole("link", { name: /Explorer/u });
    expect(link).toHaveAttribute("href", `https://testnet.zecblock.com/address/${REAL_ADDRESS}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("uses the mainnet explorer for a mainnet receipt", async () => {
    verifierSays(200, { ...wire(), network: "mainnet", funding_address: REAL_ADDRESS });
    const user = userEvent.setup();
    renderAt(GOOD_LINK.replace("network=testnet", "network=mainnet"));
    await screen.findByRole("heading", { level: 2, name: "Status" });
    await user.click(screen.getByRole("button", { name: "Funding address" }));
    expect(within(card()).getByRole("link", { name: /Explorer/u })).toHaveAttribute(
      "href",
      `https://mainnet.zcashexplorer.app/address/${REAL_ADDRESS}`,
    );
  });

  it("an address with a path, query or script in it never becomes a link", async () => {
    for (const hostile of ["javascript:alert(1)", `${REAL_ADDRESS}/../../x`, `${REAL_ADDRESS}?x=1`]) {
      verifierSays(200, { ...wire(), funding_address: hostile });
      const view = renderAt(GOOD_LINK);
      // Whitespace-free but hostile text is either refused by the schema or shown without a link.
      await waitFor(() => {
        expect(document.body.textContent).toMatch(/Funding address|didn't match|expected format/u);
      });
      expect(document.querySelector("a[href^='javascript:']")).toBeNull();
      expect(document.querySelector(`a[href*='${REAL_ADDRESS}/../']`)).toBeNull();
      view.unmount();
    }
  });
});

// ---- What the deposit spent -----------------------------------------------

// covers: REQ-VER-007
describe("what the deposit spent", () => {
  const card = () => screen.getByTestId("funding-section");
  const strip = () => within(screen.getByRole("list", { name: "Where the funds went" }));

  it("the first real batch: out of the shielded pool, in the strip and in the funding section", async () => {
    await showReceipt("/r/demo?demo=real-smoke", "Funding address");
    expect(strip().getByTestId("flow-source")).toHaveTextContent(RECEIPT_SOURCE_WORDING.flowShielded);
    const spent = within(card()).getByTestId("deposit-spent");
    expect(spent).toHaveTextContent(RECEIPT_SOURCE_WORDING.heading);
    expect(spent).toHaveTextContent(RECEIPT_SOURCE_WORDING.shielded);
    // It names no payer, and says what stays public: never that the payer is hidden.
    expect(spent).toHaveTextContent(RECEIPT_SOURCE_WORDING.shieldedMore);
    expect(spent).toHaveTextContent("Its amount and time are public");
  });

  it("the 8-output batch: from transparent funds, said plainly, and the receipt is still settled", async () => {
    await showReceipt("/r/demo?demo=real", "Funding address");
    expect(strip().getByTestId("flow-source")).toHaveTextContent(RECEIPT_SOURCE_WORDING.flowTransparent);
    const spent = within(card()).getByTestId("deposit-spent");
    expect(spent).toHaveTextContent(RECEIPT_SOURCE_WORDING.transparent);
    expect(spent).toHaveTextContent(RECEIPT_SOURCE_WORDING.transparentMore);
    expect(verdict()).toHaveTextContent("Settled: 8 payouts, 0.005 TAZ, fee 0.00045 TAZ");
  });

  it("says when the verifier could not establish it, and shows no caption in the strip", async () => {
    verifierSays(200, { ...wire(), funding_source: null });
    const user = userEvent.setup();
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(strip().queryByTestId("flow-source")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Funding address" }));
    expect(within(card()).getByTestId("deposit-spent")).toHaveTextContent(RECEIPT_SOURCE_WORDING.unknown);
  });

  it("says nothing at all when an older verifier did not report it", async () => {
    const old = wire();
    delete old["funding_source"];
    verifierSays(200, old);
    const user = userEvent.setup();
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(strip().queryByTestId("flow-source")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Funding address" }));
    expect(within(card()).queryByTestId("deposit-spent")).toBeNull();
    // The rest of the receipt is untouched.
    expect(card()).toHaveTextContent("Every batch on this receipt spends from this address");
  });

  it("never names an address of what the deposit spent: only the campaign's own address is on the page", async () => {
    await showReceipt("/r/demo?demo=real", "Funding address");
    // The sweep behind the 8-output batch spent the first batch's change: 12,420,000 zat at this address, in 50fb88e0….
    const text = document.body.textContent;
    for (const needle of ["tmPvSFX6uKbWX6UebNnuiaKmbdtcby9A3kr", "tmPvSFX", "50fb88e0", "0.1242 ", "12420000", "12,420,000"]) {
      expect(text, needle).not.toContain(needle);
    }
  });
});

describe("the coin on the page follows the receipt's network", () => {
  const mainnetLink = GOOD_LINK.replace("network=testnet", "network=mainnet");
  const mainnetWire = () => ({ ...wire(), network: "mainnet" });

  it("testnet amounts are TAZ, with a note that they have no value", async () => {
    verifierSays(200, wire());
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(verdict()).toHaveTextContent("5.345 TAZ");
    expect(screen.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d ZEC\b/u);
  });

  it("mainnet amounts are ZEC, and there is nothing to explain", async () => {
    verifierSays(200, mainnetWire());
    renderAt(mainnetLink);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(verdict()).toHaveTextContent("5.345 ZEC");
    expect(document.body.textContent).not.toMatch(/TAZ|testnet coin/u);
  });

  it("a mismatch notice uses the link's network for its figures while the answer is on screen", async () => {
    verifierSays(200, mainnetWire());
    renderAt(mainnetLink.replace("declared_total=534500000", "declared_total=100000000"));
    const alert = await screen.findByText("The chain and this link don't agree");
    const notice = alert.closest("[role='alert']") as HTMLElement;
    expect(notice).toHaveTextContent("the link says 1 ZEC");
    expect(notice).toHaveTextContent("the chain adds up to 5.345 ZEC");
  });
});

describe("a real receipt link", () => {
  it("asks the verifier once, then shows the answer", async () => {
    const fetchMock = verifierSays(200, wire());
    renderAt(GOOD_LINK);

    expect(await screen.findByRole("heading", { level: 2, name: "Status" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/v1/receipt?network=testnet");
    expect(url).toContain(`tx=${TX}`);
    expect(url).toContain(`commitment=${COMMITMENT}`);
    expect(url).toContain("declared_total=534500000");

    expect(screen.getByText("golden-fixture")).toBeInTheDocument();
    expect(screen.queryByLabelText("Sample")).toBeNull();
    expect(screen.queryByText("The chain and this link don't agree")).toBeNull();
  });

  it("shows loading while it waits", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderAt(GOOD_LINK);

    const status = await screen.findByText(/Asking the verifier/u);
    expect(status.closest("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Status" })).toBeNull();
  });

  it("can check again on request", async () => {
    const user = userEvent.setup();
    const fetchMock = verifierSays(200, wire());
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("says when payouts are still in progress that it will look again", async () => {
    verifierSays(200, wire()); // phase: sending
    renderAt(GOOD_LINK);
    expect(await screen.findByText(/checks again every few seconds/u)).toBeInTheDocument();
  });

  it("does not promise that once everything is settled, and shows every batch as final", async () => {
    verifierSays(200, {
      ...wire(),
      phase: { phase: "settled" },
      batches: [
        {
          index: 0,
          txid: TX,
          funding_input: `${"c".repeat(64)}:0`,
          net_into_pool: "534500000",
          fee: "35000",
          shielded_actions: 3,
          pool: "ironwood",
          confirmations: 9,
        },
      ],
    });
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Transaction" }));

    expect(screen.queryByText(/checks again every few seconds/u)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Complete: all batches confirmed")).toBeInTheDocument();
    expect(within(batchTable()).getByText("Final")).toBeInTheDocument();
  });

  it("shows an empty campaign as empty, not broken", async () => {
    verifierSays(200, {
      ...wire(),
      phase: { phase: "draft" },
      declared_total: "0",
      fee_total: "0",
      batches: [],
    });
    renderAt(
      `/r/camp-01?network=testnet&tx=${TX}&commitment=${COMMITMENT}&declared_total=0`,
    );
    // The link names a tx the (empty) receipt lacks, so a notice appears too.
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(verdict()).toHaveTextContent("Draft: no batches yet");
    await userEvent.setup().click(screen.getByRole("button", { name: "Transactions" }));
    expect(screen.getByText(/No payout batches yet/u)).toBeInTheDocument();
  });
});

// ---- When things go wrong --------------------------------------------------

describe("failure states are calm, specific and actionable", () => {
  it("an unreachable verifier is retried automatically, then can be retried by hand", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      // The first attempt and both automatic retries fail...
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      // ...then the verifier comes back.
      .mockImplementation(() => Promise.resolve(new Response(golden, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    renderAt(GOOD_LINK);
    await waitOutRetries();

    const alert = await screen.findByRole("alert");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      within(alert).getByRole("heading", { name: "The verifier can't be reached right now" }),
    ).toBeInTheDocument();
    expect(within(alert).getByText(/says nothing about the campaign itself/u)).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Status" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a server error is also just 'unreachable'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    verifierSays(503, { error: "down" });
    renderAt(GOOD_LINK);
    await waitOutRetries();
    expect(await screen.findByText("The verifier can't be reached right now")).toBeInTheDocument();
  });

  it("does not retry answers that will not change (not found, rejected)", async () => {
    for (const status of [404, 400, 422]) {
      const fetchMock = verifierSays(status, {});
      const { unmount } = renderAt(GOOD_LINK);
      await screen.findByRole("alert");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("unknown transactions say they may not be confirmed yet", async () => {
    verifierSays(404, {});
    renderAt(GOOD_LINK);
    expect(
      await screen.findByText("The verifier has no record of these transactions"),
    ).toBeInTheDocument();
    expect(screen.getByText(/may not be confirmed yet/u)).toBeInTheDocument();
  });

  it("a mismatch the verifier found is a finding in a normal answer, shown calmly and in full", async () => {
    verifierSays(200, JSON.parse(mismatch));
    renderAt(
      `/r/camp-01?network=testnet&tx=${"a0".repeat(32)}&tx=${"a1".repeat(32)}` +
        `&commitment=${COMMITMENT}&declared_total=2000001`,
    );

    const found = await screen.findByRole("heading", { level: 2, name: "What the verifier found" });
    const card = found.closest("section") as HTMLElement;
    expect(card).toHaveTextContent(
      "The batches add up to a different total than the one declared for this campaign.",
    );
    expect(within(card).getByRole("heading", { level: 3, name: "Needs attention (1)" })).toBeInTheDocument();
    expect(card).toHaveTextContent(/not why, and not who is responsible/u);
    // The answer is not hidden behind the finding.
    expect(screen.getByText("Needs attention: a batch failed")).toBeInTheDocument();
    expect(verdict()).toHaveTextContent("0.02000001 TAZ");
    expect(card.textContent).not.toMatch(/stolen|lost|fraud|scam|missing funds/iu);
    // The verifier did not name the campaign, so the page does not invent one.
    expect(screen.queryByText("golden-fixture")).toBeNull();
  });

  it("does not report a total mismatch twice when the verifier already did", async () => {
    verifierSays(200, JSON.parse(mismatch));
    renderAt(
      `/r/camp-01?network=testnet&tx=${"a0".repeat(32)}&tx=${"a1".repeat(32)}` +
        `&commitment=${COMMITMENT}&declared_total=2000001`,
    );
    await screen.findByRole("heading", { level: 2, name: "What the verifier found" });
    expect(screen.queryByText("The chain and this link don't agree")).toBeNull();
  });

  describe("a receipt whose facts could not all be established", () => {
    const allTxids = Array.from({ length: 8 }, (_, i) => `tx=${`a${String(i)}`.repeat(32)}`).join("&");
    const link = `/r/camp-01?network=testnet&${allTxids}&commitment=${COMMITMENT}&declared_total=8000000`;

    it("lists every finding in the core's sentences, split by what they mean", async () => {
      verifierSays(200, JSON.parse(findings));
      renderAt(link);

      const heading = await screen.findByRole("heading", { level: 2, name: "What the verifier found" });
      const card = heading.closest("section") as HTMLElement;
      expect(within(card).getByRole("heading", { level: 3, name: "Needs attention (5)" })).toBeInTheDocument();
      expect(within(card).getByRole("heading", { level: 3, name: "Not final yet (3)" })).toBeInTheDocument();

      for (const sentence of [
        "Batch 3: the data returned for this transaction is not a valid transaction.",
        "Batch 5: the inputs are worth less than the outputs, which no valid transaction can be.",
        "Batch 6: the shielded value balance does not match the transaction's own signature.",
        "Batch 7: the transaction does not pay into the expected shielded pool.",
        "Batch 6: spends from a different address than the other batches, so they do not all come from one campaign funding address.",
        "Batch 2: the transaction was not found on the chain.",
        "Batch 4: a funding input could not be looked up, so the fee cannot be checked.",
        "Batch 1: not yet confirmed to the required depth.",
      ]) {
        expect(within(card).getByText(sentence)).toBeInTheDocument();
      }
    });

    it("shows facts it could not establish as Unknown, never as zero", async () => {
      verifierSays(200, JSON.parse(findings));
      const user = userEvent.setup();
      renderAt(link);
      await screen.findByRole("heading", { level: 2, name: "Status" });
      await user.click(screen.getByRole("button", { name: "Transactions" }));

      // The fee total is unknown because some fees are.
      expect(verdict()).toHaveTextContent("fee Unknown");
      expect(verdict().textContent).not.toMatch(/fee 0 TAZ/u);

      const rows = within(batchTable()).getAllByRole("row").slice(1);
      const notFound = within(rows[2] as HTMLElement);
      expect(notFound.getAllByText("Unknown").length).toBeGreaterThanOrEqual(3);
      expect(notFound.getByText("Funding input unknown")).toBeInTheDocument();
      expect(notFound.getByText("Not on the chain yet")).toBeInTheDocument();
    });

    it("marks each batch by what is known about it", async () => {
      verifierSays(200, JSON.parse(findings));
      const user = userEvent.setup();
      renderAt(link);
      await screen.findByRole("heading", { level: 2, name: "Status" });
      await user.click(screen.getByRole("button", { name: "Transactions" }));

      const status = (index: number) => {
        const rows = within(batchTable()).getAllByRole("row").slice(1);
        return within(rows[index] as HTMLElement).getByText(
          /Needs attention|Final|Confirming|Not on the chain yet|Waiting for a block|Not sent yet/u,
        ).textContent;
      };
      expect(status(0)).toBe("Final"); // confirmed deep enough, no finding of its own
      expect(status(1)).toBe("Confirming"); // batch_pending
      expect(status(2)).toBe("Not on the chain yet");
      expect(status(3)).toBe("Needs attention"); // unparseable
      expect(status(5)).toBe("Needs attention"); // negative fee
      expect(status(7)).toBe("Needs attention"); // unexpected pool
      // Batch 7 paid into the other pool, and the page says so.
      const rows = within(batchTable()).getAllByRole("row").slice(1);
      expect(within(rows[7] as HTMLElement).getByText("Orchard")).toBeInTheDocument();
    });
  });

  it("a mismatch the page finds itself lists the differences, and still shows the answer", async () => {
    verifierSays(200, wire());
    // The link claims a different total than the chain adds up to.
    renderAt(
      `/r/camp-01?network=testnet&tx=${TX}&commitment=${COMMITMENT}&declared_total=100000000`,
    );

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "The chain and this link don't agree" })).toBeInTheDocument();
    expect(alert).toHaveTextContent("the link says 1 TAZ");
    expect(alert).toHaveTextContent("the chain adds up to 5.345 TAZ");
    expect(alert).toHaveTextContent("Below is what the verifier actually found");
    // The verifier's answer is not hidden.
    expect(screen.getByRole("heading", { level: 2, name: "Status" })).toBeInTheDocument();
  });

  it("a different commitment is called out, shortened", async () => {
    verifierSays(200, wire());
    renderAt(
      `/r/camp-01?network=testnet&tx=${TX}&commitment=${"d".repeat(64)}&declared_total=534500000`,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Manifest commitment: the link says dddddddd…dddddddd");
    expect(alert).toHaveTextContent("eeeeeeee…eeeeeeee");
  });

  it("transactions the link names but the receipt lacks are counted", async () => {
    verifierSays(200, wire());
    renderAt(
      `/r/camp-01?network=testnet&tx=${TX}&tx=${"b".repeat(64)}&commitment=${COMMITMENT}&declared_total=534500000`,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 in the link was not found in the receipt");
  });

  it("an answer that breaks the receipt format is refused, and none of it is shown", async () => {
    verifierSays(200, { ...wire(), recipients: ["u1sentineladdress"], memo: "sentinel-memo" });
    renderAt(GOOD_LINK);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: /wasn't in the expected format/u })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("u1sentineladdress");
    expect(document.body.innerHTML).not.toContain("sentinel-memo");
    expect(screen.queryByRole("heading", { level: 2, name: "Status" })).toBeNull();
  });

  it("a verifier that rejects the request as malformed is explained", async () => {
    verifierSays(400, {});
    renderAt(GOOD_LINK);
    expect(await screen.findByText("The verifier couldn't read this link")).toBeInTheDocument();
  });

  it("a malformed request is still called malformed when the verifier gives another reason", async () => {
    verifierSays(400, { error: { code: "invalid_parameter", message: "parameter `commitment` is not valid" } });
    renderAt(GOOD_LINK);
    expect(await screen.findByText("The verifier couldn't read this link")).toBeInTheDocument();
    expect(screen.getByText(/refused as malformed/u)).toBeInTheDocument();
    expect(screen.queryByText("This verifier does not serve that network")).toBeNull();
  });

  // covers: REQ-VER-005
  describe("a verifier that does not serve the link's network", () => {
    const answer = { error: { code: "network_not_configured", message: "this verifier is not configured for that network" } };
    const mainnetLink = GOOD_LINK.replace("network=testnet", "network=mainnet");

    it("says so plainly, names the network of the link, and does not call the link malformed", async () => {
      verifierSays(400, answer);
      renderAt(mainnetLink);
      const alert = (await screen.findByText("This verifier does not serve that network")).closest("[role='alert']") as HTMLElement;
      expect(alert).toHaveTextContent("The link is for mainnet, and this verifier is not set up to read that chain.");
      expect(alert).toHaveTextContent("That says nothing about the campaign itself.");
      expect(alert).toHaveTextContent("Ask whoever sent the link which verifier to use for it.");
      expect(within(alert).getByRole("link", { name: "See a sample receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
      expect(screen.queryByText("The verifier couldn't read this link")).toBeNull();
      expect(document.body.textContent).not.toMatch(/malformed/u);
    });

    it("names testnet for a testnet link", async () => {
      verifierSays(400, answer);
      renderAt(GOOD_LINK);
      expect(await screen.findByText(/The link is for testnet, and this verifier is not set up/u)).toBeInTheDocument();
    });

    it("asks once and offers no retry, because asking again will not change it", async () => {
      const fetchMock = verifierSays(400, answer);
      renderAt(mainnetLink);
      await screen.findByText("This verifier does not serve that network");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("shows neither the verifier's code nor its words", async () => {
      verifierSays(400, answer);
      renderAt(mainnetLink);
      await screen.findByText("This verifier does not serve that network");
      expect(document.body.textContent).not.toMatch(/network_not_configured|is not configured for that network/u);
    });
  });

  it.each([
    ["no parameters at all", "/r/camp-01", /does not say which network/u],
    [
      "a malformed transaction id",
      `/r/camp-01?network=testnet&tx=nope&commitment=${COMMITMENT}&declared_total=1`,
      /transaction ids in the link is not valid/u,
    ],
    [
      "no commitment",
      `/r/camp-01?network=testnet&tx=${TX}&declared_total=1`,
      /does not include the manifest commitment/u,
    ],
    [
      "an unknown network",
      `/r/camp-01?network=regtest&tx=${TX}&commitment=${COMMITMENT}&declared_total=1`,
      /not testnet or mainnet/u,
    ],
  ])("an incomplete link (%s) explains itself and asks nothing of the verifier", async (_label, path, text) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderAt(path);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This receipt link is incomplete" })).toBeInTheDocument();
    expect(alert).toHaveTextContent(text);
    expect(within(alert).getByRole("link", { name: "See a sample receipt" })).toHaveAttribute(
      "href",
      SAMPLE_RECEIPT_HREF,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never puts the link's values into the problem text", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderAt(`/r/camp-01?network=testnet&tx=sentinel-bad-id&commitment=${COMMITMENT}&declared_total=1`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("sentinel-bad-id");
  });
});
