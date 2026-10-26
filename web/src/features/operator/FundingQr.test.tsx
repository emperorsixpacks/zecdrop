// @vitest-environment jsdom
//
// The QR code beside a campaign's funding address (openspec REQ-FUND-003): what it holds, when it is there and when it
// is not. What it holds is read back from the SVG the page drew with a decoder that is not the one that made it.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { FIXTURE_CAMPAIGN_ID, installFakeOperator, replyWith, replyWithGolden, type RouteHandler } from "@/test/fake-operator";
import { goldenJson } from "@/test/operator-fixtures";
import { decodeQrSvg, readEccLevel, readQrSvg } from "@/test/qr";
import { renderApp } from "@/test/render-app";

import { fundingPaymentUri } from "@/lib/payment-uri";

type Json = Record<string, unknown>;

const PATH = `/campaign/${FIXTURE_CAMPAIGN_ID}`;
const realHealth: RouteHandler = () => replyWithGolden("health-real.json");
const mockHealth: RouteHandler = () => replyWith("health.json");

// A real mainnet transparent address (the hosted stub's funding address), and the testnet one of the real sample batch.
const MAINNET_ADDRESS = "t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L";
const TESTNET_ADDRESS = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";

/** The real-chain campaign the operator's own Rust test writes, with some fields changed. */
const campaign = (patch: Json = {}): RouteHandler => () => ({ body: { ...(goldenJson("campaign-real-awaiting-deposit.json") as Json), ...patch } });

