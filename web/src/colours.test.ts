// The colours, as the stylesheet has them, checked: Redacted paper, light and dark, must be
// complete, and every pair of roles that meet in the app must be readable (WCAG 2.2 AA:
// text 4.5:1, the boundary of a control and the ends of a gradient 3:1). The values are read
// out of index.css itself, so this fails the moment a colour there is changed carelessly.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Read as a file: the test runner turns a CSS import into nothing.
const SRC = join(process.cwd(), "src");
const css = readFileSync(join(SRC, "index.css"), "utf8");

/** Every .ts and .tsx file under src, not counting tests. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name) ? [path] : [];
  });
}

const MODES = ["light", "dark"] as const;
const ROLES = [
  "bg",
  "surface",
  "ink",
  "muted",
  "rule",
  "control",
  "accent",
  "accent-ink",
  "accent-text",
  "marker",
  "marker-ink",
  "bar",
  "island",
  "island-ink",
  "island-muted",
  "bezel",
  "good",
  "bad",
  "qr-ink",
  "qr-paper",
] as const;
type Role = (typeof ROLES)[number];
type Colours = Record<Role, string>;

/** The `--p-*` declarations of a block whose selector starts with `selector`. */
function block(selector: string): Colours | null {
  const start = css.indexOf(selector);
  if (start < 0) return null;
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const found: Partial<Colours> = {};
  for (const role of ROLES) {
    const match = new RegExp(`--p-${role}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "u").exec(body);
    if (match?.[1] !== undefined) found[role] = match[1].toLowerCase();
  }
  return found as Colours;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** What `color-mix(in srgb, a pct%, b)` comes to. */
function mix(a: string, b: string, pct: number): string {
  const ca = Number.parseInt(a.slice(1), 16);
  const cb = Number.parseInt(b.slice(1), 16);
  const part = (shift: number) => Math.round((((ca >> shift) & 255) * pct + ((cb >> shift) & 255) * (1 - pct))).toString(16).padStart(2, "0");
  return `#${part(16)}${part(8)}${part(0)}`;
}

const colours = (mode: string) => block(`:root[data-theme="${mode}"]`);

describe("Redacted paper is complete, in both modes", () => {
  for (const m of MODES) {
    it(m, () => {
      const c = colours(m);
      expect(c, "the block exists").not.toBeNull();
      for (const role of ROLES) expect(c?.[role], `--p-${role}`).toMatch(/^#[0-9a-f]{6}$/u);
    });
  }

  it("the page before any script has run is the light set", () => {
    expect(block(":root {\n  color-scheme: light;")).toEqual(colours("light"));
  });

  it("the header capsule is the redaction bar, in both sets", () => {
    for (const m of MODES) expect(colours(m)?.island, m).toBe(colours(m)?.bar);
    // Light text on the black bar; in the dark set the bar is light grey, so dark text.
    expect(colours("light")?.["island-ink"]).toBe("#f2f2ee");
    expect(colours("dark")?.["island-ink"]).toBe("#141414");
  });

  it("is the look the owner chose on 2026-10-15: white sheet, black bars, a marker-yellow highlighter", () => {
    const light = colours("light");
    expect(light?.surface).toBe("#ffffff");
    expect(light?.bar).toBe("#000000");
    expect(light?.marker).toBe("#ffd60a");
    // The action is ink on paper; in the dark set, where black would vanish, it is the marker.
    expect(light?.accent).toBe(light?.ink);
    expect(colours("dark")?.accent).toBe(colours("dark")?.marker);
    expect(colours("dark")?.["accent-ink"]).toBe("#141414");
  });
});

describe("the screen's bezel", () => {
  it("is ink on the page and pure black after hours", () => {
    expect(colours("light")?.bezel).toBe("#0b0b0b");
    expect(colours("dark")?.bezel).toBe("#000000");
  });

  it("is a role the frame draws, and the dark set marks the curve with a hairline of its ink (black on near-black would not show)", () => {
    expect(css).toMatch(/--bezel:\s*var\(--p-bezel\)/u);
    expect(css).toMatch(/box-shadow:\s*0 0 0 100vmax var\(--bezel\)/u);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{\n\s*\/\*[^*]*\*\/\n\s*--bezel-edge: color-mix\(in srgb, var\(--p-ink\) 1[0-9]%, transparent\);/u);
  });

  it("is seen against the page: hard in the light set, and by its edge in the dark set", () => {
    const light = colours("light");
    expect(contrast(light?.bezel ?? "#000000", light?.bg ?? "#ffffff")).toBeGreaterThanOrEqual(15);
    // After hours the ring is nearly the page's own colour on purpose (a bright ring would be a frame around a dark page), and the edge is
    // what shows the curve: a line of the ink at 16%, drawn inside the window, so over the page's own colour. It is seen against the
    // ring outside it and against the page inside it.
    const dark = colours("dark");
    const edge = mix(dark?.ink ?? "#ffffff", dark?.bg ?? "#000000", 0.16);
    expect(contrast(edge, dark?.bezel ?? "#000000"), "against the ring").toBeGreaterThanOrEqual(1.5);
    expect(contrast(edge, dark?.bg ?? "#000000"), "against the page").toBeGreaterThanOrEqual(1.4);
  });

  it("is what the browser's own chrome is told to be on a phone (theme-color), so the two are one frame", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    const color = /<meta name="theme-color" content="(#[0-9a-fA-F]{6})"/u.exec(html)?.[1];
    expect(color?.toLowerCase()).toBe(colours("light")?.bezel);
  });
});

describe("a QR code is dark on light, whatever the theme", () => {
  it("is black on white in the light set and in the dark set, the same in both", () => {
    for (const m of MODES) {
      const c = colours(m);
      expect(c?.["qr-ink"], m).toBe("#000000");
      expect(c?.["qr-paper"], m).toBe("#ffffff");
    }
  });

  it("is drawn from the roles, not from the page's own colours", () => {
    expect(css).toMatch(/--qr-ink:\s*var\(--p-qr-ink\)/u);
    expect(css).toMatch(/--qr-paper:\s*var\(--p-qr-paper\)/u);
  });
});

describe("every pair of roles that meet in the app is readable", () => {
  for (const m of MODES) {
    describe(m, () => {
      const c = colours(m);
      if (c === null) return;
      const secondary = mix(c.ink, c.bg, 0.07);
      const muted = mix(c.ink, c.bg, 0.05);
      // The capsule's rows answer the pointer with a tint of their own ink (14% in index.css).
      const hoveredIsland = mix(c["island-ink"], c.island, 0.14);
      const pairs: [name: string, fg: string, bg: string, min: number][] = [
        ["text on the page", c.ink, c.bg, 4.5],
        ["text on a surface", c.ink, c.surface, 4.5],
        ["quiet text on the page", c.muted, c.bg, 4.5],
        ["quiet text on a surface", c.muted, c.surface, 4.5],
        ["quiet text on a hovered row or a tinted fill", c.muted, secondary, 4.5],
        ["quiet text on a muted fill", c.muted, muted, 4.5],
        ["text on a tinted fill", c.ink, secondary, 4.5],
        ["text on the action", c["accent-ink"], c.accent, 4.5],
        ["the accent as text on the page", c["accent-text"], c.bg, 4.5],
        ["the accent as text on a surface", c["accent-text"], c.surface, 4.5],
        ["'verified' text on the page", c.good, c.bg, 4.5],
        ["'verified' text on a surface", c.good, c.surface, 4.5],
        ["'problem' text on the page", c.bad, c.bg, 4.5],
        ["'problem' text on a surface", c.bad, c.surface, 4.5],
        ["a control's boundary on the page", c.control, c.bg, 3],
        ["a control's boundary on a surface", c.control, c.surface, 3],
        ["text on the marker (revealed text, highlighted rows)", c["marker-ink"], c.marker, 4.5],
        ["the focus ring on the page", c.ink, c.bg, 3],
        ["the redaction bar is seen against the page", c.bar, c.bg, 1.4],
        ["the header capsule is seen against the page", c.island, c.bg, 3],
        ["text on the header capsule", c["island-ink"], c.island, 4.5],
        ["quiet text on the header capsule", c["island-muted"], c.island, 4.5],
        ["text on a hovered row of the header capsule", c["island-ink"], hoveredIsland, 4.5],
        ["quiet text on a hovered row of the header capsule", c["island-muted"], hoveredIsland, 4.5],
        ["the focus ring on the header capsule", c["island-ink"], c.island, 3],
        // A scanner needs more than a reader does: a dark code on a light ground, as sharp as it can be.
        ["a QR code's dark on its light", c["qr-ink"], c["qr-paper"], 18],
      ];
      for (const [name, fg, bg, min] of pairs) {
        it(`${name}: at least ${String(min)}:1`, () => {
          expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }
});

describe("no colour is written anywhere but in the palettes", () => {
  const withoutPalettes = css
    .replace(/:root(\[data-theme="(?:dark|light)"\])? \{\n {2}color-scheme: (?:dark|light);\n {2}--p-bg[^}]*\}/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "");

  it("the stylesheet outside the palettes has no colour literals", () => {
    expect(withoutPalettes.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(/gu) ?? []).toEqual([]);
  });

  it("the source has none either", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      // Code only: a colour named in a comment is not a colour used.
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
      const found = code.match(/["'`(\s]#[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(|\boklch\(/gu);
      if (found !== null) offenders.push(`${file.slice(SRC.length)}: ${found.join(" ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
