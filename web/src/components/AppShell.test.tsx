// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { renderApp } from "@/test/render-app";
import golden from "../../../fixtures/contract/public-receipt.json?raw";

import { PublicLayout } from "./AppShell";

const TX = "a".repeat(64);
const COMMITMENT = "e".repeat(64);

/** A complete receipt link, as the page reads it. */
const link = (network: string) =>
  `/r/camp-01?network=${network}&tx=${TX}&commitment=${COMMITMENT}&declared_total=534500000`;

function show(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<p>the home page</p>} />
          <Route path="r/:id" element={<p>a receipt</p>} />
          <Route path="privacy" element={<p>the privacy page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The top bar: the header around the primary navigation (a page can have a header of its own). */
const header = () => within(screen.getByRole("navigation", { name: "Primary" }).closest("header") as HTMLElement);
const mainnet = () => header().queryAllByText("Zcash mainnet");
const testnet = () => header().queryAllByText("Zcash testnet");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the public header on a receipt", () => {
  it("says mainnet, loudly, when the link is for mainnet, whatever the page was built for", () => {
    show(link("mainnet"));
    expect(mainnet().length).toBeGreaterThan(0);
    expect(testnet()).toHaveLength(0);
  });

  it("says testnet, quietly, when the link is for testnet", () => {
    show(link("testnet"));
    expect(testnet()).toHaveLength(1);
    expect(mainnet()).toHaveLength(0);
  });

  it.each([
    ["a sample", "/r/demo?demo=real"],
    ["the other samples", "/r/demo?demo=findings"],
    ["a sample with a mainnet link attached, which the page ignores too", `/r/demo?demo=real&${link("mainnet").split("?")[1] ?? ""}`],
  ])("keeps the build's network on %s", (_name, path) => {
    show(path);
    expect(testnet()).toHaveLength(1);
    expect(mainnet()).toHaveLength(0);
  });

  it("keeps the build's network on a link the page cannot read, as the page does", () => {
    show(`/r/camp-01?network=mainnet&commitment=${COMMITMENT}&declared_total=1`); // no transaction
    expect(testnet()).toHaveLength(1);
    expect(mainnet()).toHaveLength(0);
  });

  it("looks only at a receipt page: the same words in the address of any other page change nothing", () => {
    for (const path of ["/?network=mainnet", "/privacy?network=mainnet"]) {
      const { unmount } = show(path);
      expect(testnet(), path).toHaveLength(1);
      expect(mainnet(), path).toHaveLength(0);
      unmount();
    }
  });

  it("goes back to the build's network when the visitor leaves the receipt", async () => {
    const user = userEvent.setup();
    show(link("mainnet"));
    expect(mainnet().length).toBeGreaterThan(0);
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Home" }));
    expect(await screen.findByText("the home page")).toBeInTheDocument();
    expect(mainnet()).toHaveLength(0);
    expect(testnet()).toHaveLength(1);
  });

  it("agrees with the page: a mainnet receipt is headed mainnet and its amounts are ZEC", async () => {
    const answer = { ...(JSON.parse(golden) as object), network: "mainnet" };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }))));
    renderApp(link("mainnet"));
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(mainnet().length).toBeGreaterThan(0);
    expect(testnet()).toHaveLength(0);
    expect(screen.getByTestId("verdict")).toHaveTextContent("5.345 ZEC");
  });
});
