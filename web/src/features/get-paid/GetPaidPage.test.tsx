// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import demoCsv from "../../../../examples/demo-recipients.testnet.csv?raw";
import "@/test/dom";
import { openIsland } from "@/test/island";
import { renderApp } from "@/test/render-app";

import shapeSource from "../../lib/address-shape.ts?raw";
import pageSource from "./GetPaidPage.tsx?raw";
import wordingSource from "./wording.ts?raw";
import {
  ASSURANCE,
  BUTTONS_HINT,
  COPY_STEP,
  FEEDBACK_TEXT,
  OTHER_ADDRESSES,
  OTHER_WALLETS_NOTE,
  PROMISE,
  SHAPE_NOTE,
  SHIELDED_NOTE,
  shareText,
  WALLET_LINE,
  WHY_TEXT,
  ZODL_URL,
} from "./wording";

// ---- Harness ---------------------------------------------------------------

// Addresses of each shape. Only the shape matters to the page; none of these is anyone's address. The practice
// one is the first real, public address of the sample batch's demo list.
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const MAINNET = `u1${BECH32.repeat(4).slice(0, 104)}`;
const TESTNET = (demoCsv.trim().split("\n")[1] ?? "").split(",")[0] ?? "";
const TRANSPARENT = "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L";
const SAPLING = `zs1${BECH32.repeat(3).slice(0, 75)}`;
const NBSP = String.fromCharCode(0xa0);

const field = () => screen.getByLabelText("Your address");
const paste = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
};
const result = () => screen.getByTestId("shape-result");
const feedback = () => screen.getByTestId("share-feedback");
const shareButton = () => screen.queryByRole("button", { name: "Share" });
const copyButton = () => screen.getByRole("button", { name: "Copy" });

/** The phone has a share sheet: `navigator.share` is there, and answers as the test says. */
function withShare(impl: (data?: ShareData) => Promise<void>) {
  const share = vi.fn(impl);
  Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
  return share;
}

function show() {
  return renderApp("/get-paid");
}

beforeEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Source with its comments taken out, so a scan looks at what the code does and not at what it says it must not. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");

// ---- The page ----------------------------------------------------------------

