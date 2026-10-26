// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import { useWizardDraft } from "@/features/wizard/draft";
import { EXAMPLE_LIST_NOTE } from "@/features/wizard/example-list";
import { useAudience } from "@/lib/audience";
import "@/test/dom";
import { installFakeOperator, replyWith, type RouteHandler } from "@/test/fake-operator";
import { fixtureJson } from "@/test/operator-fixtures";
import { renderApp } from "@/test/render-app";

const health: RouteHandler = () => replyWith("health.json");

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
  useWizardDraft.getState().reset();
  localStorage.clear();
});

describe("the payouts list", () => {
  it("lists each run as one clickable row: name, people, total, status and time, newest first", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-list.json") });
    renderApp("/campaigns", { signedIn: true });

    const list = await screen.findByRole("list", { name: "Payouts" });
    const rows = within(list).getAllByRole("listitem");
    const fixture = fixtureJson("campaigns-list.json") as { id: string; name: string; recipient_count: number }[];
    expect(rows).toHaveLength(fixture.length);

    for (const entry of fixture) {
      const link = within(list).getAllByRole("link").find((a) => a.getAttribute("href") === `/campaign/${entry.id}`);
      expect(link, entry.name).toBeDefined();
      const row = within(link as HTMLElement);
      expect(row.getByText(entry.name)).toBeInTheDocument();
      expect(row.getByText(entry.recipient_count === 1 ? "1 person" : `${String(entry.recipient_count)} people`)).toBeInTheDocument();
      expect(row.getByText(/\b(TAZ|ZEC)\b/u)).toBeInTheDocument();
    }
    // Newest first.
    const times = within(list).getAllByText((_, el) => el?.tagName === "TIME").map((t) => Date.parse(t.getAttribute("datetime") ?? ""));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Plain words on the surface (a run's own name is the person's, so it is left out of this check).
    let words = list.textContent ?? "";
    for (const entry of fixture) words = words.replace(entry.name, "");
    expect(words).not.toMatch(/declared total|recipient|zatoshi/iu);
  });

  it("has one primary way to start another run", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-list.json") });
    renderApp("/campaigns", { signedIn: true });
    await screen.findByRole("list", { name: "Payouts" });
    expect(screen.getByRole("link", { name: "New payout" })).toHaveAttribute("href", "/new");
  });

  it("when there are none: one sentence and one button, which starts a run with the people list", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
    const user = userEvent.setup();
    renderApp("/campaigns", { signedIn: true });
    expect(await screen.findByText("Each run you send shows up here. Add the people you're paying to start the first.")).toBeInTheDocument();
    expect(screen.queryByText("Drop a CSV here")).toBeNull();

    await user.click(within(screen.getByTestId("payouts-empty")).getByRole("link", { name: "Start a payout" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Add the payouts" })).toBeInTheDocument();
    expect(await screen.findByTestId("people-list")).toBeInTheDocument();
  });

  describe("the example list, when there are none (testnet)", () => {
    // covers: REQ-RUN-003
    it("in the personal view fills the people list with its eight, saying whose they are", async () => {
      useAudience.setState({ audience: "personal" });
      installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
      const user = userEvent.setup();
      renderApp("/campaigns", { signedIn: true });
      const empty = await screen.findByTestId("payouts-empty");
      expect(await within(empty).findByText(EXAMPLE_LIST_NOTE)).toBeInTheDocument();
      await user.click(within(empty).getByRole("button", { name: "Use the example list" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Add the payouts" })).toBeInTheDocument();
      const list = await screen.findByTestId("people-list");
      expect(within(list).getAllByRole("group", { name: /^Person \d+$/u })).toHaveLength(8);
    });

    // covers: REQ-RUN-003
    it("in an organisation's view arrives as the file it is, not hidden behind the drop zone", async () => {
      useAudience.setState({ audience: "organisation" });
      installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
      const user = userEvent.setup();
      renderApp("/campaigns", { signedIn: true });
      const empty = await screen.findByTestId("payouts-empty");
      await user.click(await within(empty).findByRole("button", { name: "Use the example list" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Add the payouts" })).toBeInTheDocument();
      expect(await screen.findByTestId("payout-table")).toBeInTheDocument();
      expect(screen.getByText("demo-recipients.testnet.csv")).toBeInTheDocument();
      expect(screen.queryByText("Drop a CSV here")).toBeNull();
    });
  });

  it("the empty list says so in a heading, shows what a list will look like as bars, and holds no text in the picture", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
    renderApp("/campaigns", { signedIn: true });
    const empty = await screen.findByTestId("payouts-empty");
    expect(within(empty).getByText("No payouts yet")).toBeInTheDocument();
    const ghost = within(empty).getByTestId("ghost-rows");
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost.textContent).toBe("");
    // The link in the header and the one in the empty list both start a run.
    expect(screen.getByRole("link", { name: "New payout" })).toHaveAttribute("href", "/new");
    expect(within(empty).getByRole("link", { name: "Start a payout" })).toHaveAttribute("href", "/new");
  });

  it("says the operator can't be reached, and tries again when asked", async () => {
    let reachable = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (target.endsWith("/health")) return Promise.resolve(new Response(JSON.stringify(fixtureJson("health.json"))));
        if (!reachable) return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve(new Response(JSON.stringify(fixtureJson("campaigns-empty.json"))));
      }),
    );
    const user = userEvent.setup();
    renderApp("/campaigns", { signedIn: true });
    expect(await screen.findByRole("heading", { name: "Can't reach the operator" }, { timeout: 5_000 })).toBeInTheDocument();

    reachable = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Each run you send shows up here. Add the people you're paying to start the first.")).toBeInTheDocument();
  });

  it("falls back to the explainer when the operator refuses the token", async () => {
    installFakeOperator({
      "GET /api/health": health,
      "GET /api/campaigns": () => replyWith("unauthorized-wrong-token.json", 401),
    });
    renderApp("/campaigns", { signedIn: true });
    expect(await screen.findByRole("heading", { level: 1, name: "Open the operator link" })).toBeInTheDocument();
    expect(screen.getByText(/no longer accepted|changes every time/iu)).toBeInTheDocument();
  });

  it("does not ask for campaigns without a token", () => {
    const operator = installFakeOperator({ "GET /api/health": health });
    renderApp("/campaigns");
    expect(operator.to("GET", "/api/campaigns")).toHaveLength(0);
  });
});
