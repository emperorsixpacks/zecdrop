// Test support: read a QR code the way a phone does, from the SVG a page drew, with a decoder that is not the
// one that made it (jsQR; the matrix comes from uqr). The SVG is turned back into pixels from nothing but what is
// in the page: its viewBox and its path. Anything in it that this does not understand is an error, not a guess, so
// a code that is drawn some other way, or in other colours, fails here instead of passing by luck.

import jsQR from "jsqr";

/** What the app's QR code is made of, as the DOM has it. */
export interface DrawnQr {
  /** Modules along one side, quiet zone included. */
  size: number;
  /** Rows of modules, quiet zone included: true is dark. */
  modules: boolean[][];
  /** The quiet zone on each side, in modules: how far the dark modules are from the edge. */
  quietZone: number;
}

const BAR = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/gu;

/** Read the SVG a QrCode draws back into modules. Throws if it is not drawn exactly the way QrCode draws. */
export function readQrSvg(svg: Element): DrawnQr {
  if (svg.tagName.toLowerCase() !== "svg") throw new Error("not an svg");
  if (svg.getAttribute("role") !== "img" || (svg.getAttribute("aria-label") ?? "") === "") throw new Error("the code has no accessible name");
  const box = /^0 0 (\d+) (\d+)$/u.exec(svg.getAttribute("viewBox") ?? "");
  if (box === null || box[1] !== box[2]) throw new Error("the viewBox is not a square from the origin");
  const size = Number(box[1]);

  const children = Array.from(svg.children, (child) => child.tagName.toLowerCase());
  if (children.join(",") !== "rect,path") throw new Error(`the code is not one rect and one path: ${children.join(",")}`);
  const rect = svg.querySelector("rect");
  const path = svg.querySelector("path");
  if (rect?.getAttribute("width") !== String(size) || rect.getAttribute("height") !== String(size)) throw new Error("the paper is not the whole code");
  // Dark on light, from the roles in index.css (colours.test.ts: black and white in both themes).
  if (rect.getAttribute("fill") !== "var(--qr-paper)") throw new Error("the paper is not the light role");
  if (path?.getAttribute("fill") !== "var(--qr-ink)") throw new Error("the modules are not the dark role");

  const d = path.getAttribute("d") ?? "";
  if (d.replaceAll(BAR, "") !== "") throw new Error("the path holds something that is not a run of modules");
  const modules = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  let smallest = size;
  for (const run of d.matchAll(BAR)) {
    const [, x, y, width, back] = run.map(Number) as [number, number, number, number, number];
    if (width !== back || width < 1 || x + width > size || y >= size) throw new Error("a run is outside the code");
    const row = modules[y];
    if (row === undefined) throw new Error("a run is outside the code");
    for (let i = x; i < x + width; i += 1) row[i] = true;
    smallest = Math.min(smallest, x, y, size - (x + width), size - 1 - y);
  }
  return { size, modules, quietZone: smallest };
}

/** The pixels of the code: dark modules black on a white ground, `scale` pixels to a module. */
export function rasterise(code: DrawnQr, scale = 6): { data: Uint8ClampedArray; width: number; height: number } {
  const width = code.size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  code.modules.forEach((row, my) => {
    row.forEach((dark, mx) => {
      if (!dark) return;
      for (let py = 0; py < scale; py += 1) {
        for (let px = 0; px < scale; px += 1) {
          const at = ((my * scale + py) * width + mx * scale + px) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
        }
      }
    });
  });
  return { data, width, height: width };
}

/** What a scanner reads from the SVG, or null if it can read nothing. It will not read a light code on a dark ground. */
export function decodeQrSvg(svg: Element, scale = 6): { text: string; version: number } | null {
  const { data, width, height } = rasterise(readQrSvg(svg), scale);
  const read = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
  return read === null ? null : { text: read.data, version: read.version };
}

/** What a scanner reads from the pixels of a screenshot (RGBA), or null. Again, dark on light only. */
export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}

/** The error-correction level the code says it has, read from its format bits (the 15 bits beside the top-left finder
 * pattern, XORed with 0x5412; the top two data bits are L=01, M=00, Q=11, H=10). A code that says M but was made at L is caught. */
export function readEccLevel(code: DrawnQr): "L" | "M" | "Q" | "H" {
  const quiet = code.quietZone;
  const at = (x: number, y: number): number => (code.modules[quiet + y]?.[quiet + x] === true ? 1 : 0);
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) bits |= at(8, i) << i;
  bits |= at(8, 7) << 6;
  bits |= at(8, 8) << 7;
  bits |= at(7, 8) << 8;
  for (let i = 9; i < 15; i += 1) bits |= at(14 - i, 8) << i;
  const level = ((bits ^ 0x5412) >>> 13) & 3;
  const found = ({ 1: "L", 0: "M", 3: "Q", 2: "H" } as const)[level as 0 | 1 | 2 | 3];
  return found;
}
