import { describe, expect, it } from "vitest";

import { modulePath, QUIET_ZONE } from "./qr";

describe("modulePath", () => {
  it("is nothing for a code with no dark module", () => {
    expect(modulePath([])).toBe("");
    expect(modulePath([[false, false], [false, false]])).toBe("");
  });

  it("is one bar for each run of dark modules in a row, moved in by the quiet zone", () => {
    const modules = [
      [true, true, false, true],
      [false, false, false, false],
      [false, true, true, true],
    ];
    expect(QUIET_ZONE).toBe(4);
    expect(modulePath(modules)).toBe("M4 4h2v1h-2zM7 4h1v1h-1zM5 6h3v1h-3z");
    expect(modulePath(modules, 0)).toBe("M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3z");
  });

  it("covers every dark module once and no light one", () => {
    const modules = Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => (x * 7 + y * 13 + x * y) % 3 === 0));
    const covered = Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => 0));
    for (const run of modulePath(modules, 0).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/gu)) {
      const [x, y, width] = [Number(run[1]), Number(run[2]), Number(run[3])];
      for (let i = x; i < x + width; i += 1) (covered[y] as number[])[i] = ((covered[y] as number[])[i] ?? 0) + 1;
    }
    expect(covered.map((row) => row.map((n) => n === 1))).toEqual(modules);
  });

  it("uses only whole numbers and the six commands it should", () => {
    const modules = Array.from({ length: 33 }, (_, y) => Array.from({ length: 33 }, (_, x) => (x ^ y) % 4 === 0));
    expect(modulePath(modules).replaceAll(/M\d+ \d+h\d+v1h-\d+z/gu, "")).toBe("");
  });
});
