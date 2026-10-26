// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";

import { TopBar } from "./TopBar";

function show(props: Parameters<typeof TopBar>[0], path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the public header", () => {
  it("is the name, the three links, the network, the theme and the appearance panel", () => {
    show({ showOperatorNav: false });
    expect(screen.getByRole("link", { name: "ZecDrop" })).toHaveAttribute("href", "/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Home", "Sample receipt", "How privacy works"]);
    expect(screen.getByText("Zcash testnet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Switch to (dark|light) theme$/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
  });

  it("puts the links in a Menu on a phone, so the header is one line, and closes it on choosing one", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const menu = await screen.findByRole("navigation", { name: "Menu" });
    expect(within(menu).getAllByRole("link").map((a) => a.textContent)).toEqual(["Home", "Sample receipt", "How privacy works"]);
    await user.click(within(menu).getByRole("link", { name: "How privacy works" }));
    expect(screen.queryByRole("navigation", { name: "Menu" })).toBeNull();
  });

  it("says mainnet loudly where the coins are real, and testnet quietly", () => {
    const { unmount } = show({ showOperatorNav: false, network: "mainnet" });
    expect(screen.getAllByText("Zcash mainnet").length).toBeGreaterThan(0);
    unmount();
    show({ showOperatorNav: false, network: "testnet" });
    expect(screen.queryByText("Zcash mainnet")).toBeNull();
  });
});

describe("the operator's header", () => {
  it("is the name, Payouts and Audit, and a line of its own for the state of the chain", () => {
    show({ showOperatorNav: true, mock: true }, "/campaigns");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Payouts", "Audit"]);
    expect(screen.getByRole("status")).toHaveTextContent("Practice mode: nothing is sent to Zcash");
    expect(screen.getByText("Zcash testnet")).toBeInTheDocument();
  });

  it("says when the chain is not known", () => {
    show({ showOperatorNav: true, modeUnknown: true }, "/campaigns");
    expect(screen.getByRole("status")).toHaveTextContent("Chain mode unknown: practice controls hidden");
  });

  it("has the one button once, wherever the screen puts it", () => {
    show({ showOperatorNav: true }, "/campaigns");
    expect(screen.getAllByRole("link", { name: "New payout" })).toHaveLength(1);
  });

  it("puts that button in the first line on a wide screen", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} })),
    );
    show({ showOperatorNav: true }, "/campaigns");
    const links = screen.getAllByRole("link", { name: "New payout" });
    expect(links).toHaveLength(1);
    expect(links[0]?.closest("div")?.className).not.toContain("w-full");
  });
});
