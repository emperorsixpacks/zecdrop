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

// ---- The sample receipt ----------------------------------------------------

describe("/r/demo?demo=1", () => {
  it("works with no backend and says plainly that it is a sample", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/r/demo?demo=1");

    expect(await screen.findByRole("heading", { level: 2, name: "Status" })).toBeInTheDocument();
    expect(screen.getByText("Sample receipt")).toBeInTheDocument();
    expect(screen.getByText(/not a real campaign/u)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows status in plain language, with progress while sending", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: "Status" });

    expect(screen.getByText("Sending: 1 of 2 batches confirmed")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Batches confirmed" });
    expect(bar).toHaveAttribute("aria-valuetext", "1 of 2 batches confirmed");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
  });

  it("shows the totals in TAZ (the testnet coin), not zatoshi", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: "Status" });

    const totals = screen.getByText("Declared total").closest("div");
    expect(totals).toHaveTextContent("5.345 TAZ");
    expect(screen.getByText("Network fees").closest("div")).toHaveTextContent("0.00035 TAZ");
    expect(screen.getByText("Batches", { selector: "dt" }).closest("div")).toHaveTextContent("2");
  });

  it("lists each batch in a real table with proper headers", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("table", { name: "Payout batches" });

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
    renderAt("/r/demo?demo=1");
    await screen.findByRole("table", { name: "Payout batches" });
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
    renderAt("/r/demo?demo=1");
    await screen.findByRole("table", { name: "Payout batches" });
    const row = within(within(batchTable()).getAllByRole("row")[2] as HTMLElement);

    expect(row.getByText("Not built yet")).toBeInTheDocument();
    expect(row.getByText("Not sent yet")).toBeInTheDocument();
    expect(row.queryByRole("button")).toBeNull();
    expect(row.queryByRole("link")).toBeNull();
  });

  it("offers the same batches as cards for narrow screens", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("list", { name: "Payout batches" });

    const cards = within(batchCards()).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByRole("heading", { name: "Batch 0" })).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText("Confirming")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("Not built yet")).toBeInTheDocument();
  });

  it("copies a transaction id and the commitment", async () => {
    const user = userEvent.setup();
    renderAt("/r/demo?demo=1");
    await screen.findByRole("table", { name: "Payout batches" });
    // Installed after userEvent.setup(), which installs its own clipboard stub.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const row = within(within(batchTable()).getAllByRole("row")[1] as HTMLElement);
    await user.click(row.getByRole("button", { name: "Copy transaction id for batch 0" }));
    expect(writeText).toHaveBeenLastCalledWith(TX);

    await user.click(screen.getByRole("button", { name: "Copy manifest commitment" }));
    expect(writeText).toHaveBeenLastCalledWith(COMMITMENT);
  });

  it("shows the commitment in full and explains what it is for", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: "Manifest commitment" });

    expect(screen.getByText(COMMITMENT)).toBeInTheDocument();
    expect(screen.getByText(/salted fingerprint/u)).toBeInTheDocument();
    expect(screen.getByText(/the public cannot check it/u)).toBeInTheDocument();
  });

  it("says what it proves AND what it does not, in the boundary doc's terms", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: /What this proves/u });

    const proves = screen
      .getByRole("heading", { level: 3, name: "Anyone can check, from chain data alone" })
      .closest("div[data-slot='card']") as HTMLElement;
    expect(proves).toHaveTextContent("How much transparent value left the funding address.");
    expect(proves).toHaveTextContent(
      "exactly that amount, minus the fee, entered the shielded pool in each batch transaction",
    );
    expect(proves).toHaveTextContent("binding signature fixes this number");
    expect(proves).toHaveTextContent("In how many shielded outputs it went, at what fee");
    expect(proves).toHaveTextContent("funded = change + shielded + fee");

    const doesNot = screen
      .getByRole("heading", { level: 3, name: "What this does not prove" })
      .closest("div[data-slot='card']") as HTMLElement;
    expect(doesNot).toHaveTextContent("reached different people, or that it matches a payout list");
    expect(doesNot).toHaveTextContent("A payment to the operator's own address");
    expect(doesNot).toHaveTextContent("a hidden shielded spend all look identical to the public");
    expect(doesNot).toHaveTextContent(
      "Only an auditor holding the campaign's viewing key can confirm the count and the sum",
    );
    expect(doesNot).toHaveTextContent("a batch of one, or of equal amounts");
    expect(doesNot).toHaveTextContent("verifier's source of chain data is dishonest");

    expect(within(doesNot).getByRole("link", { name: "audit page" })).toHaveAttribute("href", "/audit");
    expect(screen.getByRole("link", { name: "privacy boundary" })).toHaveAttribute("href", "/privacy");
  });

  it("is honest about how far this has been checked: public testnet yes, mainnet and audit no", async () => {
    renderAt("/r/demo?demo=1");
    const note = await screen.findByText(/transaction shape has been confirmed on public testnet/u);
    expect(note).toHaveTextContent("has not been independently audited");
    expect(note).toHaveTextContent("mainnet is untested");
    // The sentence it replaced is no longer true and must not come back.
    expect(document.body.textContent).not.toMatch(/not yet confirmed on a live network|checked offline/u);
  });

  it("does not turn the output count into information about people", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: /What this proves/u });
    // "N shielded outputs" is public and fine; "N recipients" is not a claim this page makes.
    expect(document.body.textContent).not.toMatch(/number of recipients|how many (people|recipients)/iu);
  });

  it("does not claim the value reached third parties", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(document.body.textContent).not.toMatch(/was paid to|reached the recipients/iu);
  });

  it("is not available without the demo flag", async () => {
    verifierSays(200, wire());
    renderAt("/r/demo");
    expect(await screen.findByText("This receipt link is incomplete")).toBeInTheDocument();
  });
});

