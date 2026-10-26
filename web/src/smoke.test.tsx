// @vitest-environment jsdom
//
// Smoke test for the pages a visitor lands on first. Each must render with
// nothing written to the console, no uncaught errors, one h1, a main landmark
// and a document title. A console warning here is how React reports real
// problems (bad keys, invalid DOM nesting, state updates after unmount).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { clearSession } from "@/api/operator/session";
import { installFakeOperator, replyWith, replyWithStream } from "@/test/fake-operator";
import { renderApp } from "@/test/render-app";
import { AppRoutes } from "./routes";

const PAGES: [name: string, path: string, h1: string][] = [
  ["the home page", "/", "Pay many people. Keep who got what private. Prove the total."],
  ["the real testnet sample receipt", "/r/demo?demo=real", "Payout receipt"],
  ["the first real testnet batch", "/r/demo?demo=real-smoke", "Payout receipt"],
  ["the sample receipt", "/r/demo?demo=1", "Payout receipt"],
  ["the payslip page", "/payslip", "Check a payslip"],
  ["the privacy page", "/privacy", "How privacy works"],
];

let consoleCalls: string[];
let uncaught: string[];

const onError = (event: ErrorEvent) => {
  uncaught.push(event.message);
};

beforeEach(() => {
  consoleCalls = [];
  uncaught = [];
  for (const method of ["error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(`${method}: ${args.map(String).join(" ")}`);
    });
  }
  window.addEventListener("error", onError);
});

afterEach(() => {
  window.removeEventListener("error", onError);
  vi.restoreAllMocks();
});

describe.each(PAGES)("%s", (_name, path, h1) => {
  it("renders with no console errors, warnings or uncaught errors", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The receipt loads asynchronously; wait for it to settle.
    expect(await screen.findByRole("heading", { level: 1, name: h1 })).toBeInTheDocument();
    if (path.startsWith("/r/")) {
      await screen.findByRole("heading", { level: 2, name: "Status" });
    }

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toMatch(/ZecDrop/u);
    });

    unmount();
    expect(consoleCalls).toEqual([]);
    expect(uncaught).toEqual([]);
  });
});

// The operator pages, signed in, against the captured responses.
const OPERATOR_PAGES: [name: string, path: string, h1: string][] = [
  ["the payouts list", "/campaigns", "Payouts"],
  ["stage 1: payouts", "/new", "Add the payouts"],
  ["stage 2 without payouts", "/new/check", "Add the payouts first"],
  ["stage 3 without payouts", "/new/send", "Add the payouts first"],
  ["a funded campaign", "/campaign/c-000000000001", "Sentinel campaign"],
  ["the audit page", "/audit", "Audit"],
];

describe.each(OPERATOR_PAGES)("operator: %s", (_name, path, heading) => {
  it("renders with no console errors, warnings or uncaught errors", async () => {
    installFakeOperator({
      "GET /api/health": () => replyWith("health.json"),
      "GET /api/campaigns": () => replyWith("campaigns-list.json"),
      "GET /api/campaigns/:id": () => replyWith("campaign-settled.json"),
      "GET /api/campaigns/:id/events": () => replyWithStream("events-settled.sse.txt"),
      "GET /api/campaigns/:id/receipt": () => replyWith("receipt-settled.json"),
    });
    const { unmount } = renderApp(path, { signedIn: true });

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    if (path.startsWith("/campaign/")) await screen.findByRole("button", { name: "Share the receipt" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toMatch(/ZecDrop/u);
    });

    unmount();
    vi.unstubAllGlobals();
    clearSession();
    expect(consoleCalls).toEqual([]);
    expect(uncaught).toEqual([]);
  });
});
