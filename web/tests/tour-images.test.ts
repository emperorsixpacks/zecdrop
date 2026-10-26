// The home page tour's pictures (web/public/tour), checked against what the page says about them:
// every picture the tour names exists in both looks, is a WebP of exactly the width and height written
// in src/features/home/tour-steps.ts (so the page holds the right space and nothing moves when one
// arrives), nothing else is left in the folder, and the lot stays small. They are made by
// e2e/operator/tour-shots.spec.ts; if this fails after a change to a screen, run it again.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TOUR_LOOKS, TOUR_SHOTS, TOUR_WIDTH, tourImageSrc } from "../src/features/home/tour-steps.js";

const DIR = fileURLToPath(new URL("../public/tour/", import.meta.url));

/** The most the pictures may weigh together, in bytes: a visitor loads one look, but the build carries both. */
const BUDGET = 1_500_000;

/** The size a WebP file's own header gives, for the three forms of the format. */
function webpSize(file: Buffer): { width: number; height: number } {
  expect(file.toString("ascii", 0, 4), "a RIFF file").toBe("RIFF");
  expect(file.toString("ascii", 8, 12), "a WebP").toBe("WEBP");
  const form = file.toString("ascii", 12, 16);
  if (form === "VP8L") {
    // Lossless: after the signature byte, 14 bits of width - 1 and 14 bits of height - 1.
    const bits = file.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (form === "VP8X") return { width: file.readUIntLE(24, 3) + 1, height: file.readUIntLE(27, 3) + 1 };
  if (form === "VP8 ") return { width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff };
  throw new Error(`not a WebP form this test knows: ${form}`);
}

const files = TOUR_SHOTS.flatMap((shot) => TOUR_LOOKS.map((look) => ({ shot, look, name: tourImageSrc(shot, look).replace(/^\/tour\//u, "") })));

describe("the tour's pictures", () => {
  it.each(files)("$name exists and is $shot.height pixels tall and as wide as the page says", ({ shot, name }) => {
    const bytes = readFileSync(`${DIR}${name}`);
    expect(webpSize(bytes)).toEqual({ width: TOUR_WIDTH, height: shot.height });
  });

  it("are the only files in the folder: nothing stale is shipped, nothing is missing", () => {
    expect(readdirSync(DIR).sort()).toEqual(files.map((f) => f.name).sort());
  });

  it("stay small: both looks together are inside the budget, and each look alone is within half of it", () => {
    const sizes = files.map((f) => ({ look: f.look, bytes: statSync(`${DIR}${f.name}`).size }));
    const total = sizes.reduce((sum, f) => sum + f.bytes, 0);
    expect(total).toBeLessThanOrEqual(BUDGET);
    for (const look of TOUR_LOOKS) {
      expect(sizes.filter((f) => f.look === look).reduce((sum, f) => sum + f.bytes, 0)).toBeLessThanOrEqual(BUDGET / 2);
    }
  });

  it("have one id, one size and one text each, with no two alike", () => {
    expect(new Set(TOUR_SHOTS.map((s) => s.id)).size).toBe(TOUR_SHOTS.length);
    expect(new Set(TOUR_SHOTS.map((s) => s.alt)).size).toBe(TOUR_SHOTS.length);
  });
});