describe("the page", () => {
  it("opens with one promise, in plain words", async () => {
    show();
    expect(screen.getByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toBe("Get paid in ZEC - ZecDrop");
    });
    const promise = screen.getByText(PROMISE);
    expect(promise.tagName).toBe("P");
    // One line: a shielded wallet and one address to give the payer.
    expect(PROMISE).toContain("get a shielded wallet and give the payer one address");
    // Under it, small: the wallet is never seen, and nothing leaves the phone.
    expect(screen.getByText(ASSURANCE).tagName).toBe("P");
    expect(ASSURANCE).toContain("ZecDrop never sees your wallet.");
    expect(ASSURANCE).toContain("Nothing on this page leaves your phone unless you share it.");
  });

  // The owner found the page wordy (2026-10-19): it stays short. This is a ceiling on what the page says before anything is pasted,
  // not a target, and a sentence cannot be added without taking one away. The page was 376 words before.
  it("stays short: the words in the page before anything is pasted are under a ceiling", () => {
    show();
    const main = screen.getByRole("main");
    const words = (main.textContent ?? "").replace(/([a-z.])([A-Z])/gu, "$1 $2").split(/\s+/u).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(240);
    // And no step has more than two paragraphs of its own (a link on a line of its own is not one), so none is a wall of text.
    for (const item of Array.from(document.querySelectorAll("main ol > li"))) {
      const paragraphs = Array.from(item.querySelectorAll(":scope > div > p")).filter((p) => p.querySelector("a") === null);
      expect(paragraphs.length, item.querySelector("h2")?.textContent ?? "").toBeLessThanOrEqual(2);
    }
  });

  it("has the four steps, in order, as a list", () => {
    show();
    const steps = document.querySelector("main ol");
    expect(steps).not.toBeNull();
    expect(Array.from(steps?.children ?? [], (item) => item.tagName)).toEqual(["LI", "LI", "LI", "LI"]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Get a wallet",
      "Copy your address",
      "Give it to your payer",
      "When you are paid",
    ]);
    // The numbers are drawn, not read: the list already says which step is which.
    expect(Array.from(steps?.querySelectorAll(":scope > li > div > span[aria-hidden='true']") ?? [], (n) => n.textContent)).toEqual(["1", "2", "3", "4"]);
  });

  it("step 1 names Zodl, links to zodl.com and nowhere else, and says where its claim comes from", async () => {
    const user = userEvent.setup();
    show();
    const main = screen.getByRole("main");
    const text = main.textContent ?? "";
    expect(text).toContain("Zodl is a Zcash wallet for phones.");
    // What the page says of the wallet is said to come from its release notes, the only thing that has been read.
    expect(text).toContain("By its release notes, version 3.8.0 or newer supports the shielded pool that payouts use.");
    expect(WALLET_LINE).toContain("release notes");
    // The rest is one tap away, so the step stays short: what shielded means, and what has and has not been checked.
    expect(text).not.toContain(SHIELDED_NOTE);
    const more = screen.getByRole("button", { name: "More about wallets" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const opened = main.textContent ?? "";
    expect(opened).toContain("Shielded means the receiver and the amount are encrypted on the public chain.");
    expect(opened).toContain("Other wallets may work, but we have only checked Zodl's release notes.");
    expect(opened).toContain("A wallet that cannot receive in the current pool will not show the payout.");
    expect(OTHER_WALLETS_NOTE).toContain("only checked Zodl's release notes");

    const link = within(main).getByRole("link", { name: /Zodl at zodl\.com/u });
    expect(link).toHaveAttribute("href", ZODL_URL);
    expect(ZODL_URL).toBe("https://zodl.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")?.split(/\s+/u).sort()).toEqual(["noopener", "noreferrer"]);
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("links out to one site only, and makes up no app-store link", () => {
    show();
    const hrefs = Array.from(document.querySelectorAll("a[href]"), (a) => a.getAttribute("href") ?? "");
    const external = hrefs.filter((href) => /^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("//"));
    expect(external).toEqual([ZODL_URL]);
    expect(document.body.textContent).not.toMatch(/App Store|Google Play|apps\.apple|play\.google|testflight/iu);
  });

  it("step 2 says which address to copy, and what to do with each of the others", () => {
    show();
    const text = screen.getByRole("main").textContent ?? "";
    expect(text).toContain("In your wallet, open Receive and copy the address that starts with u1.");
    expect(COPY_STEP).toBe("In your wallet, open Receive and copy the address that starts with u1.");
    // The others are one short row each: how it starts, and what to do about it.
    const rows = Array.from(document.querySelectorAll("main ol > li:nth-child(2) ul > li"), (row) => row.textContent);
    expect(rows).toEqual([
      "utest1A testnet address: play money, for practice only.",
      "t1 or t3Not for payouts: it shows every payment publicly.",
      "zs1An older kind (Sapling). The payout tool asks for the u1 one.",
    ]);
    expect(OTHER_ADDRESSES.map((kind) => kind.starts)).toEqual(["utest1", "t1 or t3", "zs1"]);
  });

  it("step 4 says when the payout shows, what a payslip is, and that it shows the memo, with a link to check one", () => {
    show();
    const main = screen.getByRole("main");
    const text = main.textContent ?? "";
    expect(text).toContain("Your wallet shows the payout after a few confirmations, about 4 minutes on mainnet today.");
    expect(text).toContain("If there is a memo, it shows with the payout.");
    expect(text).toContain("a small file that proves one payout to you");
    expect(text).toContain("It shows the memo too, so share it with care.");
    const link = within(main).getByRole("link", { name: "Check a payslip" });
    expect(link).toHaveAttribute("href", "/payslip");
    expect(link).not.toHaveAttribute("target");
  });

  it("ends with an honest pointer to what stays private, and the link to How privacy works", () => {
    show();
    const main = screen.getByRole("main");
    expect(main.textContent).toContain("Shielded does not mean invisible: a payout of one, or of equal amounts, can let others work out the amount.");
    expect(within(main).getByRole("link", { name: "How privacy works" })).toHaveAttribute("href", "/privacy");
  });

  it("is in the public menu, and the home page has the small link to it", () => {
    show();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Get paid" })).toHaveAttribute("href", "/get-paid");
    expect(within(nav).getByRole("link", { name: "Get paid" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Home",
      "Sample receipt",
      "Get paid",
      "Check a payslip",
      "How privacy works",
    ]);
  });
});

describe("the home page's link", () => {
  it("is one calm line that leads to the page, after the two buttons", () => {
    renderApp("/");
    const link = screen.getByRole("link", { name: "Being paid? Start here" });
    expect(link).toHaveAttribute("href", "/get-paid");
    const buttons = screen.getByRole("link", { name: "See a real receipt" });
    expect(buttons.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((link.textContent ?? "").split(/\s+/u).length).toBeLessThanOrEqual(5);
  });
});

// ---- What the address looks like -----------------------------------------------

describe("what a pasted address looks like", () => {
  it("is said nowhere until something is pasted, but the limit of the check is always on the page", () => {
    show();
    expect(result()).toBeEmptyDOMElement();
    expect(screen.getByText(SHAPE_NOTE)).toBeInTheDocument();
    expect(SHAPE_NOTE).toContain("This checks the shape only.");
    expect(SHAPE_NOTE).toContain("It cannot tell whether the address is valid or yours");
    expect(SHAPE_NOTE).toContain("the payer's tool checks it fully.");
    expect(field()).toHaveAttribute("aria-describedby", expect.stringContaining(screen.getByText(SHAPE_NOTE).id));
  });

  const cases: [label: string, address: () => string, kind: string, title: string, sentence: string][] = [
    ["a real-money unified address", () => MAINNET, "mainnet_unified", "Looks like a real-money address", "It starts with u1, the kind a ZecDrop payout can pay."],
    [
      "a practice testnet address",
      () => TESTNET,
      "testnet_unified",
      "Looks like a practice address",
      "It starts with utest1: a testnet address, play money for practice only. Do not give it to someone paying real ZEC.",
    ],
    [
      "a transparent address",
      () => TRANSPARENT,
      "transparent",
      "Looks like a transparent address",
      "It does not suit payouts. A transparent address shows every payment publicly, and ZecDrop payouts are for shielded wallets.",
    ],
    ["a Sapling address", () => SAPLING, "sapling", "Looks like a Sapling address", "That is an older kind of shielded address. The payout tool asks for the u1 one"],
    ["something that is not an address", () => "hello there", "unrecognised", "Not recognised", WHY_TEXT.prefix],
  ];

  it.each(cases)("%s", (_label, address, kind, title, sentence) => {
    show();
    paste(address());
    const shape = within(result()).getByTestId("shape");
    expect(shape).toHaveAttribute("data-kind", kind);
    expect(within(shape).getByText(title)).toBeInTheDocument();
    expect(shape.textContent).toContain(sentence);
  });

  it("says why something is not recognised, in one sentence for each reason", () => {
    show();
    const reasons: [string, string, keyof typeof WHY_TEXT][] = [
      ["a space inside", `${MAINNET.slice(0, 40)} ${MAINNET.slice(40)}`, "inside_space"],
      ["a mix of capitals and small letters", `U1${MAINNET.slice(2)}`, "mixed_case"],
      ["a character no address uses", `${MAINNET.slice(0, 40)}!${MAINNET.slice(41)}`, "characters"],
      ["too few characters", MAINNET.slice(0, 60), "length"],
      ["a start no Zcash address has", `bc1${MAINNET.slice(3)}`, "prefix"],
    ];
    for (const [, text, why] of reasons) {
      paste(text);
      const shape = within(result()).getByTestId("shape");
      expect(shape).toHaveAttribute("data-kind", "unrecognised");
      expect(shape.textContent).toContain("Not recognised");
      expect(shape.textContent).toContain(WHY_TEXT[why]);
    }
  });

  it("never claims more than a shape: no result says valid, verified, checked or yours", () => {
    show();
    for (const text of [MAINNET, TESTNET, TRANSPARENT, SAPLING, "nonsense"]) {
      paste(text);
      expect(result().textContent).not.toMatch(/\b(is valid|are valid|verified|confirmed|safe|yours|correct)\b/iu);
      expect(result().textContent).toMatch(/Looks like|Not recognised/u);
    }
  });

  it("does not repeat what was pasted", () => {
    show();
    for (const text of [MAINNET, TESTNET, TRANSPARENT, SAPLING, "some text that is no address"]) {
      paste(text);
      expect(result().textContent).not.toContain(text);
    }
    expect(result().textContent).not.toContain(MAINNET);
  });

  it("changes as the text changes, and empties when it is cleared", () => {
    show();
    paste(MAINNET);
    expect(within(result()).getByTestId("shape")).toHaveAttribute("data-kind", "mainnet_unified");
    paste(TRANSPARENT);
    expect(within(result()).getByTestId("shape")).toHaveAttribute("data-kind", "transparent");
    paste("   \n  ");
    expect(result()).toBeEmptyDOMElement();
  });

  it("reads an address with space or line breaks around it, which a paste often has", () => {
    show();
    paste(`\n  ${MAINNET}${NBSP}\r\n`);
    expect(within(result()).getByTestId("shape")).toHaveAttribute("data-kind", "mainnet_unified");
  });
});

// ---- Share and Copy ----------------------------------------------------------------

describe("the buttons, by what is pasted", () => {
  it.each([
    ["nothing", () => ""],
    ["a transparent address", () => TRANSPARENT],
    ["a Sapling address", () => SAPLING],
    ["something that is not an address", () => "hello"],
    ["an address with a space inside", () => `${MAINNET.slice(0, 30)} ${MAINNET.slice(30)}`],
  ])("are off for %s, and the page says when they turn on", (_label, address) => {
    withShare(() => Promise.resolve());
    show();
    paste(address());
    expect(shareButton()).toBeDisabled();
    expect(copyButton()).toBeDisabled();
    expect(screen.getByText(BUTTONS_HINT)).toBeInTheDocument();
  });

  it.each([
    ["a real-money unified address", () => MAINNET],
    ["a practice testnet address", () => TESTNET],
  ])("are on for %s", (_label, address) => {
    withShare(() => Promise.resolve());
    show();
    paste(address());
    expect(shareButton()).toBeEnabled();
    expect(copyButton()).toBeEnabled();
    expect(screen.queryByText(BUTTONS_HINT)).toBeNull();
  });

  it("has Copy alone, as the main button, where the phone has no share sheet", () => {
    show();
    expect(shareButton()).toBeNull();
    paste(MAINNET);
    expect(copyButton()).toBeEnabled();
    expect(copyButton().getAttribute("data-variant")).toBe("default");
  });

  it("has Share as the main button and Copy beside it, where the phone has one", () => {
    withShare(() => Promise.resolve());
    show();
    expect(shareButton()?.getAttribute("data-variant")).toBe("default");
    expect(copyButton().getAttribute("data-variant")).toBe("outline");
  });

  it("are as tall as a thumb (at least 44px, by the design's own sizes)", () => {
    withShare(() => Promise.resolve());
    show();
    for (const button of [shareButton(), copyButton()]) expect(button?.className).toMatch(/\bh-11\b/u);
    for (const link of within(screen.getByRole("main")).getAllByRole("link")) {
      expect(`${link.className} ${link.closest("[data-slot='button']")?.className ?? ""}`, link.textContent ?? "").toMatch(/\bmin-h-11\b|\bh-11\b/u);
    }
  });
});

describe("Share", () => {
  it("hands the share sheet one sentence with the address, and nothing else", async () => {
    const share = withShare(() => Promise.resolve());
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    await user.click(shareButton() as HTMLElement);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ text: `My Zcash address for payouts: ${MAINNET}` });
    expect(shareText(MAINNET)).toBe(`My Zcash address for payouts: ${MAINNET}`);
    // No title, no link: the page's own address is not part of what is shared.
    expect(Object.keys(share.mock.calls[0]?.[0] ?? {})).toEqual(["text"]);
    expect(feedback()).toBeEmptyDOMElement();
  });

  it("shares the address trimmed and in small letters, as the check read it", async () => {
    const share = withShare(() => Promise.resolve());
    const user = userEvent.setup();
    show();
    paste(`\n  ${MAINNET.toUpperCase()}\n`);
    await user.click(shareButton() as HTMLElement);
    expect(share).toHaveBeenCalledWith({ text: shareText(MAINNET) });
  });

  it("shares a practice address too", async () => {
    const share = withShare(() => Promise.resolve());
    const user = userEvent.setup();
    show();
    paste(TESTNET);
    await user.click(shareButton() as HTMLElement);
    expect(share).toHaveBeenCalledWith({ text: shareText(TESTNET) });
  });

  it("says nothing when the person closes the share sheet (an AbortError is a choice, not an error)", async () => {
    const share = withShare(() => Promise.reject(new DOMException("Share canceled", "AbortError")));
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(shareButton() as HTMLElement);
    expect(share).toHaveBeenCalledTimes(1);
    expect(feedback()).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    // And it can be tried again.
    expect(shareButton()).toBeEnabled();
  });

  it.each([
    ["a NotAllowedError (no user gesture, or a policy)", () => new DOMException("not allowed", "NotAllowedError")],
    ["a TypeError (data the platform does not take)", () => new TypeError("bad data")],
    ["a plain error", () => new Error("no share target")],
    ["something that is not an error", () => "nope" as unknown as Error],
  ])("falls back to copying the address after %s, and says so", async (_label, error) => {
    const share = withShare(() => Promise.reject(error()));
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    await user.click(shareButton() as HTMLElement);
    expect(share).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(feedback()).toHaveTextContent(FEEDBACK_TEXT.fallback_copied);
    });
    // The address alone is on the clipboard, ready to paste into a payout list.
    expect(await navigator.clipboard.readText()).toBe(MAINNET);
  });

  it("falls back too when the share call itself throws", async () => {
    withShare(() => {
      throw new TypeError("share is not allowed here");
    });
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    await user.click(shareButton() as HTMLElement);
    await waitFor(() => {
      expect(feedback()).toHaveTextContent(FEEDBACK_TEXT.fallback_copied);
    });
    expect(await navigator.clipboard.readText()).toBe(MAINNET);
  });

  it("says it could not copy when there is no sharing and no clipboard either", async () => {
    withShare(() => Promise.reject(new Error("no")));
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    Reflect.deleteProperty(navigator, "clipboard");
    await user.click(shareButton() as HTMLElement);
    await waitFor(() => {
      expect(feedback()).toHaveTextContent(FEEDBACK_TEXT.copy_failed);
    });
  });
});

