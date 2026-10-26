// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { useAppearance } from "@/lib/appearance";
import "@/test/dom";
import { BANNED } from "@/test/banned-phrases";
import auditSource from "../../../../crates/drop-operator/src/audit.rs?raw";
import sampleCsv from "../../../../examples/demo-recipients.testnet.csv?raw";
import auditPageSource from "../audit/AuditPage.tsx?raw";
import campaignViewSource from "../campaign/CampaignView.tsx?raw";
import checkStageSource from "../wizard/CheckStage.tsx?raw";
import payoutsStageSource from "../wizard/PayoutsStage.tsx?raw";

import HomePage from "./HomePage";
import { Tour } from "./Tour";
import { AUDIT_RESULT, TOUR_SHOTS, TOUR_STEPS, TOUR_WIDTH, tourImageSrc } from "./tour-steps";

function renderTour() {
  return render(
    <MemoryRouter>
      <Tour />
    </MemoryRouter>,
  );
}

const tour = () => screen.getByRole("region", { name: "A payout, screen by screen" });
const pictures = () => within(tour()).getAllByRole("img");

/** Everything a person can read in the tour: its text, what each picture says it shows, and the captions. */
const everythingSaid = () => `${tour().textContent ?? ""} ${pictures().map((img) => img.getAttribute("alt") ?? "").join(" ")}`;

afterEach(() => {
  act(() => {
    useAppearance.setState({ theme: "light" });
  });
});

