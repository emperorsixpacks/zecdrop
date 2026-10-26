// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

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