describe("Copy", () => {
  it("puts the address, alone, on the clipboard, and says so where it can be seen", async () => {
    const user = userEvent.setup();
    show();
    paste(`  ${MAINNET.toUpperCase()}\n`);
    await user.click(copyButton());
    expect(await navigator.clipboard.readText()).toBe(MAINNET);
    expect(feedback()).toHaveTextContent(FEEDBACK_TEXT.copied);
    expect(FEEDBACK_TEXT.copied).toBe("Address copied.");
  });

  it("says it could not copy, and what to do instead, when the clipboard refuses", async () => {
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await user.click(copyButton());
    expect(feedback()).toHaveTextContent(FEEDBACK_TEXT.copy_failed);
    expect(FEEDBACK_TEXT.copy_failed).toContain("Select the address in the box and copy it yourself.");
  });

  it("says it could not copy where there is no clipboard (a page that is not secure)", async () => {
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    Reflect.deleteProperty(navigator, "clipboard");
    await user.click(copyButton());
    expect(feedback()).toHaveTextContent(FEEDBACK_TEXT.copy_failed);
  });

  it("forgets what it said as soon as the address changes", async () => {
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    await user.click(copyButton());
    expect(feedback()).toHaveTextContent(FEEDBACK_TEXT.copied);
    paste(`${MAINNET}q`);
    expect(feedback()).toBeEmptyDOMElement();
  });
});

