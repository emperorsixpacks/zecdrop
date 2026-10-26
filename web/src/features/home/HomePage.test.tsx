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

/** Every word in the page as rendered, text node by text node, so that a heading and the paragraph after it are not run
 * together into one word. Words a screen reader alone hears count too. */
function pageWords(): string[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const words: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest("title, script, style") != null) continue;
    words.push(...(node.textContent ?? "").split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)));
  }
  return words;
}

describe("the home page", () => {
  it("says what it does in one headline and one sentence", () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pay many people. Keep it private. Prove the total.");
    expect(
      screen.getByText("One Zcash transaction pays everyone on your list. The amounts stay private, and anyone can check the total."),
    ).toBeInTheDocument();
    expect(screen.getByText("On Zcash testnet. Your keys stay on your computer.")).toBeInTheDocument();
  });

  // covers: REQ-RUN-002
  it("says it all in under 400 words", () => {
    renderHome();
    const words = pageWords();
    expect(words.length, words.join(" ")).toBeLessThan(400);
  });

  // covers: REQ-RUN-002
  it("offers Make a payout from its first screen, its steps and its end: here, on the operator's own page, its payouts", () => {
    // On the public site the same three lead to the page that says how to run ZecDrop (HostedNotice.test.tsx).
    expect(window.location.hostname).toBe("localhost");
    renderHome();
    const starts = screen.getAllByRole("link", { name: "Make a payout" });
    expect(starts).toHaveLength(3);
    for (const link of starts) expect(link).toHaveAttribute("href", "/campaigns");
    // The first link on the page, before the sheet.
    expect(screen.getAllByRole("link")[0]).toBe(starts[0]);
  });

  // covers: REQ-RUN-002
  it("simulates nothing: no button starts a pretend payout, and 'practice' is said nowhere, not even in a label", () => {
    renderHome();
    expect(screen.queryByRole("button", { name: /^Try /u })).toBeNull();
    const labels = [...document.body.querySelectorAll("[aria-label], [title], [alt], [placeholder]")].flatMap((el) =>
      ["aria-label", "title", "alt", "placeholder"].map((name) => el.getAttribute(name) ?? ""),
    );
    expect([document.body.textContent ?? "", ...labels].join(" ")).not.toMatch(/practi[cs]e/iu);
  });

  it("gives the real receipt and how privacy works", () => {
    renderHome();
    expect(screen.getByRole("link", { name: "See a real receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
    expect(screen.getByRole("link", { name: "How privacy works" })).toHaveAttribute("href", "/privacy");
  });

  it("has no eyebrow above the headline, no boxed cards, and no paragraph longer than two short sentences", () => {
    renderHome();
    expect(document.querySelectorAll("[data-slot='card']")).toHaveLength(0);
    expect(document.querySelector("h1")?.previousElementSibling?.tagName).not.toBe("P");
    for (const p of document.querySelectorAll("p")) {
      expect((p.textContent ?? "").trim().split(/\s+/u).length, p.textContent ?? "").toBeLessThanOrEqual(20);
    }
  });

  it("makes three points, each a short title and one line", () => {
    renderHome();
    const points = within(screen.getByTestId("points")).getAllByRole("listitem");
    expect(points.map((li) => li.querySelector("h2")?.textContent)).toEqual([
      "Up to 330 people, one transaction.",
      "A receipt anyone can check.",
      "Your keys stay with you.",
    ]);
    expect(points[2]).toHaveTextContent("No account, no wallet to connect.");
  });

  it("says how a payout is made, in three steps, the first of them the one command, and offers no wallet to connect", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "How it works" });
    const steps = within(section).getAllByRole("listitem");
    expect(steps.map((li) => li.querySelector("h3")?.textContent)).toEqual(["Start ZecDrop", "Add people and fund it", "Send and share"]);
    expect(steps[0]).toHaveTextContent("./zecdrop up");
    expect(within(section).getByRole("link", { name: "Make a payout" })).toHaveAttribute("href", "/campaigns");
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
    // The one thing it has not done is said on it.
    expect(within(receipt).getByText("No mainnet payout yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
  });

  it("says where a person being paid goes", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "Being paid?" });
    expect(within(section).getByRole("link", { name: "Share your address" })).toHaveAttribute("href", "/get-paid");
    expect(within(section).getByRole("link", { name: "Check a payslip" })).toHaveAttribute("href", "/payslip");
  });

  it("keeps the three public figures plain: nothing is drawn behind the writing", () => {
    renderHome();
    const summary = screen.getByTestId("lens-summary");
    for (const el of [summary, ...summary.querySelectorAll("*")]) expect(el.className).not.toMatch(/marker|highlighter|marked/u);
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

  it("'You' (the payer) reveals every row too, and says it is on the payer's own computer", async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("radio", { name: "You" }));
    expect(rows().every((r) => r.getAttribute("data-revealed") === "true")).toBe(true);
    expect(screen.getByText("What you see as the payer, on your own computer.")).toBeInTheDocument();
  });

  it("goes back to hiding everything when 'Everyone' is chosen again", async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("radio", { name: "Auditor" }));
    await user.click(screen.getByRole("radio", { name: "Everyone" }));
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
  it("draws the bars over cells that hold nothing, and is then still", async () => {
    lively();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await freshHome();
    expect(container.querySelectorAll(".bar-in")).toHaveLength(16);
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
