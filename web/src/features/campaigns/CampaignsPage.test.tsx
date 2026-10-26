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

describe("the campaigns list", () => {
  it("lists each campaign with its phase, counts and declared total, newest first", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-list.json") });
    renderApp("/campaigns", { signedIn: true });

    const list = await screen.findByRole("list", { name: "Campaigns" });
    const rows = within(list).getAllByRole("listitem");
    const fixture = fixtureJson("campaigns-list.json") as { id: string; name: string; recipient_count: number }[];
    expect(rows).toHaveLength(fixture.length);

    for (const entry of fixture) {
      const link = within(list).getByRole("link", { name: entry.name });
      expect(link).toHaveAttribute("href", `/campaign/${entry.id}`);
    }
    expect(within(list).getAllByText(/payouts? in \d+ batch/u).length).toBe(fixture.length);
    expect(within(list).getAllByText("Declared total").length).toBe(fixture.length);
  });

  it("invites the first campaign when there are none", async () => {
    installFakeOperator({ "GET /api/health": health, "GET /api/campaigns": () => replyWith("campaigns-empty.json") });
    renderApp("/campaigns", { signedIn: true });
    expect(await screen.findByRole("heading", { name: "No campaigns yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a campaign" })).toHaveAttribute("href", "/new");
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
    expect(await screen.findByRole("heading", { name: "No campaigns yet" })).toBeInTheDocument();
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
