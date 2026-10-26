// @vitest-environment jsdom
//
// A payslip as a link and a QR code, and a page opened from one (openspec REQ-PAY-004): the payslip is in an address only
// after the "#", is read once and taken out of the address bar at once, is never checked until the person asks, and
// appears nowhere else than the body of the check they asked for.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { BrowserRouter, MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { PAYSLIP_NOT_PROVEN } from "@/api/payslip-answer";
import { payslipBody, payslipText, type Payslip } from "@/api/payslip-input";
import { payslipLink } from "@/api/payslip-link";
import { samplePayslip } from "@/api/payslip-sample";
import { decodeQrSvg, readEccLevel, readQrSvg } from "@/test/qr";
import { AppRoutes } from "@/routes";

import sendSource from "./SendPayslip.tsx?raw";
import linkSource from "../../api/payslip-link.ts?raw";
import qrSource from "../../components/QrCode.tsx?raw";
import { LINK_FEEDBACK, LINK_NOTICE, LINK_PROBLEM, LINK_WARNING, LOOPBACK_NOTE, QR_CAPTION, SHARE_TEXT } from "./wording";

// ---- Harness ---------------------------------------------------------------

const sample = samplePayslip();
/** Where a page opened in these tests is: jsdom's own address. Loopback, so the link says it points here. */
const ORIGIN = window.location.origin;
const LINK = payslipLink(sample, ORIGIN);
const FRAGMENT = LINK.slice(LINK.indexOf("#"));

const answer = (slip: Payslip) => ({
  network: slip.network,
  txid: slip.txid,
  action: slip.action,
  verdict: "verified",
  reason: null,
  confirmations: 19,
  required_depth: 3,
  ironwood_actions: 8,
  not_proven: [...PAYSLIP_NOT_PROVEN],
});

/** A verifier that says "verified" to whatever it is asked. */
function verifier() {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    if (typeof init.body !== "string") throw new Error("expected the body to be text");
    const slip = JSON.parse(init.body) as Payslip;
    return Promise.resolve(new Response(JSON.stringify(answer(slip)), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Shows where the router thinks the page is, so a test can see the fragment go. */
function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{`${pathname}${search}${hash}`}</p>;
}

/** A button that goes to an address, as a link followed (or an address typed into the tab) does. */
function GoTo({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        void navigate(to);
      }}
    >
      {label}
    </button>
  );
}

function openAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <GoTo to={`/payslip${FRAGMENT}`} label="go to the link" />
        <GoTo to="/payslip#payslip=%%%" label="go to a bad link" />
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const field = () => screen.getByLabelText("Payslip");
const where = () => screen.getByTestId("where").textContent;
const paste = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
};
const press = async (name: string) => {
  await userEvent.setup().click(screen.getByRole("button", { name }));
};

function withShare(impl: (data?: ShareData) => Promise<void>) {
  const share = vi.fn(impl);
  Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
  return share;
}

beforeEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "sendBeacon");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

// ---- Making a link ------------------------------------------------------------

