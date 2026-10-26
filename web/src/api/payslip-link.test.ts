import { describe, expect, it } from "vitest";

import { LINK_KEY, LINK_PATH, MAX_LINK_VALUE, payslipLink, readPayslipFragment } from "./payslip-link";
import { MAX_PAYSLIP_BODY, payslipBody, readPayslip, type Payslip } from "./payslip-input";
import { samplePayslip } from "./payslip-sample";

const sample = samplePayslip();
const BASE = "https://zecdrop.example";

/** base64url of text, as the link writes it. */
const b64 = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const fragmentOf = (link: string) => link.slice(link.indexOf("#"));
const good = () => fragmentOf(payslipLink(sample, BASE));

// covers: REQ-PAY-004
describe("a payslip's link", () => {
  it("is the page, then # and the payslip, and nothing is before the #", () => {
    const link = payslipLink(sample, BASE);
    expect(link.startsWith(`${BASE}${LINK_PATH}#${LINK_KEY}=`)).toBe(true);
    const url = new URL(link);
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe("/payslip");
    expect(url.search).toBe("");
    expect(url.hash.startsWith("#payslip=")).toBe(true);
    // What a browser sends to a server is the part before the #. It holds nothing of the payslip.
    const sent = link.split("#")[0] ?? "";
    for (const secret of [sample.receiver, sample.rseed, sample.txid, sample.value, btoa(payslipBody(sample)).slice(0, 20)]) expect(sent).not.toContain(secret);
    expect(link.split("#")).toHaveLength(2);
  });

  it("carries the payslip's body, in base64url with no padding, and nothing else", () => {
    const value = new URL(payslipLink(sample, BASE)).hash.slice("#payslip=".length);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(value).toBe(b64(payslipBody(sample)));
    expect(value.length).toBeLessThanOrEqual(MAX_LINK_VALUE);
    // About 440 characters, so a link is about 480 with the address in front.
    expect(value.length).toBeGreaterThan(400);
    expect(value.length).toBeLessThan(480);
    expect(payslipLink(sample, BASE).length).toBeLessThan(520);
  });

  it("takes a base with a slash at its end, or the loopback address, without doubling anything", () => {
    expect(payslipLink(sample, `${BASE}/`)).toBe(payslipLink(sample, BASE));
    expect(payslipLink(sample, "http://127.0.0.1:8787").startsWith("http://127.0.0.1:8787/payslip#payslip=")).toBe(true);
  });

  it("comes back as the payslip it was made from, for every payslip there can be", () => {
    const biggest: Payslip = { ...sample, network: "mainnet", action: 4_294_967_295, value: "2100000000000000" };
    for (const payslip of [sample, biggest, { ...sample, action: 0, value: "0" }, { ...sample, network: "mainnet" as const }]) {
      const read = readPayslipFragment(fragmentOf(payslipLink(payslip, BASE)));
      expect(read).toEqual({ ok: true, payslip });
    }
  });

  it("is the same payslip the paste reads: a link and the file give the same thing", () => {
    const fromLink = readPayslipFragment(good());
    const fromFile = readPayslip(JSON.stringify(sample, null, 2));
    expect(fromLink?.ok && fromFile.ok && fromLink.payslip).toEqual(fromFile.ok && fromFile.payslip);
  });
});

describe("a fragment that is not a payslip link at all", () => {
  it.each(["", "#", "#main", "#top", "#token=abc", "#payslips", "#payslip-x", "#payslip_", "#PAYSLIP=abc", "#Payslip", "#x=payslip", "payslip=abc", "#/payslip"])(
    "%j is left alone: null, so the page does nothing about it",
    (hash) => {
      expect(readPayslipFragment(hash)).toBeNull();
    },
  );
});

