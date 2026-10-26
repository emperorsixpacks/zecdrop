// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import "@/test/dom";
import { decodeQrSvg, readEccLevel, readQrSvg } from "@/test/qr";

import source from "./QrCode.tsx?raw";
import { QrCode } from "./QrCode";

afterEach(() => {
  document.body.innerHTML = "";
});

const NAME = "A code for this test";

async function drawn(text: string, ecc?: "L" | "M" | "Q" | "H") {
  const view = render(<QrCode text={text} label={NAME} {...(ecc === undefined ? {} : { ecc })} />);
  const svg = await screen.findByRole("img", { name: NAME });
  return { svg, view };
}

/** A deterministic pseudo-random text of `length` printable characters. */
function textOf(length: number, seed: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/?=&#._-+";
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return alphabet[state % alphabet.length];
  }).join("");
}

describe("the code", () => {
  it("is an image with the name it was given, and says it is being made until it is", async () => {
    render(<QrCode text="zcash:x" label={NAME} />);
    expect(screen.getByRole("status")).toHaveTextContent("Making the code…");
    expect(screen.queryByRole("img")).toBeNull();
    const svg = await screen.findByRole("img", { name: NAME });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds exactly the text, as an independent decoder reads it", async () => {
    const text = "zcash:tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD?amount=0.00545";
    const { svg } = await drawn(text);
    expect(decodeQrSvg(svg)?.text).toBe(text);
  });

  it.each(["L", "M", "Q", "H"] as const)("says the error-correction level it was asked for (%s), and holds the text at it", async (ecc) => {
    const text = "https://example.org/payslip#payslip=abc";
    const { svg } = await drawn(text, ecc);
    expect(readEccLevel(readQrSvg(svg))).toBe(ecc);
    expect(decodeQrSvg(svg)?.text).toBe(text);
  });

  it("is made at level M when no level is said", async () => {
    const { svg } = await drawn("zcash:x?amount=1");
    expect(readEccLevel(readQrSvg(svg))).toBe("M");
  });

  it("holds any text up to the size a payslip link has, at the lowest level and at M: from the smallest code to a big one", async () => {
    for (const [length, seed] of [[1, 3], [5, 5], [17, 7], [60, 11], [120, 13], [200, 17], [333, 19], [485, 23], [520, 29], [700, 31], [1200, 37]] as const) {
      for (const ecc of ["L", "M"] as const) {
        const text = textOf(length, seed);
        const { svg, view } = await drawn(text, ecc);
        const read = decodeQrSvg(svg);
        expect(read?.text, `${String(length)} characters at ${ecc}`).toBe(text);
        view.unmount();
      }
    }
  });

  it("holds the characters of a link, a wallet request and a payslip, and a code that is all letters of one case", async () => {
    for (const text of [
      "zcash:t1cFrgk2qsbNHgNSmV8DNauWTCe6EKRLW9L?amount=4.5002",
      "https://zecdrop.example/payslip#payslip=eyJ2ZXJzaW9uIjoxfQ",
      "HTTPS://EXAMPLE.ORG/ABC", // alphanumeric mode
      "0123456789", // numeric mode
      "café — €", // not ASCII: bytes of UTF-8
    ]) {
      const { svg, view } = await drawn(text);
      expect(decodeQrSvg(svg)?.text, text).toBe(text);
      view.unmount();
    }
  });
});

