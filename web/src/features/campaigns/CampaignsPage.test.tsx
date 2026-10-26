// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { installFakeOperator, replyWith, type RouteHandler } from "@/test/fake-operator";
import { fixtureJson } from "@/test/operator-fixtures";
import { renderApp } from "@/test/render-app";

const health: RouteHandler = () => replyWith("health.json");

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
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

  it("when there are none: one sentence and the drop zone, which starts a run with what was dropped", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
    const user = userEvent.setup();
    renderApp("/campaigns", { signedIn: true });
    expect(await screen.findByText("Each run you send shows up here. Drop a list to start the first.")).toBeInTheDocument();
    expect(screen.getByText("Drop a CSV here")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "or paste it" }));
    await user.click(screen.getByLabelText("Paste your list"));
    await user.paste("address,amount\nu1x,1\n");
    expect(await screen.findByRole("heading", { level: 1, name: "Add the payouts" })).toBeInTheDocument();
    expect(await screen.findByTestId("payout-count")).toHaveTextContent("1 person");
  });

  it("the empty list says so in a heading, shows what a list will look like as bars, and holds no text in the picture", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
    renderApp("/campaigns", { signedIn: true });
    const empty = await screen.findByTestId("payouts-empty");
    expect(within(empty).getByText("No payouts yet")).toBeInTheDocument();
    const ghost = within(empty).getByTestId("ghost-rows");
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost.textContent).toBe("");
    // The one way to start is still the link in the header, and the drop zone takes a file straight away.
    expect(screen.getByRole("link", { name: "New payout" })).toHaveAttribute("href", "/new");
    expect(within(empty).getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
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
    expect(await screen.findByText("Each run you send shows up here. Drop a list to start the first.")).toBeInTheDocument();
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
