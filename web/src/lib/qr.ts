// What a QR code drawn as an SVG is made of. The matrix of modules comes from a library (see QrCode.tsx);
// what is here is the part this app owns: how big the quiet zone is, and how the dark modules become one path.

/** The empty margin a scanner needs all round the code, in modules. The standard asks for four. */
export const QUIET_ZONE = 4;

/** Error correction: L recovers up to 7% of the code, M 15%, Q 25%, H 30%. A higher level makes a bigger, denser code. */
export type QrEcc = "L" | "M" | "Q" | "H";

/** The dark modules as one SVG path: a one-module-high bar for each horizontal run,
 * `M<x> <y>h<width>v1h-<width>z`, moved in by the quiet zone. Plain integers only, so that what is drawn can be read back
 * exactly (the tests do, with a decoder that did not make it). */
export function modulePath(modules: readonly (readonly boolean[])[], offset: number = QUIET_ZONE): string {
  const bars: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== true) {
        x += 1;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === true) end += 1;
      const width = String(end - x);
      bars.push(`M${String(x + offset)} ${String(y + offset)}h${width}v1h-${width}z`);
      x = end;
    }
  });
  return bars.join("");
}
