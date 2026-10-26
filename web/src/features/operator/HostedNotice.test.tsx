// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://demo.example.org/" }
//
// The page as a hosted, public copy sees it: opened from a name that is not the
// operator's loopback address. The operator pages must explain themselves, make no
// call to any operator, and leave the public pages alone.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { renderApp } from "@/test/render-app";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.reject(new Error("a hosted page must not call an operator")));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

const OPERATOR_PATHS = ["/campaigns", "/new", "/new/basics", "/new/recipients", "/campaign/c-000000000001", "/audit"];

describe("the page is served from a hosted name", () => {
  it("is not the operator's loopback address", () => {
    expect(window.location.hostname).toBe("demo.example.org");
  });

  it.each(OPERATOR_PATHS)("%s explains that the operator runs on your own machine, instead of failing", (path) => {
    renderApp(path);
    expect(screen.getByRole("heading", { level: 1, name: "Run the operator on your own machine" })).toBeInTheDocument();
    expect(screen.getByText(/This hosted page is the public receipt viewer/u)).toBeInTheDocument();
    // Not the token screen, and not an error.
    expect(screen.queryByRole("heading", { name: "Open the operator link" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(OPERATOR_PATHS)("%s makes no request at all, with or without a session", (path) => {
    renderApp(path, { signedIn: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers the public menu only: no Campaigns, New campaign or Audit", () => {
    renderApp("/campaigns");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const label of ["Campaigns", "New campaign", "Audit"]) {
      expect(within(nav).queryByRole("link", { name: label })).toBeNull();
    }
    expect(within(nav).getByRole("link", { name: "Sample receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
    expect(within(nav).getByRole("link", { name: "How privacy works" })).toBeInTheDocument();
  });

  it("says what is here instead, with working links", async () => {
    const user = userEvent.setup();
    renderApp("/audit");
    expect(screen.getByText(/Nothing on this hosted page can create, fund or send a payout/u)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "See a sample receipt" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Payout receipt" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "Status" })).toBeInTheDocument();
  });

  it("leaves the public pages alone", () => {
    renderApp("/privacy");
    expect(screen.getByRole("heading", { level: 1, name: "How privacy works" })).toBeInTheDocument();
    renderApp("/");
    expect(screen.getAllByRole("heading", { level: 1, name: "Pay many people. Keep who got what private. Prove the total." }).length).toBeGreaterThan(0);
  });

  it("does not claim anything it cannot back up", () => {
    renderApp("/campaigns");
    expect(document.body.textContent).not.toMatch(/verified payouts|everyone was paid|guarantee/iu);
  });
});