// ---- For a screen reader and the keyboard -----------------------------------------------

describe("for a screen reader and the keyboard", () => {
  it("names the box, and says what the check can and cannot tell as its description", () => {
    show();
    const box = screen.getByRole("textbox", { name: "Your address" });
    expect(box).toBe(field());
    const description = (box.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(description).toContain(SHAPE_NOTE);
    expect(box).toHaveAttribute("spellcheck", "false");
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(box).toHaveAttribute("autocapitalize", "off");
  });

  it("has the result and the outcome of Share or Copy in polite live regions that are there from the start", () => {
    show();
    for (const region of [result(), feedback()]) {
      expect(region).toHaveAttribute("role", "status");
      expect(region).toHaveAttribute("aria-live", "polite");
    }
    expect(result()).toHaveAttribute("aria-atomic", "true");
  });

  it("puts the result inside its live region when something is pasted, and keeps the region", () => {
    show();
    const before = result();
    paste(MAINNET);
    expect(result()).toBe(before);
    expect(within(result()).getByText("Looks like a real-money address")).toBeInTheDocument();
  });

  it("has one h1, steps with headings, and no positive tabindex", () => {
    show();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelectorAll("[tabindex]:not([tabindex='0']):not([tabindex='-1'])")).toHaveLength(0);
  });

  it("has no focus trap: Tab runs from the box through the buttons and the links and out of the page, and Shift+Tab runs back", async () => {
    withShare(() => Promise.resolve());
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    field().focus();
    const forward: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      await user.tab();
      const now = document.activeElement;
      if (now === null || now === document.body) break;
      forward.push((now.textContent ?? now.tagName).trim().slice(0, 30));
    }
    // In reading order: the two buttons, the link in step 4, the link at the end, then the footer's. And it ends.
    expect(forward.slice(0, 2)).toEqual(["Share", "Copy"]);
    expect(forward.indexOf("Check a payslip")).toBeGreaterThan(1);
    expect(forward.indexOf("How privacy works")).toBeGreaterThan(forward.indexOf("Check a payslip"));
    expect(forward.length).toBeLessThan(40);
    // Back from Copy: Share, then the box.
    copyButton().focus();
    await user.tab({ shift: true });
    expect(shareButton()).toHaveFocus();
    await user.tab({ shift: true });
    expect(field()).toHaveFocus();
    // Nothing on the page is a dialog, which is what would hold focus.
    expect(document.querySelector("dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']")).toBeNull();
  });
});

