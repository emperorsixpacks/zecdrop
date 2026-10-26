import { useEffect, useState } from "react";

import { modulePath, QUIET_ZONE, type QrEcc } from "@/lib/qr";
import { cn } from "@/lib/utils";

interface QrCodeProps {
  /** What the code holds. */
  text: string;
  /** What the code is, for a person who cannot see it. */
  label: string;
  /** Error correction. M suits a short text; for a long one the lowest level a scanner still reads keeps the modules big enough. */
  ecc?: QrEcc;
  /** CSS pixels to a module where there is room: a whole number, so that every module is as wide as every other and a scanner
   * reading a screen sees clean edges. Where the box is narrower the code shrinks to fit (`w-full`, and a caller may say
   * `md:w-auto` to keep the whole number from a width up). */
  moduleSize?: number;
  className?: string;
}

/** The text and level a matrix was made for, so a code is never shown for a text it was not made from. */
interface Drawn {
  text: string;
  ecc: QrEcc;
  /** Null when the code could not be made (the text is too long for any QR code, or the library did not load). */
  modules: boolean[][] | null;
}

/** A QR code as an inline SVG: dark on light whatever the theme, because a scanner needs it, with the quiet zone round it.
 * It is drawn from a matrix of booleans, so there is no canvas, no data address and no request: nothing leaves the page.
 * The library that makes the matrix is loaded the first time a code is drawn, so a page that never draws one does not carry it. */
export function QrCode({ text, label, ecc = "M", moduleSize = 5, className }: QrCodeProps) {
  const [drawn, setDrawn] = useState<Drawn | null>(null);

  useEffect(() => {
    let current = true;
    void import("uqr")
      .then(({ encode }) => encode(text, { ecc, border: 0 }).data)
      .then(
        (modules) => {
          if (current) setDrawn({ text, ecc, modules });
        },
        () => {
          if (current) setDrawn({ text, ecc, modules: null });
        },
      );
    return () => {
      current = false;
    };
  }, [text, ecc]);

  const modules = drawn !== null && drawn.text === text && drawn.ecc === ecc ? drawn.modules : undefined;
  if (modules === undefined || modules === null) {
    return (
      <p
        role="status"
        className={cn("flex aspect-square w-full items-center justify-center border border-dashed border-border p-4 text-center text-sm text-muted-foreground", className)}
      >
        {modules === undefined ? "Making the code…" : "The QR code could not be made."}
      </p>
    );
  }

  const size = modules.length + 2 * QUIET_ZONE;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size * moduleSize}
      height={size * moduleSize}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      // A forced-colours mode must not recolour it: a scanner reads dark on light, and nothing else.
      className={cn("block h-auto w-full forced-color-adjust-none", className)}
    >
      <rect width={size} height={size} fill="var(--qr-paper)" />
      <path d={modulePath(modules)} fill="var(--qr-ink)" />
    </svg>
  );
}