describe("a fragment that says it is a payslip link and is not", () => {
  const bad = (hash: string) => {
    expect(readPayslipFragment(hash), hash.slice(0, 60)).toEqual({ ok: false });
  };
  const value = good().slice("#payslip=".length);

  it("has no value, or none that is base64url", () => {
    for (const hash of ["#payslip", "#payslip=", "#payslip= ", "#payslip=%41%41", "#payslip=a b", "#payslip=a\nb", "#payslip=éééé"]) bad(hash);
  });

  it("has whitespace in a value that is otherwise a payslip, which a lenient base64 reader skips and this page does not", () => {
    // Four of them, so that the length is still a whole number of fours and only what the characters are can tell.
    expect(value.length % 4).toBe(0);
    for (const gap of ["    ", "\t\t\t\t", "\n\n\n\n", " \t\r\n", "\f\f\f\f"]) {
      bad(`#payslip=${value.slice(0, 40)}${gap}${value.slice(40)}`);
      bad(`#payslip=${gap}${value}`);
      bad(`#payslip=${value}${gap}`);
    }
  });

  it("uses the other base64 (+, /) or padding (=), which a link made here never does", () => {
    // The same bytes in the standard alphabet (and with its padding), which is another spelling.
    bad(`#payslip=${btoa(payslipBody(sample))}`.replace(/=*$/u, "=="));
    bad(`#payslip=${value}=`);
    bad(`#payslip=${value}==`);
    bad(`#payslip=${value.slice(0, 20)}+/${value.slice(20)}`);
    bad(`#payslip=${value}&other=1`);
    bad(`#payslip=${value}#again`);
  });

  it("is a length no base64 has", () => {
    // Four characters hold three bytes, two hold one and three hold two: one more than a whole four is nothing.
    bad(`#payslip=${value.slice(0, 200)}A`);
    bad(`#payslip=${"A".repeat(5)}`);
    bad(`#payslip=${"A".repeat(441)}`);
  });

  it("has stray bits at its end: the same bytes, but not the one way this page writes them", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // A body one or two bytes longer than a whole number of threes ends in a character that has bits to spare.
    for (const spaces of [1, 2]) {
      const written = b64(`${payslipBody(sample)}${" ".repeat(spaces)}`);
      expect(written.length % 4, `${String(spaces)} space`).toBe(spaces + 1);
      expect(readPayslipFragment(`#payslip=${written}`)?.ok).toBe(true);
      const last = alphabet.indexOf(written.slice(-1));
      expect(last % 4).toBe(0);
      const stray = alphabet[last | 1] ?? "";
      expect(stray).not.toBe(written.slice(-1));
      bad(`#payslip=${written.slice(0, -1)}${stray}`);
    }
  });

  it("is too long to be a payslip, even when it is valid base64url of something that parses", () => {
    const padded = `${payslipBody(sample)}${" ".repeat(MAX_PAYSLIP_BODY + 100 - payslipBody(sample).length)}`;
    expect(padded.length).toBeGreaterThan(MAX_PAYSLIP_BODY);
    bad(`#payslip=${b64(padded)}`);
    bad(`#payslip=${"A".repeat(MAX_LINK_VALUE + 4)}`);
    // The longest allowed is allowed: a payslip with its space, at the verifier's own limit.
    const edge = `${payslipBody(sample)}${" ".repeat(MAX_PAYSLIP_BODY - payslipBody(sample).length)}`;
    expect(readPayslipFragment(`#payslip=${b64(edge)}`)?.ok).toBe(true);
  });

  it("holds bytes that are not text", () => {
    bad(`#payslip=${btoa(String.fromCharCode(0xff, 0xfe, 0xfd)).replaceAll("=", "")}`);
    bad(`#payslip=${btoa(String.fromCharCode(0xc3, 0x28)).replaceAll("=", "")}`);
  });

  it("holds text that is not a payslip, or one this page does not read", () => {
    const slip = { ...sample };
    const cases: [string, string][] = [
      ["words", "hello there"],
      ["JSON that is not an object", "[1,2,3]"],
      ["a field too many", JSON.stringify({ ...slip, memo: "hi" })],
      ["a field too few", JSON.stringify({ ...slip, rseed: undefined })],
      ["version 2", JSON.stringify({ ...slip, version: 2 })],
      ["a network it does not know", JSON.stringify({ ...slip, network: "regtest" })],
      ["a txid in capitals", JSON.stringify({ ...slip, txid: slip.txid.toUpperCase() })],
      ["an amount that is not whole zatoshi", JSON.stringify({ ...slip, value: "1.5" })],
      ["a receiver one character short", JSON.stringify({ ...slip, receiver: slip.receiver.slice(1) })],
      ["a viewing key", `{"uview1":"x"} ufvk1abc`],
    ];
    for (const [, text] of cases) bad(`#payslip=${b64(text)}`);
  });

  it("never throws, whatever it is given, and never repeats it", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    const pieces = ["#payslip=", "#payslip", "A", "-", "_", "=", "+", "/", "%", " ", "\u0000", "\ud800", "é", ...value.match(/.{1,40}/gu) ?? []];
    for (let i = 0; i < 2_000; i += 1) {
      let hash = next() % 4 === 0 ? "" : "#payslip=";
      for (let n = next() % 12; n > 0; n -= 1) hash += pieces[next() % pieces.length] ?? "";
      expect(() => readPayslipFragment(hash)).not.toThrow();
      const read = readPayslipFragment(hash);
      if (read !== null && !read.ok) expect(Object.keys(read)).toEqual(["ok"]);
    }
  });
});