/** The screen is this wide or not: the one media query the funding panel asks (and the header's, which is not wanted wide). */
function screenIs(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query === "(min-width: 48rem)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

function open(handler: RouteHandler, health: RouteHandler = realHealth) {
  installFakeOperator({ "GET /api/health": health, "GET /api/campaigns/:id": handler });
  return renderApp(PATH, { signedIn: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

/** The figure with the code and its caption, once the page has loaded the campaign. */
const figure = () => screen.findByTestId("funding-qr");
const code = async () => within(await figure()).findByRole("img", { name: /^QR code for this deposit/u });
const walletLink = async () => (await screen.findByRole("link", { name: "Open in wallet" })).getAttribute("href");

// covers: REQ-FUND-003
describe("the funding QR code asks for exactly the deposit", () => {
  it("on testnet holds the wallet link, character for character: this address and the exact amount", async () => {
    screenIs(true);
    open(campaign());
    const link = await walletLink();
    expect(link).toBe("zcash:tFAKEfundingAddressNotARealAddress0000?amount=4.5002");
    const read = decodeQrSvg(await code());
    expect(read?.text).toBe(link);
    expect(read?.text).toBe(fundingPaymentUri("tFAKEfundingAddressNotARealAddress0000", "450020000"));
  });

  it("on mainnet holds the wallet link too, for a mainnet address, and the page still says to send exactly that", async () => {
    screenIs(true);
    open(campaign({ network: "mainnet", funding_address: MAINNET_ADDRESS }), () => ({
      body: { ...(goldenJson("health-real.json") as Json), network: "mainnet" },
    }));
    const link = await walletLink();
    expect(link).toBe(`zcash:${MAINNET_ADDRESS}?amount=4.5002`);
    expect(decodeQrSvg(await code())?.text).toBe(link);
    expect(await screen.findByText("Send exactly that amount. A surplus comes back as change to an address this operator cannot spend on mainnet.")).toBeInTheDocument();
  });

  it("holds nothing but the address and the amount: no memo, no name, no campaign, no recipient", async () => {
    screenIs(true);
    open(campaign({ name: "A name nobody asked for", funding_address: TESTNET_ADDRESS }));
    const read = decodeQrSvg(await code());
    const url = new URL(read?.text ?? "");
    expect(url.protocol).toBe("zcash:");
    expect(url.pathname).toBe(TESTNET_ADDRESS);
    expect([...url.searchParams.keys()]).toEqual(["amount"]);
    expect(url.searchParams.get("amount")).toBe("4.5002");
    expect(read?.text).not.toMatch(/nobody|c-0000|memo|label|message/iu);
  });

  it.each([
    ["450020000", "4.5002"],
    ["1", "0.00000001"],
    ["100000000", "1"],
    ["2100000000000000", "21000000"],
  ])("holds the amount the campaign needs, %s zatoshi, as %s", async (zatoshi, zec) => {
    screenIs(true);
    open(campaign({ funding_required: zatoshi }));
    expect(decodeQrSvg(await code())?.text).toBe(`zcash:tFAKEfundingAddressNotARealAddress0000?amount=${zec}`);
  });

  it("is made at the error-correction level M, since the request is short, and dark on light with its quiet zone", async () => {
    screenIs(true);
    open(campaign());
    const svg = await code();
    const drawn = readQrSvg(svg);
    expect(readEccLevel(drawn)).toBe("M");
    expect(drawn.quietZone).toBe(4);
    expect(svg.querySelector("rect")).toHaveAttribute("fill", "var(--qr-paper)");
    expect(svg.querySelector("path")).toHaveAttribute("fill", "var(--qr-ink)");
  });

  it("says what to do with it", async () => {
    screenIs(true);
    open(campaign());
    await code();
    expect(within(await figure()).getByText("Scan with a Zcash wallet on your phone: it fills in this address and the exact amount.")).toBeInTheDocument();
  });

  it("sits beside 'Copy funding address' and 'Open in wallet', under the same address", async () => {
    screenIs(true);
    open(campaign());
    await code();
    const address = screen.getByTestId("funding-address");
    const grid = address.closest(".md\\:grid");
    expect(grid).not.toBeNull();
    expect(grid).toContainElement(screen.getByRole("button", { name: "Copy funding address" }));
    expect(grid).toContainElement(screen.getByRole("link", { name: "Open in wallet" }));
    expect(grid).toContainElement(await figure());
  });
});

describe("on a wide screen (768px and over)", () => {
  it("shows the code without being asked, and has no button for it", async () => {
    screenIs(true);
    open(campaign());
    await code();
    expect(screen.queryByRole("button", { name: /QR code/u })).toBeNull();
  });
});

describe("on a narrow screen", () => {
  it("keeps the code behind a 'Show QR code' button, and draws nothing until it is pressed", async () => {
    screenIs(false);
    const user = userEvent.setup();
    open(campaign());
    const button = await screen.findByRole("button", { name: "Show QR code" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-controls");
    expect(screen.queryByTestId("funding-qr")).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/u })).toBeNull();

    await user.click(button);
    expect(decodeQrSvg(await code())?.text).toBe(await walletLink());
    const hide = screen.getByRole("button", { name: "Hide QR code" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    expect(hide).toHaveAttribute("aria-controls", (await figure()).id);

    await user.click(hide);
    expect(screen.queryByTestId("funding-qr")).toBeNull();
    expect(screen.getByRole("button", { name: "Show QR code" })).toHaveAttribute("aria-expanded", "false");
  });

  it("offers copying and the wallet link first: the button is beside them, and they are all still there", async () => {
    screenIs(false);
    open(campaign());
    const show = await screen.findByRole("button", { name: "Show QR code" });
    expect(screen.getByRole("button", { name: "Copy funding address" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in wallet" })).toBeInTheDocument();
    expect(show.parentElement).toContainElement(screen.getByRole("button", { name: "Copy funding address" }));
  });
});

describe("there is no code", () => {
  const nothing = async () => {
    await screen.findByRole("heading", { name: "Is it funded?" });
    expect(screen.queryByTestId("funding-qr")).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /QR code/u })).toBeNull();
  };

  it.each([true, false])("when the campaign needs nothing (zero zatoshi), so that no link can be made (wide: %s)", async (wide) => {
    screenIs(wide);
    open(campaign({ funding_required: "0" }));
    await nothing();
    expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
  });

  it("when the address is not plain letters and digits, so that no link can be made from it", async () => {
    screenIs(true);
    open(campaign({ funding_address: "tm-not-an-address?amount=9&memo=x" }));
    await nothing();
    expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
  });

  it("on the fake chain, where nothing real can be paid", async () => {
    screenIs(true);
    installFakeOperator({ "GET /api/health": mockHealth, "GET /api/campaigns/:id": () => replyWith("campaign-awaiting-funding.json") });
    renderApp(PATH, { signedIn: true });
    await screen.findByRole("heading", { name: "Fake chain: record a pretend deposit" });
    expect(screen.queryByTestId("funding-qr")).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /QR code/u })).toBeNull();
  });

  it("without a funding address", async () => {
    screenIs(true);
    open(campaign({ funding_address: null }));
    expect(await screen.findByText(/has not given a funding address/u)).toBeInTheDocument();
    expect(screen.queryByTestId("funding-qr")).toBeNull();
    expect(screen.queryByRole("button", { name: /QR code/u })).toBeNull();
  });

  it("once the campaign is funded", async () => {
    screenIs(true);
    open(() => replyWithGolden("campaign-real-funded.json"));
    expect(await screen.findByText("Funded.")).toBeInTheDocument();
    expect(screen.queryByTestId("funding-qr")).toBeNull();
  });
});

describe("the code makes no request and keeps nothing", () => {
  it("is drawn in the page: the only requests are the operator's own, and nothing is stored", async () => {
    screenIs(true);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const operator = installFakeOperator({ "GET /api/health": realHealth, "GET /api/campaigns/:id": campaign() });
    renderApp(PATH, { signedIn: true });
    await code();
    expect(operator.calls.map((call) => call.path).filter((path) => !/\/api\/(health|campaigns)/u.test(path))).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    expect(document.querySelectorAll("canvas, img, link[href], script[src]")).toHaveLength(0);
  });
});
