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
  ["the home page", "/", "Private amounts. Public accountability."],
  ["the real testnet sample receipt", "/r/demo?demo=real", "Payout receipt"],
  ["the first real testnet batch", "/r/demo?demo=real-smoke", "Payout receipt"],
  ["the sample receipt", "/r/demo?demo=1", "Payout receipt"],
  ["the privacy page", "/privacy", "What is public, what is private"],
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
  ["the campaigns list", "/campaigns", "Campaigns"],
  ["the wizard: basics", "/new/basics", "Basics"],
  ["the wizard: recipients", "/new/recipients", "Finish the basics first"],
  ["the wizard: auditor", "/new/auditor", "Auditor"],
  ["the wizard: review", "/new/review", "Review"],
  ["the wizard: fund", "/new/fund", "Fund & Send"],
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

    // Recipients without basics shows a heading at level 2; every other page has this h1.
    if (heading === "Finish the basics first") {
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Recipients" })).toBeInTheDocument();
    } else {
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    }
    if (path.startsWith("/campaign/")) await screen.findByTestId("receipt-link");
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