// ---- The other two samples -------------------------------------------------

describe("/r/demo?demo=findings", () => {
  it("shows what a verifier that could not confirm everything looks like", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/r/demo?demo=findings");

    const heading = await screen.findByRole("heading", { level: 2, name: "What the verifier found" });
    const card = heading.closest("div[data-slot='card']") as HTMLElement;
    expect(within(card).getByRole("heading", { level: 3, name: "Needs attention (5)" })).toBeInTheDocument();
    expect(within(card).getByRole("heading", { level: 3, name: "Not final yet (3)" })).toBeInTheDocument();
    expect(screen.getByText("Needs attention: a batch failed")).toBeInTheDocument();
    expect(screen.getByText("Network fees").closest("div")).toHaveTextContent("Unknown");
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
    const card = heading.closest("div[data-slot='card']") as HTMLElement;
    expect(card).toHaveTextContent(
      "The batches add up to a different total than the one declared for this campaign.",
    );
    expect(screen.getByText("Sample campaign")).toBeInTheDocument();
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
    title: "Sample receipt: a real batch",
    heights: ["Mined on public testnet at height 4,478,289", "captured at height 4,478,307"],
    declared: "0.005 TAZ",
    fee: "0.00045 TAZ",
    outputs: "8",
  },
  {
    path: "/r/demo?demo=real-smoke",
    label: "the first batch, a smaller one",
    txid: "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3",
    title: "Sample receipt: the first real batch",
    heights: ["Mined on public testnet at height 4,478,065", "captured at height 4,478,201"],
    declared: "0.0006 TAZ",
    fee: "0.0002 TAZ",
    outputs: "3",
  },
] as const;

describe.each(REAL_SAMPLES)("$path: $label", ({ path, txid, title, heights, declared, fee, outputs }) => {
  it("works with no backend, and says what it is: mined on public testnet, captured, not live", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderAt(path);

    expect(await screen.findByRole("heading", { level: 2, name: "Status" })).toBeInTheDocument();
    const banner = screen.getByText(title).closest("[role='status']") as HTMLElement;
    for (const text of heights) expect(banner).toHaveTextContent(text);
    expect(banner).toHaveTextContent("confirmations are shown as of the capture, not live");
    expect(banner).toHaveTextContent("Testnet coins have no value");
    // Explorers are third parties; the page says they can lag, and does not promise the link opens it.
    expect(banner).toHaveTextContent("Explorers are third parties and can lag behind the chain");
    expect(banner.textContent).not.toMatch(/opens it/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call itself an example or placeholder data, because it is neither", async () => {
    renderAt(path);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(document.body.textContent).not.toMatch(/not a real campaign|placeholders|example data/u);
    expect(screen.getByText("Real batch on public testnet")).toBeInTheDocument();
  });

  it("shows the real transaction with an explorer link to that txid on the default testnet explorer (ZecBlock)", async () => {
    renderAt(path);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    const links = screen.getAllByRole("link").filter((a) => (a.getAttribute("href") ?? "").includes(txid));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(`https://testnet.zecblock.com/tx/${txid}`);
    }
  });

  it("shows the amounts in TAZ, the testnet coin, and says it has no value", async () => {
    renderAt(path);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(screen.getByText("Declared total").closest("div")).toHaveTextContent(declared);
    expect(screen.getByText("Network fees").closest("div")).toHaveTextContent(fee);
    expect(document.body.textContent).not.toMatch(/\d ZEC\b/u);
    expect(screen.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeInTheDocument();
  });

  it("reads as ONE batch with several shielded outputs, not several batches", async () => {
    renderAt(path);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(screen.getByText("Complete: all batches confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What the verifier found" })).toBeNull();

    // The summary counts batches (transactions), and says there is one.
    expect(screen.getByText("Batches", { selector: "dt" }).closest("div")).toHaveTextContent(/^Batches1One Zcash transaction each\.$/u);

    // The table has one row, and the outputs are a column of it.
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
    renderAt(path);
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
    const card = screen.getByRole("heading", { level: 2, name: "Funding address" }).closest("div[data-slot='card']") as HTMLElement;
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
    renderAt(path);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(document.body.textContent).not.toMatch(/\bu1[a-z0-9]{20,}|\bzs1|memo/iu);
  });
});

