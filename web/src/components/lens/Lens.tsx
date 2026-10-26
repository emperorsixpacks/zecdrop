import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";

import { Segmented } from "@/components/Segmented";
import { shortId } from "@/lib/ids";
import { motionScale } from "@/lib/motion";
import { useCoinUnit } from "@/lib/units";
import { cn } from "@/lib/utils";
import { formatZec } from "@/lib/zec";

// The redaction lens (web/DESIGN.md): one list, three ways of seeing it.
//
//   Public      names, addresses and amounts are bars; only counts and totals read
//   One person  one row is revealed, the rest stay bars
//   Auditor     everything is revealed
//
// WHAT IS IN THE PAGE. A hidden cell contains no text from the row: not hidden by
// CSS, absent. So the public lens of a real list is as private in the markup as it
// looks, and a bar is a fixed width, so its width tells nothing about what it hides.
// When a cell is lifted, its text is drawn at once and a bar wipes away over it; when it
// is put back, the text is removed at once and a bar wipes in. Nothing lingers.

export type LensMode = "public" | "recipient" | "auditor";

/** A person on the list. `address` and `amount` are absent when only the count is
 * known (the public receipt): such a row is always a bar. */
export interface LensRow {
  id: string;
  /** "Person 3": a label made for the row, not data from the list. Always readable. */
  label: string;
  address?: string;
  /** Zatoshi, as a decimal string. */
  amount?: string;
  memo?: string | null;
}

const MODES: readonly { mode: LensMode; label: string; caption: string }[] = [
  { mode: "public", label: "Public", caption: "What anyone can see." },
  { mode: "recipient", label: "One person", caption: "What that person can see." },
  { mode: "auditor", label: "Auditor", caption: "What someone with the viewing key sees." },
];

/** The three-way switch. The caption under it is read out when the view changes. */
export function LensSwitch({
  mode,
  onChange,
  className,
}: {
  mode: LensMode;
  onChange: (mode: LensMode) => void;
  className?: string;
}) {
  const caption = MODES.find((m) => m.mode === mode)?.caption ?? "";
  return (
    <div className={cn("space-y-2", className)}>
      <Segmented
        label="Who is looking"
        value={mode}
        onValueChange={onChange}
        options={MODES.map((m) => ({ value: m.mode, label: m.label }))}
      />
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {caption}
      </p>
    </div>
  );
}

/** How long a wipe may take, with its stagger: after this the covering bar is taken away. */
function wipeMs(index: number): number {
  return (450 + index * 60 + 150) * motionScale();
}

/** One cell of one row: a bar, or what is under it. It watches for a change of its own, so
 * only cells that change move, and nothing moves the first time the list is drawn. */
function Cell({ revealed, index, width, children }: { revealed: boolean; index: number; width: string; children: ReactNode }) {
  const [was, setWas] = useState(revealed);
  // "out": the bar is lifting over text just drawn. "in": a bar is being put back.
  const [moving, setMoving] = useState<"in" | "out" | null>(null);
  if (revealed !== was) {
    setWas(revealed);
    setMoving(motionScale() > 0 ? (revealed ? "out" : "in") : null);
  }
  useEffect(() => {
    if (moving === null) return;
    const timer = setTimeout(() => {
      setMoving(null);
    }, wipeMs(index));
    return () => {
      clearTimeout(timer);
    };
  }, [moving, index]);

  const style = { "--i": index } as CSSProperties;
  if (!revealed) {
    // Fixed width, no text from the row: a bar is only a bar.
    return (
      <span role="img" aria-label="hidden" className={cn("redacted h-[1.15em] align-middle", width, moving === "in" && "bar-in")} style={style}>
        &nbsp;
      </span>
    );
  }
  return (
    <span className="relative inline-block" style={style}>
      <span className={cn("rounded-sm bg-primary px-1 text-primary-foreground", moving === "out" && "reveal-in")}>{children}</span>
      {moving === "out" && (
        <span
          aria-hidden
          className="redacted bar-out"
          onAnimationEnd={() => {
            setMoving(null);
          }}
        />
      )}
    </span>
  );
}

