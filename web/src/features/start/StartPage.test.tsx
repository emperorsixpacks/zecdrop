// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TESTNET_FAUCET_URL } from "@/lib/faucet";
import "@/test/dom";
import { renderApp } from "@/test/render-app";

import { START_COMMANDS } from "./commands";

const main = () => screen.getByRole("main");

/** The words of the page, text node by text node (see HomePage.test.tsx). */
function words(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    found.push(...(node.textContent ?? "").split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)));
  }
  return found;
}

describe("the page that says how to make a payout", () => {
  // covers: REQ-RUN-002
  it("gives the commands that run ZecDrop on your own computer, ready to copy", () => {
    renderApp("/start");
    expect(screen.getByRole("heading", { level: 1, name: "Make a payout" })).toBeInTheDocument();
    expect(START_COMMANDS).toEqual(["git clone https://github.com/JemIIahh/zecdrop.git", "cd zecdrop", "./zecdrop up"]);
    expect(screen.getByTestId("start-command").textContent).toBe(START_COMMANDS.join("\n"));
    expect(within(main()).getByRole("button", { name: "Copy the commands" })).toBeInTheDocument();
  });

  // covers: REQ-RUN-002
  it("says why it runs there, what it needs, and what happens next", () => {
    renderApp("/start");
    expect(screen.getByText("ZecDrop runs on your own computer, so your keys and your list never leave it.")).toBeInTheDocument();
    const docker = within(main()).getByRole("link", { name: "Docker Desktop" });
    expect(docker).toHaveAttribute("href", "https://www.docker.com/products/docker-desktop/");
    expect(docker).toHaveAttribute("rel", "noopener noreferrer");
    expect(main()).toHaveTextContent("The first start builds ZecDrop, which takes a few minutes to half an hour.");
    const next = within(screen.getByRole("region", { name: "ZecDrop opens in your browser" })).getAllByRole("listitem");
    expect(next.map((li) => li.textContent)).toEqual([
      "Add the people you're paying, or use the example list.",
      "Fund the payout. Test coins are free from the testnet faucet.",
      "Send it, and share the receipt.",
    ]);
    expect(within(next[1] as HTMLElement).getByRole("link", { name: "testnet faucet" })).toHaveAttribute("href", TESTNET_FAUCET_URL);
    expect(main()).toHaveTextContent("Testnet only for now. Stop it with ./zecdrop down.");
  });

  it("is short: under 120 words", () => {
    renderApp("/start");
    const found = words(main());
    expect(found.length, found.join(" ")).toBeLessThan(120);
  });

  it("simulates nothing and says 'practice' nowhere", () => {
    renderApp("/start");
    expect(main().textContent).not.toMatch(/practi[cs]e/iu);
    expect(within(main()).queryByRole("button", { name: /^Try /u })).toBeNull();
  });
});
