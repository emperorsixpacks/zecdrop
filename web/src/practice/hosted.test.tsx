// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://demo.example.org/" }
//
// Practice mode on a hosted, public copy: opened from a name that is not the operator's loopback address, where the operator
// pages explain themselves and call nothing. With practice mode on they are the operator's own screens, answered by the
// simulation inside the page, so there is still no operator to call, and still nothing is.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearSession } from "@/api/operator/session";
import { useWizardDraft } from "@/features/wizard/draft";
import { startPractice, stopPractice } from "@/lib/practice-mode";
import { pace } from "@/practice/pace";
import "@/test/dom";
import { watchLeaks, type Leaks } from "@/test/leaks";
import { practicePayout } from "@/test/practice-flow";
import { renderApp } from "@/test/render-app";

let leaks: Leaks;

beforeEach(() => {
  sessionStorage.clear();
  clearSession();
  useWizardDraft.getState().reset();
  pace.stepMs = 5;
  leaks = watchLeaks();
});

afterEach(() => {
  stopPractice();
  leaks.restore();
  clearSession();
  sessionStorage.clear();
});

describe("the page is served from a hosted name", () => {
  it("is not the operator's loopback address", () => {
    expect(window.location.hostname).toBe("demo.example.org");
  });

  // covers: REQ-DEMO-001
  it.each(["/campaigns", "/new", "/audit", "/campaign/practice-000000"])("%s opens the operator's screen in practice mode, not the explanation", async (path) => {
    await startPractice();
    renderApp(path);
    await screen.findAllByRole("heading", { level: 1 });
    expect(screen.queryByRole("heading", { name: "Run the operator on your own machine" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Open the operator link" })).toBeNull();
    // The operator's own menu is there, beside the practice mode's banner.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Payouts" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Practice mode" })).toBeInTheDocument();
    expect(leaks.network).toEqual([]);
  });

  // covers: REQ-DEMO-001
  it("is still the explanation, and calls nothing, when practice mode is off", () => {
    renderApp("/campaigns");
    expect(screen.getByRole("heading", { level: 1, name: "Run the operator on your own machine" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Practice mode" })).toBeNull();
    expect(leaks.network).toEqual([]);
  });

  // covers: REQ-DEMO-001
  it("goes through a whole practice payout and calls nothing at all", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await practicePayout(user, () => undefined);
    expect(leaks.network).toEqual([]);
    expect(leaks.databases).toEqual([]);
    expect(leaks.cookies).toEqual([]);
    expect(leaks.storage.filter((write) => write.area !== "session")).toEqual([]);
  }, 30_000);
});
