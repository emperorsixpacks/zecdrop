import { useEffect, useRef } from "react";

import { motionScale } from "./motion";

const DURATION_MS = 700;

/** The value of a number part-way through its count: it eases out, so most of the movement is early. */
function eased(from: number, to: number, k: number): number {
  return from + (to - from) * (1 - Math.pow(1 - k, 3));
}

/** A number that counts to its value whenever the value changes: from zero when it first
 * appears, from the old value after that. Tabular figures and a fixed number of decimals
 * while it runs, and room kept for the finished width, so nothing around it moves. Under
 * "reduce motion" it is just the value. */
export function useCountTo(target: number, step: (value: number) => void): void {
  const shown = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    const scale = motionScale();
    const from = first.current ? 0 : shown.current;
    first.current = false;
    if (scale === 0 || from === target) {
      shown.current = target;
      step(target);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      // A frame's own timestamp can be a hair earlier than the moment this started: never run backwards.
      const k = Math.min(1, Math.max(0, (now - t0) / (DURATION_MS * scale)));
      shown.current = k >= 1 ? target : eased(from, target, k);
      step(shown.current);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
    // `step` is a setter: it does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
}

