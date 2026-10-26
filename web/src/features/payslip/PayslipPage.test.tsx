// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import "@/test/dom";
import { PAYSLIP_INVALID_REASONS, PAYSLIP_NOT_PROVEN } from "@/api/payslip-answer";
import { PAYSLIP_PROBLEM_TEXT, payslipBody, type Payslip } from "@/api/payslip-input";
import { changedSamplePayslipText, SAMPLE_PAYSLIP_TEXT, samplePayslip } from "@/api/payslip-sample";
import { shortId } from "@/lib/ids";
import { renderApp } from "@/test/render-app";

import { FAILURE_TEXT, INVALID_TEXT } from "./wording";

// ---- Harness ---------------------------------------------------------------

const sample = samplePayslip();

/** The answer the verifier gives for a payslip that checks out, as it writes it. */
const answer = (slip: Payslip, change: Record<string, unknown> = {}) => ({
  network: slip.network,
  txid: slip.txid,
  action: slip.action,
  verdict: "verified",
  reason: null,
  confirmations: 19,
  required_depth: 3,
  ironwood_actions: 8,
  not_proven: [...PAYSLIP_NOT_PROVEN],
  ...change,
});

const invalid = (slip: Payslip, reason = "does_not_match") =>
  answer(slip, { verdict: "invalid", reason, confirmations: null, ironwood_actions: null });

/** The payslip a request carries, which must have been sent as text. */
function slipOf(init: RequestInit): Payslip {
  if (typeof init.body !== "string") throw new Error("expected the body to be text");
  return JSON.parse(init.body) as Payslip;
}

/** What the stand-in verifier says for each verdict. */
const SAYS = {
  verified: (slip: Payslip) => answer(slip),
  pending: (slip: Payslip) => answer(slip, { verdict: "pending", confirmations: 1 }),
  not_found: (slip: Payslip) => answer(slip, { verdict: "not_found", confirmations: null, ironwood_actions: null }),
  invalid: (slip: Payslip) => invalid(slip),
};

