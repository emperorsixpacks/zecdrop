// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { installFakeOperator, replyWith, type RouteHandler } from "@/test/fake-operator";
import { renderApp } from "@/test/render-app";

import { DISCLOSURE_WARNING } from "./disclosure";

const health: RouteHandler = () => replyWith("health.json");

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

/** The page, as the operator shows it: with its list of payouts (some, by default, or none). */
async function show(list: "campaigns-list.json" | "campaigns-empty.json" | "error" = "campaigns-list.json") {
  installFakeOperator({
    "GET /api/health": health,
    "GET /api/campaigns": () =>
      list === "error" ? { status: 500, body: { error: { code: "internal", message: "no" } } } : replyWith(list),
  });
  const view = renderApp("/audit", { signedIn: true });
  await screen.findByRole("heading", { level: 1, name: "Audit" });
  return view;
}

describe("the audit page", () => {
  it("says in one line who can audit, and that running it is not done from the page", async () => {
    await show();
    expect(screen.getByRole("heading", { level: 1, name: "Audit" })).toBeInTheDocument();
    expect(screen.getByText("Only someone with the viewing key can check the payments against the list.")).toBeInTheDocument();
    expect(screen.getByText(/The audit is a command-line tool\. It keeps the viewing key inside that process\./u)).toBeInTheDocument();
  });

  it("shows the command, which can be copied, and says the key goes in on standard input", async () => {
    const user = userEvent.setup();
    await show();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(screen.getByText(/--ufvk-stdin/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("drop-operator audit"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("--ufvk-stdin"));
    // The reason is one tap away, not a second paragraph.
    expect(screen.queryByText(/so it never lands in shell history/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "How the viewing key gets in" }));
    expect(await screen.findByText(/so it never lands in shell history/u)).toBeInTheDocument();
  });

  it("keeps the page to the command and four closed sections, each opening to its words", async () => {
    await show();
    for (const name of ["What the audit checks", "Getting the viewing key", "Limits", "Options and what the report holds"]) {
      expect(screen.getByRole("button", { name }), name).toHaveAttribute("aria-expanded", "false");
    }
    // Nothing of what is behind them is on the page yet.
    expect(screen.queryByText(DISCLOSURE_WARNING)).toBeNull();
    expect(screen.queryByText(/whether the number of outputs recovered/u)).toBeNull();
    // Of the page's own text, the line under the title and the one above the command are all there is.
    const main = document.querySelector("main") ?? document.body;
    const lines = Array.from(main.querySelectorAll("p")).filter((p) => (p.textContent ?? "").trim().length > 40);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("lists the three checks, in the core's words", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "What the audit checks" }));
    expect(screen.getByText(/whether the number of outputs recovered with the viewing key equals the shielded action count/u)).toBeInTheDocument();
    expect(screen.getByText(/whether the recovered values add up to the net value that entered the shielded pool/u)).toBeInTheDocument();
    expect(screen.getByText(/recomputed from what the chain proves and the stored payout list/u)).toBeInTheDocument();
  });

  it("says the key is a disclosure that cannot be taken back, word for word, before it points to where the key is", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "Getting the viewing key" }));
    expect(screen.getByText(DISCLOSURE_WARNING)).toBeInTheDocument();
    expect(screen.getByText(/Giving it away cannot be undone/u)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Open your payouts" })).toHaveAttribute("href", "/campaigns");
  });

  it("keeps the limits and the options one click away, in full", async () => {
    const user = userEvent.setup();
    await show();
    expect(screen.queryByText(/never rounded away/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Limits" }));
    expect(screen.getByText(/never rounded away/u)).toBeInTheDocument();
    expect(screen.getByText(/A lying node can fake what the audit sees/u)).toBeInTheDocument();
    expect(screen.getByText(/It says nothing about what recipients do afterwards/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Options and what the report holds" }));
    expect(screen.getByText(/--receipt-commitment/u)).toBeInTheDocument();
    expect(screen.getByText(/no addresses, memos or per-recipient amounts/u)).toBeInTheDocument();
  });
});

describe("the audit page with nothing sent yet", () => {
  it("says there is nothing to audit, and offers to start a payout", async () => {
    await show("campaigns-empty.json");
    const empty = await screen.findByTestId("audit-empty");
    expect(empty).toHaveTextContent("Nothing to audit yet");
    expect(empty).toHaveTextContent("An audit checks a payout that was sent. Send one, then come back here.");
    expect(screen.getByRole("link", { name: "Start a payout" })).toHaveAttribute("href", "/new");
    // There is no payout to open, so the link that says so is not offered, even once the section is open.
    await userEvent.setup().click(screen.getByRole("button", { name: "Getting the viewing key" }));
    expect(await screen.findByText(DISCLOSURE_WARNING)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open your payouts" })).toBeNull();
    // The how-to is still there for someone who wants to read it first.
    expect(screen.getByText(/The audit is a command-line tool\. It keeps the viewing key inside that process\./u)).toBeInTheDocument();
  });

  it("the picture is decoration: hidden from assistive technology, and holds no text", async () => {
    await show("campaigns-empty.json");
    const ghost = await screen.findByTestId("ghost-rows");
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost.textContent).toBe("");
  });

  it("with payouts there is no empty notice", async () => {
    await show();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Getting the viewing key" }));
    expect(await screen.findByRole("link", { name: "Open your payouts" })).toBeInTheDocument();
    expect(screen.queryByTestId("audit-empty")).toBeNull();
  });

  it("when the list cannot be read, the page stays as it was and does not claim there is nothing", async () => {
    await show("error");
    await screen.findByText(/The audit is a command-line tool\. It keeps the viewing key inside that process\./u);
    expect(screen.queryByTestId("audit-empty")).toBeNull();
  });
});