describe("the tour on the home page", () => {
  it("is a section of its own, after 'How to run a payout'", () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    const steps = screen.getByRole("heading", { level: 2, name: "How to run a payout" });
    const heading = within(tour()).getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("A payout, screen by screen");
    expect(steps.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing of the page above it is gone.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pay many people. Keep who got what private. Prove the total.");
    expect(screen.getByRole("link", { name: "See a real receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
  });

  it("has one heading per step, in order, one level under its own", () => {
    renderTour();
    const headings = within(tour()).getAllByRole("heading");
    expect(headings.map((h) => h.tagName)).toEqual(["H2", ...TOUR_STEPS.map(() => "H3")]);
    expect(headings.slice(1).map((h) => h.textContent)).toEqual([
      "Add the payouts",
      "Check the payouts",
      "Fund the campaign",
      "Send",
      "The public receipt",
      "The audit",
    ]);
  });

  it("says once, before the steps, that the operator screens are a practice run on a fake chain and the receipt is real", () => {
    renderTour();
    const practice = screen.getByText("The operator screens are from a practice run on a fake chain. No real money moved.");
    const real = screen.getByText("The receipt is the real batch from public testnet.");
    const first = within(tour()).getAllByRole("listitem")[0] as HTMLElement;
    for (const line of [practice, real]) expect(line.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Once: the practice run is not repeated under every step.
    expect(tour().textContent?.match(/practice run/gu)).toHaveLength(1);
  });

  it("puts one note under each step: what the public can see, and what stays hidden", () => {
    renderTour();
    const notes = screen.getAllByTestId("tour-note");
    expect(notes).toHaveLength(TOUR_STEPS.length);
    for (const [index, note] of notes.entries()) {
      const step = TOUR_STEPS[index];
      expect(within(note).getAllByRole("term").map((t) => t.textContent)).toEqual(["Public", "Hidden"]);
      expect(within(note).getAllByRole("definition").map((d) => d.textContent)).toEqual([step?.publicNote, step?.hiddenNote]);
      expect(note.closest("li"), `the note of step ${String(index + 1)} is in its step`).toBe(within(tour()).getAllByRole("listitem")[index]);
    }
  });

  it("agrees with the privacy boundary: nothing public is a recipient, and what stays hidden says so", () => {
    renderTour();
    for (const step of TOUR_STEPS) {
      expect(step.publicNote, step.id).not.toMatch(/recipient|address(es)? of|memo|who (got|gets) (paid|what)|how much each/iu);
    }
    // The steps where something is on the chain say what: the deposit, then one transaction's total, fee and count.
    expect(TOUR_STEPS.find((s) => s.id === "fund")?.publicNote).toMatch(/deposit/u);
    expect(TOUR_STEPS.find((s) => s.id === "send")?.publicNote).toMatch(/total.*fee.*how many/u);
    // And the limit the check step warns about: a tiny batch or equal amounts can give amounts away.
    expect(TOUR_STEPS.find((s) => s.id === "check")?.hiddenNote).toMatch(/tiny batch or equal amounts/u);
  });
});

describe("the tour's pictures", () => {
  it("are every screen of the tour, in the order of the steps, two for a step that changes", () => {
    renderTour();
    expect(pictures()).toHaveLength(TOUR_SHOTS.length);
    expect(TOUR_STEPS.map((s) => s.shots.length)).toEqual([1, 1, 2, 2, 1, 1]);
    const items = within(tour()).getAllByRole("listitem");
    for (const [index, step] of TOUR_STEPS.entries()) {
      expect(within(items[index] as HTMLElement).getAllByRole("img")).toHaveLength(step.shots.length);
    }
  });

  it("say what the screen shows, in words that are theirs and not the heading's", () => {
    renderTour();
    for (const img of pictures()) {
      const alt = img.getAttribute("alt") ?? "";
      expect(alt.length, alt).toBeGreaterThanOrEqual(80);
      expect(alt, "the alternative text names the screen").toMatch(/screen|sheet|timeline|receipt page/u);
      expect(alt, "not a file name").not.toMatch(/\.webp|\.png|image of|picture of|screenshot of/iu);
    }
    expect(new Set(pictures().map((img) => img.getAttribute("alt"))).size).toBe(TOUR_SHOTS.length);
  });

  it("hold their space (width and height written) and load only when near", () => {
    renderTour();
    for (const [index, img] of pictures().entries()) {
      const shot = TOUR_SHOTS[index];
      expect(img).toHaveAttribute("width", String(TOUR_WIDTH));
      expect(img).toHaveAttribute("height", String(shot?.height));
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).toHaveAttribute("decoding", "async");
    }
  });

  it("each have a caption, under them, in the same figure", () => {
    renderTour();
    for (const [index, img] of pictures().entries()) {
      const figure = img.closest("figure") as HTMLElement;
      expect(within(figure).getByText(TOUR_SHOTS[index]?.caption ?? "never")).toBeInTheDocument();
    }
  });

  it("are the light ones on a light page and the dark ones on a dark page", () => {
    renderTour();
    expect(pictures().map((img) => img.getAttribute("src"))).toEqual(TOUR_SHOTS.map((shot) => tourImageSrc(shot, "light")));
    act(() => {
      useAppearance.setState({ theme: "dark" });
    });
    expect(pictures().map((img) => img.getAttribute("src"))).toEqual(TOUR_SHOTS.map((shot) => tourImageSrc(shot, "dark")));
    expect(tourImageSrc({ id: "check-payouts" }, "dark")).toBe("/tour/check-payouts-dark.webp");
  });
});

describe("what the tour names", () => {
  it("uses the real screen names of the app", () => {
    const names: [name: string, source: string][] = [
      ["Add the payouts", payoutsStageSource],
      ["Check the payouts", checkStageSource],
      ["Fund and send", campaignViewSource],
      ["Audit", auditPageSource],
    ];
    for (const [name, source] of names) expect(source, name).toContain(`"${name}"`);
    const alts = TOUR_SHOTS.map((s) => s.alt).join(" ");
    for (const [name] of names) expect(alts, name).toContain(name);
  });

  it("links only to the real sample receipt, and has nothing else to press", () => {
    renderTour();
    const links = within(tour()).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Open this receipt"]);
    expect(links[0]).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
    expect(within(tour()).queryAllByRole("button")).toHaveLength(0);
    expect(links[0]?.closest("li")).toBe(within(tour()).getAllByRole("listitem")[4]);
  });

  it("ends the audit step with the very line the audit command prints when everything matches", () => {
    renderTour();
    const item = within(tour()).getAllByRole("listitem")[5] as HTMLElement;
    expect(item.querySelector("code")).toHaveTextContent(AUDIT_RESULT);
    expect(auditSource).toContain(AUDIT_RESULT);
  });
});

describe("what the tour must not say", () => {
  it("makes none of the claims the public cannot back up, and says nothing about mainnet", () => {
    renderTour();
    const said = everythingSaid();
    expect(said.length).toBeGreaterThan(1_000);
    for (const [label, pattern] of BANNED) expect(said, `contains the banned claim: ${label}`).not.toMatch(pattern);
    expect(said).not.toMatch(/mainnet/iu);
  });

  // covers: REQ-PRIV-002
  it("repeats no address, memo or single amount of the demo list in its words", () => {
    renderTour();
    const said = everythingSaid();
    const rows = sampleCsv
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(","));
    for (const [address, amount, memo] of rows) {
      expect(said).not.toContain((address ?? "").slice(0, 20));
      expect(said).not.toContain(memo ?? "never");
      expect(said, `amount ${amount ?? ""}`).not.toMatch(new RegExp(`(?<![\\d.])${(amount ?? "").replace(".", "\\.")}(?!\\d)`, "u"));
    }
  });

  it("keeps every paragraph a short sentence or two, as the rest of the page does", () => {
    renderTour();
    for (const p of tour().querySelectorAll("p")) {
      expect((p.textContent ?? "").trim().split(/\s+/u).length, p.textContent ?? "").toBeLessThanOrEqual(16);
    }
  });
});