/** A stand-in verifier with the sample's one true payslip: it says "verified" for that and "invalid" for any other. */
function verifierOfTheSample() {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const slip = slipOf(init);
    const same = payslipBody(slip) === payslipBody(sample);
    return Promise.resolve(new Response(JSON.stringify(same ? SAYS.verified(slip) : SAYS.invalid(slip)), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A verifier that says the same thing to everything (a fresh Response each time: a body is read once). */
function verifierSays(status: number, body: unknown) {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const value = typeof body === "function" ? (body as (slip: Payslip) => unknown)(slipOf(init)) : body;
    return Promise.resolve(new Response(typeof value === "string" ? value : JSON.stringify(value), { status }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const field = () => screen.getByLabelText("Payslip");
const paste = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
};
const press = async (name: string) => {
  await userEvent.setup().click(screen.getByRole("button", { name }));
};
const outcome = () => screen.getByTestId("payslip-outcome");

function show(path = "/payslip") {
  return renderApp(path);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---- The page before anything is checked ------------------------------------

describe("the page, before anything is checked", () => {
  it("says what a payslip is for and that checking needs no key", async () => {
    show();
    expect(screen.getByRole("heading", { level: 1, name: "Check a payslip" })).toBeInTheDocument();
    expect(screen.getByText(/A payslip is a small file one recipient can show to prove one payout to them, without revealing anyone else's\./u)).toBeInTheDocument();
    expect(screen.getByText(/Checking it needs no viewing key\./u)).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toBe("Check a payslip - ZecDrop");
    });
  });

  it("has the box, the two buttons, and the two helpers", () => {
    show();
    expect(field()).toBeInstanceOf(HTMLTextAreaElement);
    expect(field()).toHaveValue("");
    for (const name of ["Check payslip", "Clear", "Load a sample", "Load a changed copy"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("is in the public menu, and the page is the payslip page there", () => {
    show();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Check a payslip" })).toHaveAttribute("href", "/payslip");
    expect(within(nav).getByRole("link", { name: "Check a payslip" })).toHaveAttribute("aria-current", "page");
  });

  it("shows what a verified payslip does not prove, from the start", () => {
    show();
    expect(screen.getByRole("heading", { level: 2, name: "What this does not prove" })).toBeInTheDocument();
    const items = within(screen.getByTestId("not-proven")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([...PAYSLIP_NOT_PROVEN]);
    expect(items).toHaveLength(5);
  });

  it("makes no request until a payslip is checked", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    show();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- The privacy note --------------------------------------------------------

describe("the privacy note", () => {
  it("says what checking here shares, who can see it, and how to check without sharing it", () => {
    show();
    const note = screen.getByRole("note");
    expect(within(note).getByText("Checking here shares the payslip")).toBeInTheDocument();
    const text = note.textContent ?? "";
    expect(text).toContain("The check sends the payslip to the verifier: its receiver, its amount and the secret that also opens its memo.");
    expect(text).toContain("does not log or keep it, but whoever runs the verifier can see it");
    expect(text).toContain("drop-operator verify-payslip --payslip FILE --tx FILE");
    expect(text).toContain("on your own computer. It works offline.");
  });

  it("comes before the button, after the box, with nothing to press in between", () => {
    show();
    const note = screen.getByRole("note");
    const button = screen.getByRole("button", { name: "Check payslip" });
    expect(field().compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing focusable sits between the note and the button.
    expect(note.querySelectorAll("a, button, input, textarea, select, [tabindex]")).toHaveLength(0);
    expect(note.nextElementSibling).toBe(button.parentElement);
  });

  it("is a note and not a live region, so it is not read out again each time", () => {
    show();
    const note = screen.getByRole("note");
    expect(note).not.toHaveAttribute("aria-live");
    expect(screen.queryByRole("status", { name: /shares/u })).toBeNull();
  });
});

// ---- The two helpers ----------------------------------------------------------

describe("the sample", () => {
  it("is loaded into the box as the file holds it, and said to be the real testnet batch's", async () => {
    show();
    await press("Load a sample");
    expect(field()).toHaveValue(SAMPLE_PAYSLIP_TEXT);
    expect(screen.getByText(/The sample is payslip 3 of the real 8-person payout that ran on public testnet\./u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "receipt" })).toHaveAttribute("href", SAMPLE_RECEIPT_HREF);
  });

  it("has a changed copy with the amount one zatoshi higher, and says so", async () => {
    show();
    await press("Load a changed copy");
    expect(field()).toHaveValue(changedSamplePayslipText());
    expect(JSON.parse((field() as HTMLTextAreaElement).value)).toEqual({ ...sample, value: "90001" });
    expect(screen.getByText(/The changed copy asks for 0\.00000001 TAZ more, so you can watch the check fail\./u)).toBeInTheDocument();
  });

  it("replaces what was in the box, and clears a result that belonged to the old text", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Verified" });
    await press("Load a changed copy");
    expect(screen.queryByRole("heading", { level: 2, name: "Verified" })).toBeNull();
    expect(outcome()).toBeEmptyDOMElement();
  });
});

// ---- A bad paste ----------------------------------------------------------------

describe("a paste that is not a payslip", () => {
  const cases: [label: string, text: string, problem: keyof typeof PAYSLIP_PROBLEM_TEXT][] = [
    ["nothing", "", "empty"],
    ["words", "here is my payslip", "not_json"],
    ["a payslip with a field too many", JSON.stringify({ ...sample, memo: "hi" }), "unknown_field"],
    ["a payslip with the amount in capitals", JSON.stringify({ ...sample, receiver: sample.receiver.toUpperCase() }), "bad_receiver"],
    ["a viewing key", "uview1qqqqqqqqqqqqqqqqqqqq", "viewing_key"],
  ];

  it.each(cases)("%s: says so in plain words, and sends nothing", async (_label, text, problem) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    show();
    paste(text);
    await press("Check payslip");

    const message = screen.getByRole("alert");
    expect(message).toHaveTextContent(PAYSLIP_PROBLEM_TEXT[problem]);
    expect(fetchMock).not.toHaveBeenCalled();
    // The box says it is in the wrong, and what is wrong, and has the focus again.
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(field().getAttribute("aria-describedby")).toContain(message.id);
    expect(field()).toHaveFocus();
    // The message never repeats what was pasted.
    if (text !== "") expect(message.textContent).not.toContain(text);
  });

  it("is forgotten as soon as the text changes", async () => {
    show();
    paste("nope");
    await press("Check payslip");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    paste("still nope");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field()).toHaveAttribute("aria-invalid", "false");
  });
});

// ---- The verdicts -----------------------------------------------------------------

describe("checking the sample", () => {
  it("sends the payslip as the one body of one POST, and shows Verified", async () => {
    const fetchMock = verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");

    const heading = await screen.findByRole("heading", { level: 2, name: "Verified" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/payslip");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(payslipBody(sample));

    // The result says what the output of that action does, and nothing more.
    const result = screen.getByTestId("payslip-result");
    expect(result).toHaveAttribute("data-verdict", "verified");
    expect(within(result).getByText("Action 5 of this transaction pays the receiver and amount this payslip states.")).toBeInTheDocument();
    expect(within(result).getByText("It proves that one output, and nothing about any other.")).toBeInTheDocument();
    expect(heading).toHaveFocus();
  });

  it("shows the amount in the testnet coin and a short receiver, as what the payslip states", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    const result = await screen.findByTestId("payslip-result");

    const amount = within(result).getByText("Amount the payslip states").closest("div");
    expect(amount).toHaveTextContent("0.0009 TAZ");
    expect(within(result).getByText("0.0009 TAZ")).toHaveAttribute("title", "90000 zatoshi");
    const receiver = within(result).getByText("Receiver the payslip states").closest("div");
    expect(receiver).toHaveTextContent(shortId(sample.receiver));
    // Never the whole receiver, and never the secret.
    expect(result.textContent).not.toContain(sample.receiver);
    expect(result.textContent).not.toContain(sample.rseed);
    expect(within(result).getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeInTheDocument();
  });

  it("shows the confirmations and the depth, and a link to the transaction on the network's explorer", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    const result = await screen.findByTestId("payslip-result");

    expect(within(result).getByText("Confirmations").closest("div")).toHaveTextContent("19 (final at 3)");
    expect(within(result).getByText("Action").closest("div")).toHaveTextContent("5 (of 8, counting from 0)");
    const link = within(result).getByRole("link", { name: /Open in the explorer/u });
    expect(link).toHaveAttribute("href", `https://testnet.zecblock.com/tx/${sample.txid}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("(opens in a new tab)");
    expect(within(result).getByText(`${sample.txid.slice(0, 8)}…${sample.txid.slice(-8)}`)).toHaveAttribute("title", sample.txid);
  });

  it("shows the failure of the changed copy: not verified, and not which part was wrong", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Verified" });

    await press("Load a changed copy");
    await press("Check payslip");
    const heading = await screen.findByRole("heading", { level: 2, name: "Not verified" });
    const result = screen.getByTestId("payslip-result");
    expect(result).toHaveAttribute("data-verdict", "invalid");
    expect(within(result).getByText(INVALID_TEXT.does_not_match)).toBeInTheDocument();
    expect(heading).toHaveFocus();
    // The old "Verified" is gone, and nothing says which field was wrong or shows what the payslip states.
    expect(screen.queryByRole("heading", { name: "Verified" })).toBeNull();
    expect(result.textContent).not.toMatch(/receiver|amount|secret|rseed|value/iu);
    expect(within(result).queryByText("Amount the payslip states")).toBeNull();
    expect(within(result).getByRole("link", { name: /Open in the explorer/u })).toBeInTheDocument();
  });
});

describe.each([
  ["pending", SAYS.pending, "Matches, not final yet", "But the transaction has 1 of the 3 confirmations the verifier waits for. Check again in a few minutes."],
  ["not found", SAYS.not_found, "Transaction not found", "This verifier cannot find that transaction on testnet."],
] as const)("a payslip the verifier calls %s", (_name, body, heading, sentence) => {
  it(`shows "${heading}" and says what it means`, async () => {
    verifierSays(200, body);
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    expect(await screen.findByRole("heading", { level: 2, name: heading })).toHaveFocus();
    expect(within(screen.getByTestId("payslip-result")).getByText(sentence)).toBeInTheDocument();
  });
});

describe("a payslip the verifier calls pending", () => {
  it("still says what the output does, and what the payslip states, but does not call it verified", async () => {
    verifierSays(200, SAYS.pending);
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    const result = await screen.findByTestId("payslip-result");
    expect(within(result).getByText("Action 5 of this transaction pays the receiver and amount this payslip states.")).toBeInTheDocument();
    expect(within(result).getByText("Confirmations").closest("div")).toHaveTextContent("1 (final at 3)");
    expect(within(result).getByText("Amount the payslip states").closest("div")).toHaveTextContent("0.0009 TAZ");
    expect(screen.queryByRole("heading", { name: "Verified" })).toBeNull();
    expect(result.textContent).not.toMatch(/\bVerified\b/u);
  });
});

describe("a payslip the verifier calls invalid", () => {
  it.each(PAYSLIP_INVALID_REASONS)("says one plain sentence for the reason %s, and never which field was wrong", async (reason) => {
    verifierSays(200, (slip: Payslip) => invalid(slip, reason));
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    const result = await screen.findByTestId("payslip-result");
    expect(within(result).getByRole("heading", { level: 2, name: "Not verified" })).toHaveFocus();
    expect(within(result).getByText(INVALID_TEXT[reason])).toBeInTheDocument();
    expect(result.textContent).not.toMatch(/receiver|amount|secret|rseed|value|field/iu);
  });
});

describe("a mainnet payslip", () => {
  it("is shown in ZEC, with no word about a testnet coin, and linked to the mainnet explorer", async () => {
    verifierSays(200, SAYS.verified);
    show();
    paste(JSON.stringify({ ...sample, network: "mainnet" }));
    await press("Check payslip");
    const result = await screen.findByTestId("payslip-result");
    expect(within(result).getByText("Amount the payslip states").closest("div")).toHaveTextContent("0.0009 ZEC");
    expect(result.textContent).not.toMatch(/TAZ|testnet/u);
    expect(within(result).getByRole("link", { name: /Open in the explorer/u })).toHaveAttribute(
      "href",
      `https://mainnet.zcashexplorer.app/transactions/${sample.txid}`,
    );
  });
});

describe("what a payslip does not prove, once the verifier has answered", () => {
  it("is the verifier's own list, shown in place of the built-in one", async () => {
    const theirs = ["First thing the verifier says.", "Second thing, <b>as text</b>."];
    verifierSays(200, (slip: Payslip) => answer(slip, { not_proven: theirs }));
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    await screen.findByTestId("payslip-result");
    const items = within(screen.getByTestId("not-proven")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(theirs);
    expect(screen.getByTestId("not-proven").querySelector("b")).toBeNull();
  });

  it.each(["verified", "pending", "not_found", "invalid"] as const)("is on the page with the verdict %s", async (verdict) => {
    verifierSays(200, SAYS[verdict]);
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    await screen.findByTestId("payslip-result");
    expect(screen.getByRole("heading", { level: 2, name: "What this does not prove" })).toBeInTheDocument();
    expect(within(screen.getByTestId("not-proven")).getAllByRole("listitem")).toHaveLength(5);
  });

  it("is still the built-in list when there is no answer", async () => {
    verifierSays(503, { error: { code: "chain_unavailable", message: "x" } });
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    await screen.findByTestId("payslip-failure");
    const items = within(screen.getByTestId("not-proven")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([...PAYSLIP_NOT_PROVEN]);
  });
});

// ---- When there is no answer --------------------------------------------------------

describe("a check that gets no answer", () => {
  const refusal = (code: string) => ({ error: { code, message: "words the page must not show" } });
  const cases: [kind: keyof typeof FAILURE_TEXT, status: number, body: unknown][] = [
    ["unreachable", 503, refusal("overloaded")],
    ["unreachable", 404, ""],
    ["rejected", 400, refusal("invalid_payslip")],
    ["network_not_served", 400, refusal("network_not_configured")],
    ["too_large", 413, refusal("payload_too_large")],
    ["chain_unavailable", 503, refusal("chain_unavailable")],
    ["chain_unavailable", 502, refusal("chain_inconsistent")],
    ["invalid_response", 200, { not: "an answer" }],
  ];

  it.each(cases)("%s (HTTP %i): says what happened, takes the focus, and shows no verdict", async (kind, status, body) => {
    verifierSays(status, body);
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");

    const notice = await screen.findByTestId("payslip-failure");
    expect(notice).toHaveAttribute("data-kind", kind);
    const { title, text } = FAILURE_TEXT[kind]("testnet");
    const heading = within(notice).getByRole("heading", { level: 2, name: title });
    expect(heading).toHaveFocus();
    expect(notice).toHaveTextContent(text);
    expect(screen.queryByTestId("payslip-result")).toBeNull();
    expect(notice.textContent).not.toContain("words the page must not show");
    // It names the verifier's network when that is the point.
    if (kind === "network_not_served") expect(notice).toHaveTextContent("testnet");
  });

  it("is a request that did not reach the verifier at all: unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    const notice = await screen.findByTestId("payslip-failure");
    expect(notice).toHaveAttribute("data-kind", "unreachable");
  });
});

// ---- While it runs, and clearing --------------------------------------------------------

/** A fetch that never answers but honours its abort signal. */
function hang() {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, signals };
}

describe("while the check runs", () => {
  it("says so in the live region, and ignores a second press", async () => {
    const { fetchMock } = hang();
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check payslip" }));

    expect(within(outcome()).getByText("Checking the payslip against the chain…")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Checking…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Focus stays on the button: it is not taken away by disabling it.
    expect(button).toHaveFocus();
  });

  it("is dropped when the box is cleared: nothing is left, and the request is cancelled", async () => {
    const { signals } = hang();
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    await press("Clear");

    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
    expect(outcome()).toBeEmptyDOMElement();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Check payslip" })).toBeInTheDocument();
  });

  it("is dropped when the text is changed, and again when the page is left", async () => {
    const { signals } = hang();
    const view = show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    paste(`${SAMPLE_PAYSLIP_TEXT} `);
    expect(signals[0]?.aborted).toBe(true);
    expect(outcome()).toBeEmptyDOMElement();

    await press("Check payslip");
    expect(signals[1]?.aborted).toBe(false);
    view.unmount();
    expect(signals[1]?.aborted).toBe(true);
  });
});

describe("clearing", () => {
  it("empties the box, the result and the message about a bad paste", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Verified" });
    await press("Clear");
    expect(field()).toHaveValue("");
    expect(screen.queryByTestId("payslip-result")).toBeNull();

    paste("nope");
    await press("Check payslip");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await press("Clear");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field()).toHaveAttribute("aria-invalid", "false");
  });

  it("makes a result stale as soon as the text is edited: a verdict is only ever about the text beside it", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Verified" });
    paste(SAMPLE_PAYSLIP_TEXT.replace("90000", "90001"));
    expect(screen.queryByRole("heading", { name: "Verified" })).toBeNull();
  });
});

// ---- The result is announced and found ----------------------------------------------

describe("for a screen reader and the keyboard", () => {
  it("puts the result in a polite live region that is in the page from the start", async () => {
    verifierOfTheSample();
    show();
    expect(outcome()).toHaveAttribute("role", "status");
    expect(outcome()).toHaveAttribute("aria-live", "polite");
    await press("Load a sample");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Verified" });
    expect(within(outcome()).getByRole("heading", { level: 2, name: "Verified" })).toBeInTheDocument();
    expect(outcome()).toHaveAttribute("aria-live", "polite");
  });

  it("moves the focus to the result each time there is a new one", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    expect(await screen.findByRole("heading", { level: 2, name: "Verified" })).toHaveFocus();
    await press("Load a changed copy");
    await press("Check payslip");
    expect(await screen.findByRole("heading", { level: 2, name: "Not verified" })).toHaveFocus();
  });

  it("names the box, and has one h1", () => {
    show();
    expect(screen.getByRole("textbox", { name: "Payslip" })).toBe(field());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(field()).toHaveAttribute("spellcheck", "false");
    expect(field()).toHaveAttribute("autocomplete", "off");
  });

  it("can be used from the keyboard alone", async () => {
    verifierOfTheSample();
    show();
    const user = userEvent.setup();
    for (let i = 0; i < 40 && document.activeElement !== screen.getByRole("button", { name: "Load a sample" }); i += 1) await user.tab();
    await user.keyboard("{Enter}");
    expect(field()).toHaveValue(SAMPLE_PAYSLIP_TEXT);
    screen.getByRole("button", { name: "Check payslip" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 2, name: "Verified" })).toHaveFocus();
  });
});

// ---- Nothing is kept ------------------------------------------------------------------

// covers: REQ-PRIV-002
describe("what the page keeps", () => {
  const secrets = [sample.receiver, sample.rseed];

  it("puts the payslip in no storage, no address and no message, through a whole check", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const consoleCalls: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(`${method}: ${args.map(String).join(" ")}`);
      });
    }
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const before = window.location.href;

    const fetchMock = verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Verified" });
    await press("Load a changed copy");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Not verified" });
    paste("not a payslip");
    await press("Check payslip");
    await press("Clear");

    // Every place the page could have kept it.
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(document.cookie).toBe("");
    expect(window.location.href).toBe(before);
    expect(window.location.href + window.location.hash + window.location.search).not.toContain(sample.receiver);
    expect(JSON.stringify(window.history.state)).not.toContain(sample.receiver);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(consoleCalls).toEqual([]);
    // The two requests are the only place it went, in the body.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) for (const secret of secrets) expect(url).not.toContain(secret);
  });

  it("is in the page only where the person put it: the box and the short receiver, never the secret", async () => {
    verifierOfTheSample();
    show();
    await press("Load a sample");
    await press("Check payslip");
    await screen.findByRole("heading", { level: 2, name: "Verified" });
    await press("Clear");
    for (const secret of secrets) {
      expect(document.body.innerHTML).not.toContain(secret);
      expect(document.body.textContent).not.toContain(secret);
    }
  });

  it("does not use the query cache, which would hold the payslip as a key", () => {
    // The page takes its state from the component alone: unmounting it leaves nothing.
    const view = show();
    paste(SAMPLE_PAYSLIP_TEXT);
    expect(view.client.getQueryCache().getAll()).toHaveLength(0);
    view.unmount();
    expect(view.client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("never lets a form send it: there is no form to submit", () => {
    show();
    expect(document.querySelector("main form, main [type='submit']")).toBeNull();
  });
});

describe("the page, waiting for the verifier", () => {
  it("shows the verdict only when it arrives", async () => {
    let answerNow: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => {
        answerNow = resolve;
      })),
    );
    show();
    paste(SAMPLE_PAYSLIP_TEXT);
    await press("Check payslip");
    expect(screen.queryByTestId("payslip-result")).toBeNull();
    answerNow(new Response(JSON.stringify(answer(sample)), { status: 200 }));
    expect(await screen.findByRole("heading", { level: 2, name: "Verified" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Checking the payslip against the chain…")).toBeNull();
    });
  });
});