// ---- The promise of REQ-ONB-001: nothing leaves, nothing is kept ----------------------------

// covers: REQ-ONB-001
describe("what the page does with an address", () => {
  it("makes no request and writes nothing while an address is pasted, checked and shared", async () => {
    // Every way a page can reach a server, or keep something.
    const fetchMock = vi.fn(() => Promise.reject(new Error("no request may be made")));
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(XMLHttpRequest.prototype, "open");
    const send = vi.spyOn(XMLHttpRequest.prototype, "send");
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    const image = vi.fn();
    vi.stubGlobal("Image", image);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const clear = vi.spyOn(Storage.prototype, "clear");
    const cookieWrites = vi.spyOn(document, "cookie", "set");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const consoleCalls: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(`${method}: ${args.map(String).join(" ")}`);
      });
    }
    const share = withShare(() => Promise.resolve());
    const before = window.location.href;

    const user = userEvent.setup();
    const view = show();
    // Pasted, and checked: an address of every shape, and things that are none.
    for (const text of [MAINNET, TESTNET, TRANSPARENT, SAPLING, MAINNET.toUpperCase(), `${MAINNET} `, "u1", "not an address", `${NBSP}\n`, ""]) paste(text);
    paste(MAINNET);
    // Shared and copied: the share sheet is the person's own act, and the clipboard is theirs.
    await user.click(shareButton() as HTMLElement);
    await user.click(copyButton());
    expect(share).toHaveBeenCalledTimes(1);
    expect(await navigator.clipboard.readText()).toBe(MAINNET);
    // A share that fails, and one that is closed, are no different.
    share.mockRejectedValueOnce(new DOMException("closed", "AbortError"));
    await user.click(shareButton() as HTMLElement);
    share.mockRejectedValueOnce(new Error("no"));
    await user.click(shareButton() as HTMLElement);

    // No request of any kind.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
    expect(view.client.getQueryCache().getAll()).toHaveLength(0);
    // Nothing kept, anywhere.
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(cookieWrites).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    // Nothing in the address bar, and nothing in the console.
    expect(window.location.href).toBe(before);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(JSON.stringify(window.history.state)).not.toContain(MAINNET);
    expect(consoleCalls).toEqual([]);
  });

  it("loads nothing from anywhere: no picture, frame, script, style, font or media is on the page", () => {
    show();
    paste(MAINNET);
    expect(document.querySelectorAll("img, picture, iframe, frame, object, embed, video, audio, source, track, svg image, use[href^='http']")).toHaveLength(0);
    expect(document.querySelectorAll("script[src], link[href], base, form")).toHaveLength(0);
    expect(document.querySelectorAll("[src], [srcset], [poster], [data], [action], [ping]")).toHaveLength(0);
    // Every link is to a page of this site (or a place on this page, like the skip link), except the one to the wallet.
    const hrefs = Array.from(document.querySelectorAll("a[href]"), (a) => a.getAttribute("href") ?? "");
    for (const href of hrefs) expect(href === ZODL_URL || href.startsWith("/") || href.startsWith("#"), href).toBe(true);
  });

  it("keeps the address in the box and nowhere else on the page", () => {
    show();
    paste(MAINNET);
    expect(field()).toHaveValue(MAINNET);
    // The page without the box: no text, no attribute and no markup holds it.
    const rest = document.body.cloneNode(true) as HTMLElement;
    rest.querySelectorAll("textarea").forEach((box) => {
      box.remove();
    });
    expect(rest.textContent).not.toContain(MAINNET);
    expect(rest.innerHTML).not.toContain(MAINNET);
    for (const element of rest.querySelectorAll("*")) {
      for (const attribute of Array.from(element.attributes)) expect(attribute.value, attribute.name).not.toContain(MAINNET);
    }
  });

  it("is forgotten when the person leaves: the box is empty when they come back", async () => {
    const user = userEvent.setup();
    show();
    paste(MAINNET);
    await user.click(within(await openIsland(user)).getByRole("link", { name: "How privacy works" }));
    expect(await screen.findByRole("heading", { level: 1, name: "How privacy works" })).toBeInTheDocument();
    await user.click(within(await openIsland(user)).getByRole("link", { name: "Get paid" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Get paid in ZEC" })).toBeInTheDocument();
    expect(field()).toHaveValue("");
  });

  // The page and what it reads are plain functions and state. These fail if either starts to reach out, keep
  // something or tell someone, whatever the test above happens to exercise.
  const REACHES_OUT = /\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bnew Image\b|importScripts|navigator\.(serviceWorker|connection)|window\.open|\.open\(/u;
  const KEEPS = /localStorage|sessionStorage|indexedDB|document\.cookie|caches\b|history\.(push|replace)State|useNavigate|navigate\(|location\b|console\.|useQuery|useMutation|queryClient|persist|zustand/u;
  const IMPORTS = /from "@\/api|from "@tanstack|from "zustand|from "\.\.\/\.\.\/api/u;

  it.each([
    ["the page", pageSource],
    ["its wording", wordingSource],
    ["the address check", shapeSource],
  ])("%s calls no server, keeps nothing and logs nothing: nothing in its code does", (_name, source) => {
    const run = code(source);
    expect(run).not.toMatch(REACHES_OUT);
    expect(run).not.toMatch(KEEPS);
    expect(run).not.toMatch(IMPORTS);
  });

  it("the scan itself sees what it is there for", () => {
    for (const bad of ["fetch(url)", "new XMLHttpRequest()", "navigator.sendBeacon(u)", "localStorage.setItem(k, v)", "document.cookie = x", "console.log(a)", "history.pushState(0, '', u)"]) {
      expect(`${code(bad)}`).toMatch(new RegExp(`${REACHES_OUT.source}|${KEEPS.source}`, "u"));
    }
    expect(code("// fetch is not called here\nconst a = 1; /* localStorage */")).not.toMatch(REACHES_OUT);
    expect(code("// localStorage\nconst a = 1; /* console.log */")).not.toMatch(KEEPS);
  });
});
