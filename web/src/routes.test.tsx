// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { installFakeOperator, replyWith } from "@/test/fake-operator";
import { island } from "@/test/island";
import { renderApp } from "@/test/render-app";

// The operator pages are behind the token gate; with no token they explain how
// to open the operator link. Their real content is tested next to each page
// (wizard, campaign, campaigns) with a signed-in session.
function renderAt(path: string) {
  return renderApp(path);
}

beforeEach(() => {
  installFakeOperator({ "GET /api/health": () => replyWith("health.json") });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

const PUBLIC_HEADINGS: [path: string, heading: string][] = [
  ["/", "Pay many people. Keep who got what private. Prove the total."],
  ["/r/abc123", "Payout receipt"],
  ["/r/demo?demo=1", "Payout receipt"],
  ["/r/demo?demo=real", "Payout receipt"],
  ["/r/demo?demo=real-smoke", "Payout receipt"],
  ["/get-paid", "Get paid in ZEC"],
  ["/payslip", "Check a payslip"],
  ["/privacy", "How privacy works"],
];

const OPERATOR_PATHS = ["/campaigns", "/new", "/new/check", "/new/send", "/campaign/abc123", "/audit"];

const PAGE_HEADINGS: [path: string, heading: string][] = [
  ...PUBLIC_HEADINGS,
  ...OPERATOR_PATHS.map((p): [string, string] => [p, "Open the operator link"]),
];

describe("routes", () => {
  it.each(PAGE_HEADINGS)("%s renders its page", (path, heading) => {
    renderAt(path);
    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  });

  it.each(OPERATOR_PATHS)("%s asks for the operator link when there is no token", (path) => {
    renderAt(path);
    expect(screen.getByRole("heading", { level: 1, name: "Open the operator link" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Campaigns" })).toBeNull();
  });

  it("renders a hostile id as text, never as markup", () => {
    renderAt(`/r/${encodeURIComponent('<img src=x onerror="alert(1)">')}`);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });

  it("shows unknown routes as not found", () => {
    renderAt("/nope");
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });

  it("treats an unknown wizard step as not found when signed in", () => {
    renderApp("/new/bogus", { signedIn: true });
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });

  it("has a How privacy works footer link to /privacy on every page", () => {
    for (const [path] of [...PAGE_HEADINGS, ["/nope", ""] as const]) {
      const { unmount } = renderAt(path);
      const footer = screen.getByRole("contentinfo");
      expect(within(footer).getByRole("link", { name: "How privacy works" })).toHaveAttribute(
        "href",
        "/privacy",
      );
      unmount();
    }
  });

  it("has a skip link and a target for it", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(document.getElementById("main")).not.toBeNull();
  });

  it("lets the pitch page reach the sample receipt", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await user.click(screen.getByRole("link", { name: "See a real receipt" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Status" }),
    ).toBeInTheDocument();
  });
});

describe("layouts", () => {
  const OPERATOR_ONLY = ["Payouts", "Audit"];

  it.each(["/campaigns", "/new", "/new/check", "/campaign/x", "/audit"])(
    "shows operator navigation on %s",
    (path) => {
      renderAt(path);
      const nav = screen.getByRole("navigation", { name: "Primary" });
      for (const label of OPERATOR_ONLY) {
        expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
      }
    },
  );

  it.each(["/campaigns", "/campaign/x", "/audit"])("offers to start a payout from %s", (path) => {
    renderAt(path);
    expect(screen.getByRole("link", { name: "New payout" })).toHaveAttribute("href", "/new");
  });

  it.each(["/new", "/new/check", "/new/send"])("does not offer to start one while paying, on %s", (path) => {
    renderAt(path);
    expect(screen.queryByRole("link", { name: "New payout" })).toBeNull();
  });

  it("shows the three stages while paying, and only there", async () => {
    renderApp("/new", { signedIn: true });
    const tracker = await screen.findByRole("navigation", { name: "Progress" });
    expect(within(tracker).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1Payouts", "2Check", "3Send"]);
    expect(within(tracker).getByText("Payouts").closest("[aria-current='step']")).not.toBeNull();
  });

  it.each(["/campaigns", "/audit"])("has no tracker on %s", async (path) => {
    renderApp(path, { signedIn: true });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("navigation", { name: "Progress" })).toBeNull();
  });

  it.each(["/new/basics", "/new/recipients", "/new/review", "/new/bogus"])("has no page at %s any more", async (path) => {
    renderApp(path, { signedIn: true });
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });

  it.each(["/", "/r/abc123", "/r/demo?demo=1", "/get-paid", "/payslip", "/privacy", "/nope"])(
    "shows only the public menu on %s",
    (path) => {
      renderAt(path);
      const nav = screen.getByRole("navigation", { name: "Primary" });
      expect(within(nav).getByRole("link", { name: "Sample receipt" })).toHaveAttribute(
        "href",
        SAMPLE_RECEIPT_HREF,
      );
      expect(within(nav).getByRole("link", { name: "Get paid" })).toHaveAttribute("href", "/get-paid");
      expect(within(nav).getByRole("link", { name: "Check a payslip" })).toHaveAttribute("href", "/payslip");
      expect(within(nav).getByRole("link", { name: "How privacy works" })).toHaveAttribute("href", "/privacy");
      expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
      for (const label of OPERATOR_ONLY) {
        expect(within(nav).queryByRole("link", { name: label })).toBeNull();
      }
      expect(screen.queryByRole("link", { name: "New payout" })).toBeNull();
      // The header is one capsule, closed: a button that names the site and the page, not a link.
      expect(island()).toHaveAttribute("aria-expanded", "false");
      expect(island()).toHaveAccessibleName(/^ZecDrop /u);
      expect(screen.queryByRole("link", { name: "ZecDrop" })).toBeNull();
    },
  );

  it.each([
    ["/", "Home"],
    ["/r/abc123", "Receipt"],
    ["/get-paid", "Get paid"],
    ["/payslip", "Payslip"],
    ["/privacy", "How privacy works"],
  ])("names the page on %s in the capsule: %s", (path, name) => {
    renderAt(path);
    expect(island()).toHaveAccessibleName(`ZecDrop ${name} testnet`);
  });

  it.each([
    ["/campaigns", "Payouts"],
    ["/new", "New payout"],
    ["/campaign/x", "Payout"],
    ["/audit", "Audit"],
  ])("names the operator's page on %s in the capsule: %s", (path, name) => {
    renderAt(path);
    expect(island()).toHaveAccessibleName(`ZecDrop ${name} testnet`);
  });

  it("shows the network badge", () => {
    renderAt("/");
    expect(screen.getByText(/^Zcash (testnet|mainnet)$/)).toBeInTheDocument();
  });
});