describe("making a link", () => {
  it("is offered for a payslip in the box, and for nothing else", () => {
    openAt("/payslip");
    expect(screen.queryByRole("button", { name: "Make a link" })).toBeNull();
    paste("not a payslip");
    expect(screen.queryByRole("button", { name: "Make a link" })).toBeNull();
    paste(payslipText(sample));
    expect(screen.getByRole("button", { name: "Make a link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show QR code" })).toBeInTheDocument();
    paste("");
    expect(screen.queryByRole("button", { name: "Show QR code" })).toBeNull();
  });

  it("offers Share too, where the phone has a share sheet", () => {
    withShare(() => Promise.resolve());
    openAt("/payslip");
    paste(payslipText(sample));
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("has no Share where there is no share sheet", () => {
    openAt("/payslip");
    paste(payslipText(sample));
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("says what a link holds, to whom to send it, and that anyone who has it can present the payslip, with the buttons", () => {
    openAt("/payslip");
    paste(payslipText(sample));
    const section = screen.getByRole("heading", { level: 2, name: "Send this payslip" }).closest("section") as HTMLElement;
    expect(LINK_WARNING).toBe(
      "This link holds the whole payslip. Anyone who gets it can read its amount, its receiver and the key to its memo, and can present it as their own. Send it only to the person you want to prove the payment to.",
    );
    expect(within(section).getByRole("note")).toHaveTextContent(LINK_WARNING);
    expect(within(section).getByRole("button", { name: "Make a link" })).toBeInTheDocument();
  });

  it("has no link anywhere in the page until one is asked for", () => {
    openAt("/payslip");
    paste(payslipText(sample));
    expect(document.body.innerHTML).not.toContain("#payslip=");
    expect(document.body.innerHTML).not.toContain(FRAGMENT.slice("#payslip=".length, "#payslip=".length + 30));
    expect(screen.queryByLabelText("Payslip link")).toBeNull();
    expect(screen.queryByTestId("payslip-qr")).toBeNull();
  });

  it("shows the link when asked: the page's address, then # and the payslip, in a box to copy from", async () => {
    openAt("/payslip");
    paste(payslipText(sample));
    await press("Make a link");
    const box = screen.getByLabelText("Payslip link");
    expect(box).toHaveValue(LINK);
    expect(box).toHaveAttribute("readonly");
    expect(box).toHaveAttribute("spellcheck", "false");
    expect(screen.getByRole("button", { name: "Hide the link" })).toHaveAttribute("aria-expanded", "true");
    // The part before the # holds nothing of the payslip.
    const sent = (box as HTMLTextAreaElement).value.split("#")[0] ?? "";
    for (const secret of [sample.receiver, sample.rseed, sample.txid]) expect(sent).not.toContain(secret);
  });

  it("says where it points when this page is open on the computer itself", () => {
    openAt("/payslip");
    paste(payslipText(sample));
    expect(screen.getByText(LOOPBACK_NOTE)).toBeInTheDocument();
    expect(new URL(ORIGIN).hostname).toBe("localhost");
  });

  it("copies the link, and says so", async () => {
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Make a link" }));
    await user.click(screen.getByRole("button", { name: "Copy payslip link" }));
    expect(await navigator.clipboard.readText()).toBe(LINK);
    expect(screen.getByText("Copied to clipboard")).toBeInTheDocument();
  });

  it("hides the link again, and drops it with the payslip when the text changes", async () => {
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Make a link" }));
    await user.click(screen.getByRole("button", { name: "Hide the link" }));
    expect(screen.queryByLabelText("Payslip link")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Make a link" }));
    await user.click(screen.getByRole("button", { name: "Show QR code" }));
    paste(`${payslipText(sample)} `);
    expect(screen.queryByLabelText("Payslip link")).toBeNull();
    expect(screen.queryByTestId("payslip-qr")).toBeNull();
    expect(screen.getByRole("button", { name: "Make a link" })).toHaveAttribute("aria-expanded", "false");
  });

  it("makes a link for another payslip when the box holds another, and not for the one before", async () => {
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Make a link" }));
    const other: Payslip = { ...sample, value: "90001" };
    paste(payslipText(other));
    await user.click(screen.getByRole("button", { name: "Make a link" }));
    expect(screen.getByLabelText("Payslip link")).toHaveValue(payslipLink(other, ORIGIN));
  });
});

// ---- The QR code -----------------------------------------------------------------

describe("the QR code of a link", () => {
  it("holds the link, character for character, as an independent decoder reads it, at the lowest level that scans", async () => {
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Show QR code" }));
    const svg = await within(screen.getByTestId("payslip-qr")).findByRole("img", { name: "QR code of the payslip link" });
    const read = decodeQrSvg(svg);
    expect(read?.text).toBe(LINK);
    // About 480 characters, as a link is: version 15 at level L. Higher levels would make it denser, and no easier to scan from a screen.
    expect(readEccLevel(readQrSvg(svg))).toBe("L");
    expect(read?.version).toBeLessThanOrEqual(16);
    expect(readQrSvg(svg).quietZone).toBe(4);
  });

  it("holds the link of the biggest payslip there can be, and of a mainnet one", async () => {
    const user = userEvent.setup();
    const biggest: Payslip = { ...sample, network: "mainnet", action: 4_294_967_295, value: "2100000000000000" };
    for (const payslip of [biggest, { ...sample, network: "mainnet" as const }]) {
      const view = openAt("/payslip");
      paste(payslipText(payslip));
      await user.click(screen.getByRole("button", { name: "Show QR code" }));
      const svg = await within(screen.getByTestId("payslip-qr")).findByRole("img");
      expect(decodeQrSvg(svg)?.text).toBe(payslipLink(payslip, ORIGIN));
      view.unmount();
    }
  });

  it("says what it is, who to show it to, and is large: the figure takes the width of a phone, up to 26rem", async () => {
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Show QR code" }));
    const figure = screen.getByTestId("payslip-qr");
    expect(within(figure).getByText(QR_CAPTION)).toBeInTheDocument();
    expect(figure.className).toMatch(/\bw-full\b/u);
    expect(figure.className).toMatch(/max-w-\[26rem\]/u);
    expect(screen.getByRole("button", { name: "Hide QR code" })).toHaveAttribute("aria-controls", figure.id);
  });

  it("can be hidden, and does not need the link to be shown", async () => {
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Show QR code" }));
    expect(screen.queryByLabelText("Payslip link")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Hide QR code" }));
    expect(screen.queryByTestId("payslip-qr")).toBeNull();
  });
});

// ---- Share ------------------------------------------------------------------------

describe("Share", () => {
  it("gives the share sheet the link and one line, and nothing else", async () => {
    const share = withShare(() => Promise.resolve());
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ text: SHARE_TEXT, url: LINK });
    expect(Object.keys(share.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["text", "url"]);
    expect(screen.getByTestId("link-feedback")).toBeEmptyDOMElement();
  });

  it("says nothing when the person closes the share sheet", async () => {
    withShare(() => Promise.reject(new DOMException("Share canceled", "AbortError")));
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByTestId("link-feedback")).toBeEmptyDOMElement();
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    ["a NotAllowedError", () => new DOMException("not allowed", "NotAllowedError")],
    ["a TypeError", () => new TypeError("bad data")],
  ])("copies the link instead after %s, and says so", async (_label, error) => {
    withShare(() => Promise.reject(error()));
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => {
      expect(screen.getByTestId("link-feedback")).toHaveTextContent(LINK_FEEDBACK.fallback_copied);
    });
    expect(await navigator.clipboard.readText()).toBe(LINK);
  });

  it("says it could not copy when there is no clipboard either", async () => {
    withShare(() => Promise.reject(new Error("no")));
    const user = userEvent.setup();
    openAt("/payslip");
    paste(payslipText(sample));
    Reflect.deleteProperty(navigator, "clipboard");
    await user.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => {
      expect(screen.getByTestId("link-feedback")).toHaveTextContent(LINK_FEEDBACK.copy_failed);
    });
  });
});

// ---- Opening a link ------------------------------------------------------------------

describe("a page opened from a link", () => {
  it("puts the payslip in the box, as a file has it, and says whoever has the link has the payslip", () => {
    const fetchMock = verifier();
    openAt(`/payslip${FRAGMENT}`);
    expect(field()).toHaveValue(payslipText(sample));
    expect(screen.getByText(LINK_NOTICE).closest("[role='note']")).not.toBeNull();
    expect(LINK_NOTICE).toBe("This payslip came from a link. Whoever has that link has the payslip: its receiver, its amount and the key to its memo.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes the fragment out of the address at once, and keeps the path", () => {
    verifier();
    openAt(`/payslip${FRAGMENT}`);
    expect(where()).toBe("/payslip");
  });

  it("checks nothing until the person asks: no request, no result, and the button is still there", async () => {
    const fetchMock = verifier();
    openAt(`/payslip${FRAGMENT}`);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("payslip-result")).toBeNull();
    expect(screen.queryByTestId("payslip-outcome")?.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Check payslip" })).toBeEnabled();
  });

  it("checks it when asked: one request, with the payslip as its body", async () => {
    const fetchMock = verifier();
    openAt(`/payslip${FRAGMENT}`);
    await press("Check payslip");
    expect(await screen.findByRole("heading", { level: 2, name: "Verified" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toBe(payslipBody(sample));
    for (const secret of [sample.receiver, sample.rseed]) expect(String(url)).not.toContain(secret);
  });

  it("offers a link and a QR code of the payslip it opened, as any payslip in the box", async () => {
    openAt(`/payslip${FRAGMENT}`);
    await press("Make a link");
    expect(screen.getByLabelText("Payslip link")).toHaveValue(LINK);
  });

  it("forgets that it came from a link as soon as the box is changed", () => {
    openAt(`/payslip${FRAGMENT}`);
    expect(screen.getByText(LINK_NOTICE)).toBeInTheDocument();
    paste(`${payslipText(sample)} `);
    expect(screen.queryByText(LINK_NOTICE)).toBeNull();
  });

  it("forgets it too when the box is cleared", async () => {
    openAt(`/payslip${FRAGMENT}`);
    await press("Clear");
    expect(field()).toHaveValue("");
    expect(screen.queryByText(LINK_NOTICE)).toBeNull();
  });

  it("opens the mainnet payslip of a link as it opens a testnet one", () => {
    const mainnet: Payslip = { ...sample, network: "mainnet" };
    openAt(`/payslip${payslipLink(mainnet, ORIGIN).slice(payslipLink(mainnet, ORIGIN).indexOf("#"))}`);
    expect(field()).toHaveValue(payslipText(mainnet));
  });
});

describe("a link opened while the page is already open", () => {
  it("loads its payslip as a link opened afresh does, and takes the fragment out of the address", async () => {
    const fetchMock = verifier();
    openAt("/payslip");
    expect(field()).toHaveValue("");
    await press("go to the link");
    expect(field()).toHaveValue(payslipText(sample));
    expect(screen.getByText(LINK_NOTICE)).toBeInTheDocument();
    await waitFor(() => {
      expect(where()).toBe("/payslip");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces what was in the box, and drops a check that was running and the result of one that was done", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init.signal as AbortSignal;
            signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );
    openAt("/payslip");
    paste(payslipText({ ...sample, value: "1" }));
    await press("Check payslip");
    expect(screen.getByText("Checking the payslip against the chain…")).toBeInTheDocument();
    await press("go to the link");
    expect(signal?.aborted).toBe(true);
    expect(field()).toHaveValue(payslipText(sample));
    expect(screen.queryByText("Checking the payslip against the chain…")).toBeNull();
    expect(screen.queryByTestId("payslip-result")).toBeNull();
  });

  it("loads again when the same link is opened again, after the box was changed", async () => {
    openAt("/payslip");
    await press("go to the link");
    await waitFor(() => {
      expect(where()).toBe("/payslip");
    });
    paste("something else");
    expect(screen.queryByText(LINK_NOTICE)).toBeNull();
    await press("go to the link");
    expect(field()).toHaveValue(payslipText(sample));
    expect(screen.getByText(LINK_NOTICE)).toBeInTheDocument();
  });

  it("says so for a link that holds no payslip, and the address is bare", async () => {
    openAt("/payslip");
    await press("go to a bad link");
    expect(screen.getByRole("alert")).toHaveTextContent(LINK_PROBLEM);
    expect(field()).toHaveValue("");
    await waitFor(() => {
      expect(where()).toBe("/payslip");
    });
  });

  it("is the same in a browser: a change of the fragment alone, as when a link is pasted into the address bar of this tab", async () => {
    verifier();
    window.history.replaceState(null, "", "/payslip");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    expect(field()).toHaveValue("");
    // What a browser does for an address that differs from the one it is on by its fragment alone: no load, the address
    // changes, and the page hears of it as a popstate.
    window.history.pushState(null, "", `/payslip${FRAGMENT}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => {
      expect(field()).toHaveValue(payslipText(sample));
    });
    expect(screen.getByText(LINK_NOTICE)).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
    expect(window.location.href).toBe(`${ORIGIN}/payslip`);
  });
});

describe("a link that holds no payslip", () => {
  const goodValue = FRAGMENT.slice("#payslip=".length);
  const b64 = (text: string) => btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

  it.each([
    ["no value", "#payslip="],
    ["no equals sign", "#payslip"],
    ["a value that is not base64url", "#payslip=not base64!"],
    ["standard base64 with padding", `#payslip=${btoa(payslipBody(sample))}==`],
    ["a cut-off value", `#payslip=${goodValue.slice(0, 100)}`],
    ["text that is not a payslip", `#payslip=${b64("hello there")}`],
    ["a payslip with a field too many", `#payslip=${b64(JSON.stringify({ ...sample, memo: "x" }))}`],
    ["a value that is far too long", `#payslip=${"A".repeat(5000)}`],
  ])("says so, loads nothing, and takes the fragment out too: %s", (_label, hash) => {
    const fetchMock = verifier();
    openAt(`/payslip${hash}`);
    expect(screen.getByRole("alert")).toHaveTextContent(LINK_PROBLEM);
    expect(LINK_PROBLEM).toBe("This link does not hold a payslip this page can read. Nothing was loaded.");
    expect(field()).toHaveValue("");
    expect(screen.queryByText(LINK_NOTICE)).toBeNull();
    expect(where()).toBe("/payslip");
    expect(fetchMock).not.toHaveBeenCalled();
    // And it does not repeat what the link said.
    if (hash.length > 12) expect(screen.getByRole("alert").textContent).not.toContain(hash.slice(9, 40));
  });

  it("goes when the person types, as any message about the box does", () => {
    openAt("/payslip#payslip=");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    paste("x");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("an address that is not a payslip link", () => {
  it.each(["/payslip", "/payslip#main", "/payslip#top", "/payslip#payslips", "/payslip#PAYSLIP=abc"])("%s is left exactly as it is, with nothing said", (path) => {
    openAt(path);
    expect(where()).toBe(path);
    expect(field()).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(LINK_NOTICE)).toBeNull();
  });

  it("is also left alone on other pages: a payslip fragment on another page is no business of this one", () => {
    openAt(`/privacy${FRAGMENT}`);
    expect(where()).toBe(`/privacy${FRAGMENT}`);
  });
});

// ---- The promise: nothing leaves, nothing is kept -----------------------------------------

// covers: REQ-PAY-004
describe("what a payslip link does with a payslip", () => {
  const paths = ["/payslip", "/payslip#payslip=%%%", `/payslip#payslip=${FRAGMENT.slice(9, 200)}`];

  /** Every way the page could tell someone, or keep, what it was opened with, watched. */
  function watching() {
    const fetchMock = verifier();
    const open = vi.spyOn(XMLHttpRequest.prototype, "open");
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    const image = vi.fn();
    vi.stubGlobal("Image", image);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrites = vi.spyOn(document, "cookie", "set");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const calls: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(`${method}: ${args.map(String).join(" ")}`);
      });
    }
    return { fetchMock, open, beacon, socket, image, setItem, cookieWrites, pushState, replaceState, console: calls };
  }

  const openInBrowser = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>,
    );

  it("takes the payslip out of the address bar, the history and the page's state before anything else, and asks no one", () => {
    window.history.replaceState(null, "", `/payslip${FRAGMENT}`);
    const entries = window.history.length;
    const seen = watching();
    seen.replaceState.mockClear();
    openInBrowser();

    // The address bar: the path, no fragment, and not one character of the payslip. No new history entry: the old one was replaced.
    expect(window.location.hash).toBe("");
    expect(window.location.href).toBe(`${ORIGIN}/payslip`);
    expect(window.history.length).toBe(entries);
    // The router numbers its first entry when it starts (no address in that call). Every other call replaces the entry with the bare path.
    const withAddress = seen.replaceState.mock.calls.filter((call) => call[2] !== undefined && call[2] !== "");
    expect(withAddress.length).toBeGreaterThanOrEqual(1);
    for (const call of withAddress) expect(String(call[2])).toBe("/payslip");
    expect(seen.pushState).not.toHaveBeenCalled();
    for (const secret of [sample.receiver, sample.rseed, FRAGMENT.slice(9, 60)]) {
      expect(window.location.href).not.toContain(secret);
      expect(JSON.stringify(window.history.state)).not.toContain(secret);
    }
    // It was read: the box holds the payslip, and nothing was asked of anyone.
    expect(field()).toHaveValue(payslipText(sample));
    expect(seen.fetchMock).not.toHaveBeenCalled();
    expect(seen.open).not.toHaveBeenCalled();
    expect(seen.beacon).not.toHaveBeenCalled();
    expect(seen.socket).not.toHaveBeenCalled();
    expect(seen.image).not.toHaveBeenCalled();
  });

  it("has taken it out before the page is drawn: by the first layout, and before any effect, the address bar is bare", () => {
    window.history.replaceState(null, "", `/payslip${FRAGMENT}`);
    const seen: string[] = [];
    // Placed after the page, so its layout effect runs after the page's and before anything that runs later.
    function AddressAtLayoutTime() {
      useLayoutEffect(() => {
        seen.push(window.location.hash);
      }, []);
      return null;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BrowserRouter>
          <AppRoutes />
          <AddressAtLayoutTime />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    expect(seen).toEqual([""]);
  });

  it("then sends it once, in the body of the check the person asked for, and in no address, header or option", async () => {
    window.history.replaceState(null, "", `/payslip${FRAGMENT}`);
    const seen = watching();
    openInBrowser();
    await press("Check payslip");
    expect(await screen.findByRole("heading", { level: 2, name: "Verified" })).toBeInTheDocument();

    expect(seen.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = seen.fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toBe(payslipBody(sample));
    const carriers = JSON.stringify({ url, ...init, body: undefined, signal: undefined });
    for (const secret of [sample.receiver, sample.rseed, sample.txid, FRAGMENT.slice(9, 60)]) expect(carriers).not.toContain(secret);
    expect(String(url)).not.toMatch(/[?#]/u);
    expect(new Headers(init?.headers).has("referer")).toBe(false);
    expect(init?.referrerPolicy).toBe("no-referrer");
    expect(init?.credentials).toBe("omit");
    // Nothing kept, nothing said, the address still bare.
    expect(seen.setItem).not.toHaveBeenCalled();
    expect(seen.cookieWrites).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(seen.console).toEqual([]);
    expect(window.location.href).toBe(`${ORIGIN}/payslip`);
    expect(seen.pushState).not.toHaveBeenCalled();
  });

  it("makes a link and a QR code without a request, a write, a log line or a change to the address bar", async () => {
    window.history.replaceState(null, "", `/payslip${FRAGMENT}`);
    const seen = watching();
    withShare(() => Promise.resolve());
    openInBrowser();
    seen.replaceState.mockClear();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Make a link" }));
    await user.click(screen.getByRole("button", { name: "Show QR code" }));
    await within(screen.getByTestId("payslip-qr")).findByRole("img");
    await user.click(screen.getByRole("button", { name: "Copy payslip link" }));
    await user.click(screen.getByRole("button", { name: "Share" }));

    expect(seen.fetchMock).not.toHaveBeenCalled();
    expect(seen.open).not.toHaveBeenCalled();
    expect(seen.beacon).not.toHaveBeenCalled();
    expect(seen.setItem).not.toHaveBeenCalled();
    expect(seen.cookieWrites).not.toHaveBeenCalled();
    expect(seen.replaceState).not.toHaveBeenCalled();
    expect(seen.pushState).not.toHaveBeenCalled();
    expect(seen.console).toEqual([]);
    // The link is on the page, because it was asked for: in its box and nowhere else.
    expect(screen.getByLabelText("Payslip link")).toHaveValue(LINK);
    expect(window.location.href).toBe(`${ORIGIN}/payslip`);
  });

  it.each(paths.slice(1))("takes a fragment that holds no payslip out of the address bar as well: %s", (path) => {
    window.history.replaceState(null, "", path);
    const seen = watching();
    openInBrowser();
    expect(window.location.href).toBe(`${ORIGIN}/payslip`);
    expect(window.location.hash).toBe("");
    expect(seen.fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(field()).toHaveValue("");
  });

  it("leaves a fragment that is not a payslip link where it is", () => {
    window.history.replaceState(null, "", "/payslip#main");
    const seen = watching();
    seen.replaceState.mockClear();
    openInBrowser();
    expect(window.location.hash).toBe("#main");
    // The router numbers its first entry when it starts; nothing replaces the address.
    expect(seen.replaceState.mock.calls.filter((call) => call[2] !== undefined && call[2] !== "")).toEqual([]);
  });

  // The code that makes, reads and shows a link is plain: it reaches no server, keeps nothing and says nothing, whatever the
  // tests above happen to exercise.
  const REACHES_OUT = /\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bnew Image\b|importScripts|window\.open/u;
  const KEEPS = /localStorage|sessionStorage|indexedDB|document\.cookie|caches\b|history\.(push|replace)State|console\./u;
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");

  it.each([
    ["the link and its reader", linkSource],
    ["the buttons that make and show one", sendSource],
    ["the QR code", qrSource],
  ])("%s calls no server, keeps nothing and logs nothing", (_name, source) => {
    expect(code(source)).not.toMatch(REACHES_OUT);
    expect(code(source)).not.toMatch(KEEPS);
  });
});
