// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasApiTransport } from "@/api/client";
import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { beginLeavingPractice, PRACTICE_BANNER, PRACTICE_KEY, startPractice, stopPractice, usePractice } from "@/lib/practice-mode";

import { PracticeBanner, PracticeLeaver } from "./PracticeBanner";

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** A screen with the banner on it, the leaver that is always mounted, and a client that holds something. */
function show(path = "/privacy") {
  const client = new QueryClient();
  client.setQueryData(["operator", "campaigns"], [{ held: "by a practice payout" }]);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <PracticeLeaver />
        <PracticeBanner />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  sessionStorage.clear();
  clearSession();
});

afterEach(() => {
  stopPractice();
  sessionStorage.clear();
  clearSession();
});

describe("the banner", () => {
  it("is nothing at all while practice mode is off", () => {
    show();
    expect(screen.queryByRole("region", { name: "Practice mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave practice mode" })).toBeNull();
  });

  // covers: REQ-DEMO-001
  it("says what practice mode is, in a region of its own, with the way out beside it", async () => {
    await startPractice();
    show();
    const banner = screen.getByRole("region", { name: "Practice mode" });
    expect(banner).toHaveTextContent(PRACTICE_BANNER);
    expect(within(banner).getByRole("button", { name: "Leave practice mode" })).toBeEnabled();
  });

  it("has nothing that would let it be dismissed for a while: no close button, no toggle", async () => {
    await startPractice();
    show();
    const banner = screen.getByRole("region", { name: "Practice mode" });
    expect(within(banner).getAllByRole("button")).toHaveLength(1);
    expect(banner.querySelector("[aria-expanded], [aria-pressed]")).toBeNull();
  });
});

describe("leaving", () => {
  // covers: REQ-DEMO-001
  it("goes to the start page first, and only then takes practice mode away, with what the screens held", async () => {
    await startPractice();
    const client = show("/privacy");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Leave practice mode" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Practice mode" })).toBeNull();
    });
    expect(screen.getByTestId("where")).toHaveTextContent("/");
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(usePractice.getState()).toEqual({ on: false, exampleList: null, leaving: false });
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBeNull();
    expect(hasApiTransport()).toBe(false);
    expect(client.getQueryCache().findAll()).toHaveLength(0);
  });

  // covers: REQ-DEMO-001
  it("is not done while a screen is still up that was showing the payout: asking is not leaving", async () => {
    await startPractice();
    const client = show("/campaigns");
    beginLeavingPractice();
    // Give it every chance to act: the screen is not the start page, so practice mode is still there for it to ask.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(usePractice.getState()).toMatchObject({ on: true, leaving: true });
    expect(hasApiTransport()).toBe(true);
    expect(client.getQueryCache().findAll()).toHaveLength(1);
    expect(screen.getByTestId("where")).toHaveTextContent("/campaigns");
  });

  it("is done at once from the start page itself, where there is no screen to wait for", async () => {
    await startPractice();
    const client = show("/");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Leave practice mode" }));
    await waitFor(() => {
      expect(usePractice.getState().on).toBe(false);
    });
    expect(client.getQueryCache().findAll()).toHaveLength(0);
  });
});
