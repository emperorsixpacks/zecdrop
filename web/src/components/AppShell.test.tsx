// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { island, islandPanel, openIsland } from "@/test/island";
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

/** The network the header capsule names, in the one word it is drawn with, and in full in the panel it opens. */
const mainnet = () => within(island()).queryAllByText("Mainnet");
const testnet = () => within(island()).queryAllByText("testnet");
const mainnetInFull = () => within(islandPanel()).queryAllByText("Zcash mainnet");
const testnetInFull = () => within(islandPanel()).queryAllByText("Zcash testnet");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the screen's frame", () => {
  it("is in every page's frame, once, and says nothing: it is a picture of the screen's edge, with no text and nothing to press", () => {
    show("/");
    const frames = screen.getAllByTestId("screen-frame");
    expect(frames).toHaveLength(1);
    const frame = frames[0] as HTMLElement;
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveClass("screen-frame");
    expect(frame.textContent).toBe("");
    expect(frame.children).toHaveLength(0);
    expect(frame.matches("a, button, input, [tabindex]")).toBe(false);
  });

  it("is on a page of the operator's side too, and on the page that has no route", () => {
    renderApp("/campaigns");
    expect(screen.getAllByTestId("screen-frame")).toHaveLength(1);
  });

  it("is after the page's content in the page's order, so nothing it does can come between a keyboard and the page", () => {
    show("/");
    const frame = screen.getByTestId("screen-frame");
    const main = screen.getByRole("main");
    expect(main.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the skip link clear of the curve: it is placed by the frame's own distance, not by a number of its own", () => {
    show("/");
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.className).toContain("focus:top-(--frame-pad)");
    expect(skip.className).toContain("focus:left-(--frame-pad)");
  });
});

describe("the public header on a receipt", () => {
  it("says mainnet, loudly, when the link is for mainnet, whatever the page was built for", () => {
    show(link("mainnet"));
    expect(mainnet()).toHaveLength(1);
    expect(mainnetInFull()).toHaveLength(1);
    expect(testnet()).toHaveLength(0);
    expect(testnetInFull()).toHaveLength(0);
  });

  it("says testnet, quietly, when the link is for testnet", () => {
    show(link("testnet"));
    expect(testnet()).toHaveLength(1);
    expect(testnetInFull()).toHaveLength(1);
    expect(mainnet()).toHaveLength(0);
    expect(mainnetInFull()).toHaveLength(0);
  });

  it("names the page a receipt", () => {
    show(link("testnet"));
    expect(island()).toHaveAccessibleName("ZecDrop Receipt testnet");
  });

  it.each([
    ["a sample", "/r/demo?demo=real"],
    ["the other samples", "/r/demo?demo=findings"],
    ["a sample with a mainnet link attached, which the page ignores too", `/r/demo?demo=real&${link("mainnet").split("?")[1] ?? ""}`],
  ])("keeps the build's network on %s", (_name, path) => {
    show(path);
    expect(testnet()).toHaveLength(1);
    expect(testnetInFull()).toHaveLength(1);
    expect(mainnet()).toHaveLength(0);
    expect(mainnetInFull()).toHaveLength(0);
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
    expect(mainnet()).toHaveLength(1);
    await user.click(within(await openIsland(user)).getByRole("link", { name: "Home" }));
    expect(await screen.findByText("the home page")).toBeInTheDocument();
    expect(mainnet()).toHaveLength(0);
    expect(testnet()).toHaveLength(1);
    expect(island()).toHaveAccessibleName("ZecDrop Home testnet");
  });

  it("agrees with the page: a mainnet receipt is headed mainnet and its amounts are ZEC", async () => {
    const answer = { ...(JSON.parse(golden) as object), network: "mainnet" };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }))));
    renderApp(link("mainnet"));
    await screen.findByRole("heading", { level: 2, name: "Status" });
    expect(mainnet()).toHaveLength(1);
    expect(testnet()).toHaveLength(0);
    expect(screen.getByTestId("verdict")).toHaveTextContent("5.345 ZEC");
  });
});
