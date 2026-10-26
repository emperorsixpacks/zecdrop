// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasApiTransport } from "@/api/client";
import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { AUDIENCE_STORAGE_KEY, useAudience } from "@/lib/audience";
import { PRACTICE_KEY, stopPractice, usePractice } from "@/lib/practice-mode";

import { PracticeStart } from "./PracticeStart";

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function show(props: Parameters<typeof PracticeStart>[0]) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="*" element={<><PracticeStart {...props} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
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

describe("the button that starts practice mode", () => {
  it("opens the payout in the view it names, for this visit, and stores nothing of it", async () => {
    localStorage.clear();
    useAudience.setState({ audience: "personal" });
    const user = userEvent.setup();
    show({ label: "Try an organisation payout", audience: "organisation" });
    await user.click(screen.getByRole("button", { name: "Try an organisation payout" }));
    await waitFor(() => {
      expect(screen.getByTestId("where")).toHaveTextContent("/new");
    });
    expect(useAudience.getState().audience).toBe("organisation");
    expect(localStorage.getItem(AUDIENCE_STORAGE_KEY)).toBeNull();
    useAudience.setState({ audience: "personal" });
  });

  it("is a button with the words it was given, and nothing happens until it is pressed", () => {
    show({ label: "Try a practice payout" });
    expect(screen.getByRole("button", { name: "Try a practice payout" })).toBeEnabled();
    expect(usePractice.getState().on).toBe(false);
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBeNull();
    expect(hasApiTransport()).toBe(false);
  });

  // covers: REQ-DEMO-001
  it("loads the simulation when it is pressed, turns practice mode on and opens the first screen of a payout", async () => {
    const user = userEvent.setup();
    show({ label: "Try a practice payout" });
    await user.click(screen.getByRole("button", { name: "Try a practice payout" }));
    await waitFor(() => {
      expect(screen.getByTestId("where")).toHaveTextContent("/new");
    });
    expect(usePractice.getState().on).toBe(true);
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBe("1");
    expect(hasApiTransport()).toBe(true);
  });

  // covers: REQ-DEMO-001
  it("changes nothing and says so in words when the simulation cannot be loaded, and can be pressed again", async () => {
    const user = userEvent.setup();
    show({ label: "Try it yourself in practice mode", load: () => Promise.reject(new Error("the chunk did not load")) });
    await user.click(screen.getByRole("button", { name: "Try it yourself in practice mode" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Practice mode could not start. Reload the page and try again.");
    expect(screen.getByTestId("where")).toHaveTextContent("/");
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(usePractice.getState().on).toBe(false);
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBeNull();
    expect(hasApiTransport()).toBe(false);
    expect(screen.getByRole("button", { name: "Try it yourself in practice mode" })).toBeEnabled();
  });
});

describe("what the screens held before", () => {
  // covers: REQ-DEMO-001
  it("is not on a practice screen: starting practice mode clears what the screens held of the operator's own data", async () => {
    // A person with a real local operator has been looking at its payouts: its answers are in the client.
    const client = new QueryClient();
    client.setQueryData(["operator", "campaigns"], [{ id: "c-real", name: "A real payout" }]);
    client.setQueryData(["operator", "health"], { network: "testnet", mock: false });
    client.setQueryData(["receipt", "demo"], { held: true });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="*" element={<><PracticeStart label="Try a practice payout" /><Where /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(client.getQueryCache().findAll()).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Try a practice payout" }));
    await waitFor(() => {
      expect(screen.getByTestId("where")).toHaveTextContent("/new");
    });
    expect(client.getQueryCache().findAll()).toHaveLength(0);
  });

  it("is left alone when the simulation cannot be loaded: nothing changed, so nothing is cleared", async () => {
    const client = new QueryClient();
    client.setQueryData(["operator", "campaigns"], [{ id: "c-real", name: "A real payout" }]);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="*" element={<PracticeStart label="Try a practice payout" load={() => Promise.reject(new Error("no chunk"))} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Try a practice payout" }));
    await screen.findByRole("alert");
    expect(client.getQueryCache().findAll()).toHaveLength(1);
  });
});
