// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import "@/test/dom";
import boundaryDoc from "../../../../docs/PRIVACY_BOUNDARY.md?raw";

import PrivacyPage, { STATUS_SENTENCE } from "./PrivacyPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <PrivacyPage />
    </MemoryRouter>,
  );
}

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

// The page mirrors docs/PRIVACY_BOUNDARY.md. Its status sentence says how far the
// design has been checked; it must say what the document says, and when the document
// moves on (mainnet checked, an audit done) this fails until the page does too.
describe("the privacy page's status", () => {
  // The paragraph after "Status:", without the reference to an internal record in parentheses.
  const paragraph = boundaryDoc.slice(boundaryDoc.indexOf("Status:"), boundaryDoc.indexOf("\n\n", boundaryDoc.indexOf("Status:")));
  const fromDoc = squash(paragraph.replace(/^Status:\s*/u, "").replace(/\s*\([^)]*\)/u, ""));

  it("the document says the shape is confirmed on public testnet, not on mainnet, not audited", () => {
    expect(paragraph).toMatch(/confirmed on public testnet/u);
    expect(paragraph).toMatch(/Not yet checked on mainnet/u);
    expect(paragraph).toMatch(/not independently audited/u);
  });

  it("the page's sentence is the document's, word for word (first letter aside)", () => {
    expect(STATUS_SENTENCE.slice(1)).toBe(fromDoc.slice(1));
    expect(STATUS_SENTENCE[0]?.toLowerCase()).toBe(fromDoc[0]);
  });

  it("the page shows that sentence, and no file path, and not the old 'written from the design' line", () => {
    renderPage();
    expect(squash(screen.getByTestId("status-sentence").textContent ?? "")).toBe(`Status: ${STATUS_SENTENCE}`);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/PRIVACY_BOUNDARY|\.md\b|docs\//u);
    expect(text).not.toMatch(/Written from the design|before the transaction\s+shape was confirmed/u);
  });
});

describe("who can see what", () => {
  const rowOf = (name: string) => screen.getByRole("row", { name: new RegExp(`^${name}\\b`, "u") });
  const cells = (name: string) => within(rowOf(name)).getAllByRole("cell").map((c) => c.textContent);

  it("is one table: rows are the facts, columns are the people", () => {
    renderPage();
    const table = screen.getByRole("table", { name: /Who can see what/u });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Public", "A recipient", "An auditor"]);
    expect(within(table).getAllByRole("rowheader").map((h) => h.textContent)).toEqual([
      "Who was paid",
      "Each amount",
      "The total",
      "The fee",
      "How many payouts",
    ]);
  });

  // covers: REQ-PRIV-002
  it("hides who was paid and each amount from the public, shows a recipient only their own, and an auditor everything", () => {
    renderPage();
    expect(cells("Who was paid")).toEqual(["Hidden", "Their own", "Visible"]);
    expect(cells("Each amount")).toEqual(["Hidden", "Their own", "Visible"]);
  });

  it("shows the total, the fee and the number of payouts to everyone", () => {
    renderPage();
    for (const row of ["The total", "The fee", "How many payouts"]) expect(cells(row)).toEqual(["Visible", "Visible", "Visible"]);
  });

  it("says each cell in a word, so it never depends on colour or on the icon", () => {
    renderPage();
    const body = document.querySelectorAll("tbody td");
    expect(body).toHaveLength(15);
    for (const cell of body) {
      expect(cell.textContent).toMatch(/^(Visible|Hidden|Their own)$/u);
      // The picture beside the word is decoration, hidden from assistive technology.
      for (const picture of cell.querySelectorAll("svg, .redacted")) {
        expect(picture.closest("[aria-hidden='true']"), "the picture is aria-hidden").not.toBeNull();
      }
    }
  });
});

describe("known limits", () => {
  it("are at most five short lines on the page itself", () => {
    renderPage();
    const list = screen.getByRole("heading", { name: "Known limits" }).closest("section") as HTMLElement;
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(5);
    for (const item of items) expect((item.textContent ?? "").split(/\s+/u).length).toBeLessThanOrEqual(16);
  });

  it("keep the full list and the trust assumptions one click away, in the document's words", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByText(/There is no revocation/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Every known limit, and who must be trusted" }));
    expect(screen.getByText(/There is no revocation/u)).toBeInTheDocument();
    expect(screen.getByText(/In a two-recipient batch each party can infer the other's amount/u)).toBeInTheDocument();
    expect(screen.getByText(/The hosted verifier holds no keys, but it learns which receipts are viewed/u)).toBeInTheDocument();
    expect(screen.getByText(/A lying node can fake a receipt/u)).toBeInTheDocument();
    expect(screen.getByText(/no independent audit/u)).toBeInTheDocument();
  });

  it("keep the sentence about what an auditor closes, behind a click too", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "What anyone can check, and what only an auditor can" }));
    expect(screen.getByText(/The public cannot tell a dummy spend from a real one/u)).toBeInTheDocument();
    expect(screen.getByText(/Any mismatch means a hidden spend/u)).toBeInTheDocument();
  });
});
