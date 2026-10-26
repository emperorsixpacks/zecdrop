// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoReceipt, SAMPLE_RECEIPT_HREF } from "@/api/demo";
import "@/test/dom";
import sampleCsv from "../../../../examples/demo-recipients.testnet.csv?raw";

import HomePage from "./HomePage";
import { samplePayoutRows } from "./sample";

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

/** One of the sample's amounts, as a whole number (so "0.0004" is not found inside the fee "0.00045"). */
const amount = (...values: string[]) => new RegExp(`(?<![\\d.])(${values.map((v) => v.replace(".", "\\.")).join("|")})(?!\\d)`, "u");

const rows = () => screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-revealed"));

describe("the home page", () => {
  it("says what it does in one headline", () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pay many people. Keep who got what private. Prove the total.");
  });

  it("gives two ways on: the real receipt and how privacy works", () => {
    renderHome();
    expect(screen.getByRole("link", { name: "See a real receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
    expect(screen.getByRole("link", { name: "How privacy works" })).toHaveAttribute("href", "/privacy");
  });

  it("states what has and has not been done, in one line", () => {
    renderHome();
    expect(screen.getByText("A real 8-person payout ran on public testnet. Not tried on mainnet.")).toBeInTheDocument();
  });

  it("has no eyebrow above the headline, no boxed cards, and no paragraph longer than a short sentence", () => {
    renderHome();
    expect(document.querySelectorAll("[data-slot='card']")).toHaveLength(0);
    expect(document.querySelector("h1")?.previousElementSibling?.tagName).not.toBe("P");
    for (const p of document.querySelectorAll("p")) {
      expect((p.textContent ?? "").trim().split(/\s+/u).length, p.textContent ?? "").toBeLessThanOrEqual(16);
    }
  });

  it("puts three short lines under the lens: what is public, what is hidden, what is checkable", () => {
    renderHome();
    const lines = screen.getAllByRole("list").find((ul) => ul.textContent?.includes("Checkable")) as HTMLElement;
    const items = within(lines).getAllByRole("listitem");
    expect(items.map((li) => li.firstElementChild?.textContent)).toEqual(["Public", "Hidden", "Checkable"]);
    for (const item of items) expect((item.textContent ?? "").split(/\s+/u).length).toBeLessThanOrEqual(14);
  });

  it("says how to run a payout, in order, and that there is no wallet to connect", () => {
    renderHome();
    const section = screen.getByRole("heading", { level: 2, name: "How to run a payout" }).closest("section") as HTMLElement;
    expect(within(section).getByText("There is no wallet to connect: the operator on your own computer holds the keys.")).toBeInTheDocument();
    const steps = within(section).getAllByRole("listitem");
    expect(steps.map((li) => li.querySelector("h3")?.textContent)).toEqual([
      "Start the operator",
      "Add your payout list",
      "Fund the address",
      "Send and share",
    ]);
    // The page offers nothing to connect: no such button or link anywhere.
    expect(screen.queryByRole("button", { name: /connect/iu })).toBeNull();
    expect(screen.queryByRole("link", { name: /connect/iu })).toBeNull();
  });

  it("prints the real run as a receipt, with the receipt's own figures and the limits as measured", () => {
    renderHome();
    const receipt = screen.getByTestId("run-receipt");
    const line = (name: string) => within(receipt).getByText(name).closest("div")?.querySelector("dd")?.textContent;
    expect(line("Payouts")).toBe("8");
    expect(line("Transaction")).toBe("6e23…7955");
    expect(line("Total")).toBe("0.005 TAZ");
    expect(line("Network fee")).toBe("0.00045 TAZ");
    expect(line("Mined at block")).toBe("4,478,289");
    expect(line("Most in one transaction")).toBe("330");
    expect(line("Time to prove 330")).toBe("142 s");
    // The one thing it has not done is said on it, as on the page's status line.
    expect(within(receipt).getByText("No mainnet payout yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
  });

  it("says what a person being paid can do, and where", () => {
    renderHome();
    const section = screen.getByRole("heading", { level: 2, name: "For the people you pay" }).closest("section") as HTMLElement;
    expect(within(section).getByRole("link", { name: "Get ready to be paid" })).toHaveAttribute("href", "/get-paid");
    expect(within(section).getByRole("link", { name: "Check a payslip" })).toHaveAttribute("href", "/payslip");
  });

  it("keeps the count, the total and the fee readable, from the real receipt", () => {
    renderHome();
    const receipt = demoReceipt("real");
    expect(receipt.declaredTotal).toBe("500000");
    expect(screen.getByTestId("lens-summary")).toHaveTextContent("8 payouts");
    expect(screen.getByTestId("lens-summary")).toHaveTextContent("0.005 TAZ");
    expect(screen.getByTestId("lens-summary")).toHaveTextContent("+ 0.00045 TAZ fee");
  });
});

describe("the sample list behind the lens", () => {
  it("is the list the real run was made from: eight payouts that add up to the receipt's total", () => {
    const list = samplePayoutRows();
    expect(list).toHaveLength(8);
    const sum = list.reduce((total, row) => total + BigInt(row.amount ?? "0"), 0n);
    expect(sum.toString()).toBe(demoReceipt("real").declaredTotal);
    expect(list.map((r) => r.label)).toEqual(Array.from({ length: 8 }, (_, i) => `Person ${String(i + 1)}`));
  });

  it("is the bundled CSV, not a copy of it", () => {
    for (const row of samplePayoutRows()) expect(sampleCsv).toContain(row.address ?? "never");
  });
});

describe("the lens on the home page", () => {
  // The sample's own addresses and memos: when the lens is public none of them is in the page.
  const addresses = samplePayoutRows().map((r) => r.address ?? "");
  const memos = samplePayoutRows().map((r) => r.memo ?? "");

  // covers: REQ-PRIV-002
  it("starts public: eight rows, every address and amount a bar, and none of the text in the page", () => {
    renderHome();
    expect(rows()).toHaveLength(8);
    expect(rows().map((r) => r.firstElementChild?.textContent)).toEqual(Array.from({ length: 8 }, (_, i) => `Person ${String(i + 1)}`));
    expect(screen.getAllByRole("img", { name: "hidden" })).toHaveLength(16);
    const html = document.body.innerHTML;
    for (const address of addresses) expect(html).not.toContain(address.slice(0, 20));
    for (const memo of memos) expect(html).not.toContain(memo);
    expect(document.body.textContent).not.toMatch(amount("0.0006", "0.0004", "0.0009", "0.0005", "0.0007", "0.0003", "0.0010"));
  });

  it("'One person' reveals exactly one row, and 'Who?' moves it", async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("radio", { name: "One person" }));
    expect(rows().map((r) => r.getAttribute("data-revealed"))).toEqual(["false", "false", "true", "false", "false", "false", "false", "false"]);
    expect(rows()[2]).toHaveTextContent("0.0009 TAZ");
    expect(document.body.textContent).not.toMatch(amount("0.0006", "0.0004", "0.0005", "0.0007", "0.0003", "0.0010"));

    await user.selectOptions(screen.getByLabelText("Who?"), "Person 7");
    expect(rows()[6]).toHaveTextContent("0.001 TAZ");
    expect(rows()[2]).not.toHaveTextContent("0.0009");
  });

  it("'Auditor' reveals every row, with its memo", async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("radio", { name: "Auditor" }));
    expect(rows().every((r) => r.getAttribute("data-revealed") === "true")).toBe(true);
    expect(screen.queryAllByRole("img", { name: "hidden" })).toHaveLength(0);
    expect(screen.getByText("ZecDrop demo payout 5")).toBeInTheDocument();
  });

  it("goes back to hiding everything when 'Public' is chosen again", async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("radio", { name: "Auditor" }));
    await user.click(screen.getByRole("radio", { name: "Public" }));
    for (const address of addresses) expect(document.body.innerHTML).not.toContain(address.slice(0, 20));
    for (const memo of memos) expect(document.body.innerHTML).not.toContain(memo);
  });

  it("says the testnet coin has no value", () => {
    renderHome();
    expect(screen.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeInTheDocument();
  });
});

