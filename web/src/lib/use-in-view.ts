import { useEffect, useRef, useState, type RefObject } from "react";

import { prefersReducedMotion } from "./motion";

/** True once the element has scrolled into view (and stays true), for things that draw
 * themselves when they are first seen. Where there is no way to tell, or motion is
 * reduced, it is true from the start: nothing waits for a scroll that will not be watched. */
export function useInView<T extends Element>(threshold = 0.25): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined" || prefersReducedMotion());
  useEffect(() => {
    const element = ref.current;
    if (seen || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [seen, threshold]);
  return [ref, seen];
}
