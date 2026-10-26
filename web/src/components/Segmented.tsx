import { ToggleGroup } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Names the group for assistive technology ("Who is looking"). */
  label: string;
  className?: string;
}

/** A choice of one among a few, with a thumb that slides to the one chosen. Each option
 * is a radio: the arrow keys move between them, Tab leaves the group, and the thumb is
 * only a picture of what the radios already say. */
export function Segmented<T extends string>({ value, onValueChange, options, label, className }: SegmentedProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  // The thumb is placed without a glide the first time, so it does not slide in from nowhere.
  const [glide, setGlide] = useState(false);

  const place = useCallback(() => {
    const on = root.current?.querySelector<HTMLElement>("[data-state='on']");
    setThumb(on ? { left: on.offsetLeft, width: on.offsetWidth } : null);
  }, []);

  useLayoutEffect(() => {
    place();
  }, [value, options, place]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setGlide(true);
    });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (observer && root.current) observer.observe(root.current);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [place]);

  return (
    <ToggleGroup.Root
      ref={root}
      type="single"
      value={value}
      // Pressing the chosen one again would leave nothing chosen; keep the choice.
      onValueChange={(next) => {
        if (next !== "") onValueChange(next as T);
      }}
      aria-label={label}
      className={cn("relative inline-flex rounded-full border border-input bg-card p-[3px]", className)}
    >
      {thumb !== null && (
        <span
          aria-hidden
          data-slot="segmented-thumb"
          className={cn("absolute top-[3px] bottom-[3px] left-0 rounded-full bg-primary", glide && "segmented-glide")}
          style={{ width: thumb.width, transform: `translateX(${String(thumb.left)}px)` }}
        />
      )}
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
          className="press-only relative z-10 min-h-11 rounded-full px-3 text-[0.9375rem] font-semibold whitespace-nowrap sm:px-5 sm:text-base text-foreground data-[state=on]:text-primary-foreground disabled:opacity-50"
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