describe("the drawing", () => {
  it("is dark on light, from the roles that are black on white in both themes", async () => {
    const { svg } = await drawn("zcash:x?amount=1");
    expect(svg.querySelector("rect")).toHaveAttribute("fill", "var(--qr-paper)");
    expect(svg.querySelector("path")).toHaveAttribute("fill", "var(--qr-ink)");
  });

  it("has the quiet zone a scanner needs, four modules, on every side", async () => {
    for (const text of ["a", textOf(300, 41)]) {
      const { svg, view } = await drawn(text);
      const code = readQrSvg(svg);
      expect(code.quietZone, text.length > 1 ? "a big code" : "a small one").toBe(4);
      // The paper is the whole picture, so the zone is light.
      expect(svg.querySelector("rect")).toHaveAttribute("width", String(code.size));
      view.unmount();
    }
  });

  it("is one rect and one path, with nothing in it that loads, runs or styles", async () => {
    const { svg } = await drawn(textOf(200, 43));
    expect(Array.from(svg.children, (child) => child.tagName.toLowerCase())).toEqual(["rect", "path"]);
    expect(svg.outerHTML).not.toMatch(/<(image|canvas|foreignObject|script|style|use|a)\b|href=|xlink|data:|url\(|http/iu);
    expect(svg).not.toHaveAttribute("style");
    expect(document.querySelectorAll("canvas, img, style, script, link")).toHaveLength(0);
  });

  it("scales with its box and keeps its edges crisp, and is not recoloured by a forced-colours mode", async () => {
    const { svg } = await drawn("zcash:x?amount=1");
    expect(svg).toHaveAttribute("shape-rendering", "crispEdges");
    expect(svg).toHaveAttribute("viewBox", expect.stringMatching(/^0 0 \d+ \d+$/u));
    expect(svg.getAttribute("class")).toMatch(/\bw-full\b/u);
    expect(svg.getAttribute("class")).toMatch(/forced-color-adjust-none/u);
  });

  it("is a whole number of pixels to a module where there is room: five by default, and what it is told", async () => {
    const first = await drawn("zcash:x?amount=1");
    const code = readQrSvg(first.svg);
    expect(first.svg).toHaveAttribute("width", String(code.size * 5));
    expect(first.svg).toHaveAttribute("height", String(code.size * 5));
    first.view.unmount();
    const { svg } = await (async () => {
      const view = render(<QrCode text="zcash:x?amount=1" label={NAME} moduleSize={4} />);
      return { svg: await screen.findByRole("img", { name: NAME }), view };
    })();
    expect(svg).toHaveAttribute("width", String(code.size * 4));
    expect(svg).toHaveAttribute("height", String(code.size * 4));
  });

  it("is not read as a light code on a dark ground: the decoder here does not invert", async () => {
    const { svg } = await drawn("zcash:x?amount=1");
    svg.querySelector("rect")?.setAttribute("fill", "var(--qr-ink)");
    svg.querySelector("path")?.setAttribute("fill", "var(--qr-paper)");
    expect(() => decodeQrSvg(svg)).toThrow(/light role/u);
  });
});

describe("a code for another text", () => {
  it("is never shown while the old one is on the page: the new one is made, then shown", async () => {
    const view = render(<QrCode text="zcash:first?amount=1" label={NAME} />);
    const first = await screen.findByRole("img", { name: NAME });
    expect(decodeQrSvg(first)?.text).toBe("zcash:first?amount=1");

    view.rerender(<QrCode text="zcash:second?amount=2" label={NAME} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Making the code…");
    const second = await screen.findByRole("img", { name: NAME });
    expect(decodeQrSvg(second)?.text).toBe("zcash:second?amount=2");
  });

  it("is made again at another level when the level changes", async () => {
    const view = render(<QrCode text="zcash:x?amount=1" label={NAME} ecc="L" />);
    expect(readEccLevel(readQrSvg(await screen.findByRole("img", { name: NAME })))).toBe("L");
    view.rerender(<QrCode text="zcash:x?amount=1" label={NAME} ecc="H" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(readEccLevel(readQrSvg(await screen.findByRole("img", { name: NAME })))).toBe("H");
  });
});

describe("a text that is too long for any code", () => {
  it("says so, and draws nothing", async () => {
    render(<QrCode text={"x".repeat(4000)} label={NAME} />);
    expect(await screen.findByText("The QR code could not be made.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("still makes one at the largest size there is", async () => {
    const text = textOf(2300, 47);
    const { svg } = await drawn(text, "L");
    expect(decodeQrSvg(svg)?.text).toBe(text);
  });
});

describe("the library", () => {
  it("is loaded when a code is first drawn, never at the start: the component imports it by import(), and by nothing else", () => {
    expect(source).toMatch(/import\("uqr"\)/u);
    expect(source).not.toMatch(/from "uqr"/u);
    expect(source).not.toMatch(/require\(/u);
  });

  it("is the only thing the component loads: no request, no storage, no logging", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
    expect(code).not.toMatch(/\bfetch\b|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|console\./u);
  });
});
