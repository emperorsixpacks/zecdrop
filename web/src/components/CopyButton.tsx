import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

type CopyState = "idle" | "copied" | "failed";

const RESET_AFTER_MS = 2_000;

interface CopyButtonProps {
  /** The text that lands on the clipboard. */
  value: string;
  /** Accessible name, e.g. "Copy transaction id for batch 1". It starts with
   * the visible word "Copy", so voice-control users can say what they see. */
  label: string;
  /** "lg" for a main action on a screen; the default suits a row of details. */
  size?: "sm" | "lg";
  /** What the button says before it is pressed (default "Copy"). The accessible name stays `label`. */
  text?: string;
}

/** Copies `value` and says so, both visibly and to screen readers. Clipboard
 * access can be missing or refused (plain http, permissions), so failure is a
 * normal outcome with its own message, never a silent no-op. */
export function CopyButton({ value, label, size = "sm", text = "Copy" }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      // "Copy receipt link" -> "Receipt link copied"
      const what = label.replace(/^Copy /u, "");
      toast(`${what.charAt(0).toUpperCase()}${what.slice(1)} copied`);
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setState("idle");
    }, RESET_AFTER_MS);
  }

  const visible = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : text;
  const announced =
    state === "copied" ? "Copied to clipboard" : state === "failed" ? "Could not copy" : "";

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-label={label}
        onClick={() => {
          void copy();
        }}
      >
        {visible}
      </Button>
      <span role="status" className="sr-only">
        {announced}
      </span>
    </>
  );
}