describe("the samples' links", () => {
  it("'Sample receipt' opens the 8-output batch", () => {
    expect(SAMPLE_RECEIPT_HREF).toBe("/r/demo?demo=real");
  });
});

describe("the sample banner", () => {
  it.each([
    ["/r/demo?demo=1", ["A real batch of 8 outputs from public testnet", "The first real batch, a smaller one", "A receipt with findings", "A declared total that does not add up"]],
    ["/r/demo?demo=findings", ["A real batch of 8 outputs from public testnet", "The first real batch, a smaller one", "A campaign in progress", "A declared total that does not add up"]],
    ["/r/demo?demo=mismatch", ["A real batch of 8 outputs from public testnet", "The first real batch, a smaller one", "A campaign in progress", "A receipt with findings"]],
    ["/r/demo?demo=real", ["The first real batch, a smaller one", "A campaign in progress", "A receipt with findings", "A declared total that does not add up"]],
    ["/r/demo?demo=real-smoke", ["A real batch of 8 outputs from public testnet", "A campaign in progress", "A receipt with findings", "A declared total that does not add up"]],
  ])("on %s links to the other four samples", async (path, others) => {
    renderAt(path);
    const banner = (await screen.findByText(/^Sample receipt/u)).closest("[role='status']") as HTMLElement;
    for (const label of others) {
      expect(within(banner).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(banner).getAllByRole("link")).toHaveLength(4);
  });

  it("says which sample you are looking at", async () => {
    renderAt("/r/demo?demo=findings");
    expect(await screen.findByText(/could not confirm everything, and reports each problem/u)).toBeInTheDocument();
  });

  it("switches sample when a link is followed", async () => {
    const user = userEvent.setup();
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: "Status" });
    await user.click(screen.getByRole("link", { name: "A receipt with findings" }));
    expect(await screen.findByRole("heading", { level: 2, name: "What the verifier found" })).toBeInTheDocument();
  });
});

// ---- Live receipts ---------------------------------------------------------

// ---- The funding address ---------------------------------------------------

