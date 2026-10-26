import { useState, type CSSProperties } from "react";

import { isLively } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** A short burst, in the look's two colours, drawn only when Lively (never under "reduce
 * motion"). Decoration: hidden from assistive technology, and it removes itself. */
export function Confetti() {
  const [show, setShow] = useState(isLively);
  const [pieces] = useState(() =>
    Array.from({ length: 26 }, (_, k) => {
      const angle = Math.random() * Math.PI * 2;
      const distance = 70 + Math.random() * 90;
      return {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance - 20,
        r: Math.random() * 540 - 270,
        delay: Math.random() * 120,
        second: k % 2 === 1,
      };
    }),
  );
  if (!show) return null;
  return (
    <span aria-hidden data-testid="confetti" className="confetti">
      {pieces.map((p, i) => (
        <i
          key={i}
          className={cn(p.second ? "bg-accent-2" : "bg-primary")}
          style={{ "--x": `${String(p.x)}px`, "--y": `${String(p.y)}px`, "--r": `${String(p.r)}deg`, animationDelay: `${String(p.delay)}ms` } as CSSProperties}
          onAnimationEnd={i === pieces.length - 1 ? () => {
            setShow(false);
          } : undefined}
        />
      ))}
    </span>
  );
}
