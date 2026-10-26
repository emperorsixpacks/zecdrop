// @vitest-environment jsdom
//
// A build that knows where the public receipt page is hosted (VITE_PUBLIC_RECEIPT_BASE_URL) gives the operator's receipt link a
// public address, and opens it in a new tab. A practice receipt exists in this tab only, so its link is a path that opens here:
// a tab opened from this one would have no practice mode, and a public address would ask a real verifier about a transaction
// that was never sent.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import { useWizardDraft } from "@/features/wizard/draft";
import { stopPractice } from "@/lib/practice-mode";
import { pace } from "@/practice/pace";
import "@/test/dom";
import { practicePayout } from "@/test/practice-flow";
import { renderApp } from "@/test/render-app";

vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown> & { config: object }>();
  return { ...original, config: { ...original.config, publicReceiptBaseUrl: "https://verify.example.org" } };
});

beforeEach(() => {
  sessionStorage.clear();
  clearSession();
  useWizardDraft.getState().reset();
  pace.stepMs = 5;
});

afterEach(() => {
  stopPractice();
  clearSession();
  sessionStorage.clear();
});

describe("a practice receipt's link, on a build with a public address", () => {
  // covers: REQ-DEMO-001
  it("is a path that opens in this tab, never an address on the public host", async () => {
    const user = userEvent.setup();
    renderApp("/");
    let opened = "";
    await practicePayout(user, async (where) => {
      if (where !== "the settled campaign") return;
      // "Open public receipt" is a button that cannot be pressed until the receipt has come, and a link once it has: that is some
      // moments after the page says the campaign is settled, so it is waited for, not looked for.
      const link = await screen.findByRole("link", { name: "Open public receipt" });
      opened = link.getAttribute("href") ?? "";
      expect(link).not.toHaveAttribute("target");
    });
    expect(opened).toMatch(/^\/r\/practice-[0-9a-f]{6}\?network=testnet&tx=7072616374696365/u);
    expect(opened).not.toContain("verify.example.org");
  }, 30_000);

  // covers: REQ-DEMO-001
  it("is said to be a practice receipt that exists in this tab only, not a path that wants a host in front of it", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await practicePayout(user, async (where) => {
      if (where !== "the settled campaign") return;
      await user.click(await screen.findByRole("button", { name: "Share the receipt" }));
      expect(await screen.findByText(/This is a practice receipt: it exists only in this tab/u)).toBeInTheDocument();
      expect(screen.queryByText(/put the address of the public verifier in front of it/u)).toBeNull();
    });
  }, 30_000);
});
