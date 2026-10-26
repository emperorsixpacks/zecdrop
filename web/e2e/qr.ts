// Read a QR code the way a phone does, from the pixels the browser drew: a screenshot of the SVG, decoded by jsQR (not the
// library that made the matrix). It needs the PNG turned back into pixels, which is a few lines on Node's own zlib.

import { inflateSync } from "node:zlib";

import jsQRImport from "jsqr";

// jsQR is a CommonJS package whose default export is the function. Node's own ESM loader hands over the module object
// (the function is its `default`), and a transpiler to CommonJS hands over the function: take it whichever way it comes.
type Decode = typeof jsQRImport.default;
const jsQR: Decode = typeof (jsQRImport as unknown) === "function" ? (jsQRImport as unknown as Decode) : jsQRImport.default;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The pixels of an 8-bit RGB or RGBA PNG that is not interlaced (what Chromium writes), as RGBA. */
export function readPng(png: Buffer): { data: Uint8ClampedArray; width: number; height: number } {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`unsupported PNG (depth ${String(depth)}, colour ${String(colour)}, interlace ${String(interlace)})`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (rows[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (rows[(y - 1) * stride + x - channels] ?? 0) : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const [dl, du, dul] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - upLeft)];
        predicted = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${String(filter)}`);
      rows[y * stride + x] = (value + predicted) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rows[i * channels] ?? 0;
    data[i * 4 + 1] = rows[i * channels + 1] ?? 0;
    data[i * 4 + 2] = rows[i * channels + 2] ?? 0;
    data[i * 4 + 3] = channels === 4 ? (rows[i * channels + 3] ?? 255) : 255;
  }
  return { data, width, height };
}

/** What a scanner reads from a screenshot of a QR code, or null if it reads nothing. Dark on light only: it does not invert. */
export function decodeScreenshot(png: Buffer): string | null {
  const { data, width, height } = readPng(png);
  return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}