interface LensListProps {
  rows: readonly LensRow[];
  mode: LensMode;
  /** The row revealed in the "one person" lens. */
  selectedId: string | null;
  onSelect?: (id: string) => void;
  /** The coin's name; defaults to the page's. */
  unit?: string;
  className?: string;
}

/** The list itself, in the chosen lens. A list, not a table, so it folds to a
 * phone's width without sideways scrolling. */
export function LensList({ rows, mode, selectedId, onSelect, unit, className }: LensListProps) {
  const pageUnit = useCoinUnit();
  const coin = unit ?? pageUnit;
  return (
    <ul className={cn("divide-y divide-border border-y border-border", className)}>
      {rows.map((row, index) => {
        const open = mode === "auditor" || (mode === "recipient" && row.id === selectedId);
        const address = open ? row.address : undefined;
        const amount = open && row.amount !== undefined ? formatZec(BigInt(row.amount)) : undefined;
        return (
          <li
            key={row.id}
            data-revealed={open}
            onClick={mode === "recipient" && onSelect ? () => { onSelect(row.id); } : undefined}
            className={cn(
              "row-hover grid items-center gap-x-4 gap-y-1 px-2 py-3",
              // A row with its text showing is too wide for a phone in one line: name and amount on the
              // first, the address under them. A bar row stays one line, whatever the width.
              open ? "grid-cols-[1fr_auto] sm:grid-cols-[minmax(5.5rem,auto)_1fr_auto]" : "grid-cols-[minmax(5.5rem,auto)_1fr_auto]",
              open && mode === "recipient" && "bg-primary/15",
              mode === "recipient" && onSelect && "cursor-pointer",
            )}
          >
            <span className="font-semibold">{row.label}</span>
            <span className={cn("mono min-w-0 text-sm break-all", open && "order-3 col-span-2 sm:order-none sm:col-span-1")}>
              <Cell revealed={address !== undefined} index={index} width="w-[18ch] max-w-full">
                {address !== undefined ? shortId(address, 10) : ""}
              </Cell>
            </span>
            <span className={cn("mono text-right text-base", open && "order-2 sm:order-none")}>
              <Cell revealed={amount !== undefined} index={index} width="w-[9ch]">
                {amount !== undefined ? `${amount} ${coin}` : ""}
              </Cell>
            </span>
            {open && row.memo ? (
              <span className="order-4 col-span-full text-sm text-muted-foreground sm:order-none sm:col-start-2">
                Memo: <span className="rounded-sm bg-primary px-1 text-primary-foreground">{row.memo}</span>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

interface RedactionLensProps {
  rows: readonly LensRow[];
  mode: LensMode;
  onModeChange: (mode: LensMode) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  unit?: string;
  /** Show only the first this many rows, and say how many more there are. */
  limit?: number;
  /** Said under the list, for what the lens cannot show (e.g. the receipt). */
  note?: ReactNode;
  className?: string;
}

/** The switch, the "who" control, and the list: the whole lens. */
export function RedactionLens({ rows: all, mode, onModeChange, selectedId, onSelect, unit, limit, note, className }: RedactionLensProps) {
  const rows = limit === undefined ? all : all.slice(0, limit);
  const more = all.length - rows.length;
  const whoId = useId();
  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <LensSwitch mode={mode} onChange={onModeChange} />
        {mode === "recipient" && (
          <div className="space-y-1">
            <label htmlFor={whoId} className="block text-sm font-semibold">
              Who?
            </label>
            <select
              id={whoId}
              value={selectedId ?? ""}
              onChange={(e) => {
                onSelect(e.target.value);
              }}
              className="h-11 rounded-lg border border-input bg-card px-3 text-base"
            >
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <LensList rows={rows} mode={mode} selectedId={selectedId} onSelect={onSelect} {...(unit === undefined ? {} : { unit })} />
      {more > 0 && <p className="text-sm text-muted-foreground">And {more} more, in the same view.</p>}
      {note !== undefined && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}