describe("the first look", () => {
  // The page plays it once a visit, so each test loads the page afresh.
  async function freshHome() {
    vi.resetModules();
    const { default: Fresh } = await import("./HomePage");
    return render(
      <MemoryRouter>
        <Fresh />
      </MemoryRouter>,
    );
  }

  function lively() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })),
    );
    document.documentElement.dataset["motion"] = "lively";
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset["motion"];
  });

  // covers: REQ-PRIV-002
  it("draws the bars over cells that hold nothing, then marks the three public figures, and is then still", async () => {
    lively();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await freshHome();
    expect(container.querySelectorAll(".bar-in")).toHaveLength(16);
    const marks = container.querySelectorAll(".marked");
    expect(marks).toHaveLength(3);
    for (const mark of marks) expect(mark).toHaveAttribute("data-intro", "true");
    // While the bars are being drawn the page is as private as it is after: no address, memo or amount of the list.
    const html = document.body.innerHTML;
    for (const row of samplePayoutRows()) {
      expect(html).not.toContain((row.address ?? "never").slice(0, 20));
      expect(html).not.toContain(row.memo ?? "never");
    }
    expect(document.body.textContent).not.toMatch(amount("0.0006", "0.0004", "0.0009", "0.0005", "0.0007", "0.0003", "0.0010"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.querySelectorAll(".bar-in")).toHaveLength(0);
    for (const mark of container.querySelectorAll(".marked")) expect(mark).toHaveAttribute("data-intro", "false");
  });

  it("plays once a visit: coming back to the page draws nothing", async () => {
    lively();
    const first = await freshHome();
    first.unmount();
    const { default: Again } = await import("./HomePage");
    const { container } = render(
      <MemoryRouter>
        <Again />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll(".bar-in")).toHaveLength(0);
    for (const mark of container.querySelectorAll(".marked")) expect(mark).toHaveAttribute("data-intro", "false");
  });

  it("does not play in Calm, or when the system asks for reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })),
    );
    const { container } = await freshHome();
    expect(container.querySelectorAll(".bar-in")).toHaveLength(0);
    cleanup();

    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })),
    );
    document.documentElement.dataset["motion"] = "calm";
    const calm = await freshHome();
    expect(calm.container.querySelectorAll(".bar-in")).toHaveLength(0);
  });
});