describe("the funding address", () => {
  const card = () => screen.getByRole("heading", { level: 2, name: "Funding address" }).closest("div[data-slot='card']") as HTMLElement;
  const REAL_ADDRESS = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";

  it("is shown short, with the full address to copy, and the sentence about comparing it", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
    const placeholder = "tFAKEfundingAddressNotARealAddress0000";
    expect(within(card()).getByTestId("funding-address")).toHaveTextContent("tFAKEfun…ress0000");
    expect(within(card()).getByTestId("funding-address")).toHaveAttribute("title", placeholder);
    expect(within(card()).getByRole("button", { name: "Copy funding address" })).toBeInTheDocument();
    expect(card()).toHaveTextContent(
      "Every batch on this receipt spends from this address; compare it with the address the campaign published.",
    );
  });

  it("says that batches not built yet are not included, when there are some", async () => {
    renderAt("/r/demo?demo=1"); // one of its two batches has no transaction yet
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
    expect(card()).toHaveTextContent("Batches that are not built yet are not included.");
  });

  it("says the campaign id is only a label, and what actually ties a receipt to a campaign", async () => {
    renderAt("/r/demo?demo=1");
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
    expect(card()).toHaveTextContent("only a label from whoever made the link");
    expect(card()).toHaveTextContent("funding address and the manifest commitment");
  });

  it("is Unknown, never blank, when the verifier could not establish one", async () => {
    renderAt("/r/demo?demo=findings"); // funding_address is null in this golden
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
    expect(within(card()).getByText("Unknown")).toBeInTheDocument();
    expect(card()).toHaveTextContent("could not establish one address that every batch spends from");
    expect(within(card()).queryByTestId("funding-address")).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Copy funding address" })).toBeNull();
    expect(within(card()).queryByRole("link")).toBeNull();
  });

  it("gets no explorer link when the text is not an address a link can safely hold", async () => {
    renderAt("/r/demo?demo=1"); // the golden carries an obvious placeholder
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
    expect(within(card()).queryByRole("link")).toBeNull();
  });

  it("links a real address to the explorer's address page for the receipt's network", async () => {
    verifierSays(200, { ...wire(), funding_address: REAL_ADDRESS });
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
    const link = within(card()).getByRole("link", { name: /Explorer/u });
    expect(link).toHaveAttribute("href", `https://testnet.zecblock.com/address/${REAL_ADDRESS}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("uses the mainnet explorer for a mainnet receipt", async () => {
    verifierSays(200, { ...wire(), network: "mainnet", funding_address: REAL_ADDRESS });
    renderAt(GOOD_LINK.replace("network=testnet", "network=mainnet"));
    await screen.findByRole("heading", { level: 2, name: "Funding address" });
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

describe("the coin on the page follows the receipt's network", () => {
  const mainnetLink = GOOD_LINK.replace("network=testnet", "network=mainnet");
  const mainnetWire = () => ({ ...wire(), network: "mainnet" });

  it("testnet amounts are TAZ, with a note that they have no value", async () => {
    verifierSays(200, wire());
    renderAt(GOOD_LINK);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(screen.getByText("Declared total").closest("div")).toHaveTextContent("5.345 TAZ");
    expect(screen.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d ZEC\b/u);
  });

  it("mainnet amounts are ZEC, and there is nothing to explain", async () => {
    verifierSays(200, mainnetWire());
    renderAt(mainnetLink);
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(screen.getByText("Declared total").closest("div")).toHaveTextContent("5.345 ZEC");
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
    expect(screen.queryByText("Sample receipt")).toBeNull();
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
    expect(await screen.findByText(/No payout batches yet/u)).toBeInTheDocument();
    expect(screen.getByText("Draft", { selector: "span" })).toBeInTheDocument();
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
    const card = found.closest("div[data-slot='card']") as HTMLElement;
    expect(card).toHaveTextContent(
      "The batches add up to a different total than the one declared for this campaign.",
    );
    expect(within(card).getByRole("heading", { level: 3, name: "Needs attention (1)" })).toBeInTheDocument();
    expect(card).toHaveTextContent(/not why, and not who is responsible/u);
    // The answer is not hidden behind the finding.
    expect(screen.getByText("Needs attention: a batch failed")).toBeInTheDocument();
    expect(screen.getByText("0.02000001 TAZ")).toBeInTheDocument();
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
      const card = heading.closest("div[data-slot='card']") as HTMLElement;
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
      renderAt(link);
      await screen.findByRole("table", { name: "Payout batches" });

      // The fee total is unknown because some fees are.
      const fees = screen.getByText("Network fees").closest("div") as HTMLElement;
      expect(fees).toHaveTextContent("Unknown");
      expect(fees).toHaveTextContent("Some fees could not be established");
      expect(fees).not.toHaveTextContent("0 TAZ");

      const rows = within(batchTable()).getAllByRole("row").slice(1);
      const notFound = within(rows[2] as HTMLElement);
      expect(notFound.getAllByText("Unknown").length).toBeGreaterThanOrEqual(3);
      expect(notFound.getByText("Funding input unknown")).toBeInTheDocument();
      expect(notFound.getByText("Not on the chain yet")).toBeInTheDocument();
    });

    it("marks each batch by what is known about it", async () => {
      verifierSays(200, JSON.parse(findings));
      renderAt(link);
      await screen.findByRole("table", { name: "Payout batches" });

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
