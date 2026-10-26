import { useState, type CSSProperties, type ReactNode } from "react";

import { CountInt, CountUp } from "@/components/CountUp";
import { Button } from "@/components/ui/button";
import { shortId } from "@/lib/ids";
import type { Preview } from "@/lib/csv-preview";
import { useCoinUnit } from "@/lib/units";
import { cn } from "@/lib/utils";
import { formatZec } from "@/lib/zec";

/** How many rows are drawn. The whole list is still read and counted. */
const ROWS_SHOWN = 50;

interface PayoutPreviewProps {
  preview: Extract<Preview, { kind: "rows" }>;
  /** What the operator said is wrong, by line: the sentences only, never the row. */
  problems: ReadonlyMap<number, readonly string[]>;
  /** Said between the totals and the rows (the operator's verdict). */
  notice?: ReactNode;
}

/** The list as the person pasted it: how many people, the total counting up, and
 * the rows as ruled lines, numbered 1 to N (a problem names the CSV's own line, which
 * is the number the operator uses). A row whose amount cannot be read says so in the
 * row at once, and is left out of the total; the operator's own problems appear in the
 * row they are about once it has read the list.
 *
 * This holds the person's own list while they work on it, in the page's memory and
 * nowhere else. It is gone once the campaign is created (RecipientsStage clears the
 * list), and no error message is built from a row. */
export function PayoutPreview({ preview, problems, notice }: PayoutPreviewProps) {
  const unit = useCoinUnit();
  const { rows } = preview;
  const people = rows.length;
  const [onlyProblems, setOnlyProblems] = useState(false);
  const numbered = rows.map((row, index) => ({ row, number: index + 1 }));
  const hasProblem = ({ row }: { row: (typeof rows)[number] }) => problems.has(row.line) || row.amountProblem !== null;
  const withProblems = numbered.filter(hasProblem);
  const list = onlyProblems ? withProblems : numbered;
  const shown = list.slice(0, ROWS_SHOWN);

  return (
    <div className="space-y-6" data-testid="payout-table" data-recipient-preview>
      <div className="flex flex-wrap items-end gap-x-10 gap-y-2">
        <p className="display text-[1.75rem] sm:text-[2.75rem]" data-testid="payout-count">
          <CountInt value={people} /> {people === 1 ? "person" : "people"}
        </p>
        <p className="display text-[1.75rem] sm:text-[2.75rem]" data-testid="payout-total">
          <CountUp zatoshi={preview.total} /> <span className="text-[1.25rem] font-semibold tracking-normal text-muted-foreground">{unit}</span>
        </p>
      </div>
      {preview.unreadableAmounts > 0 && (
        <p className="text-base font-medium text-problem">
          {preview.unreadableAmounts === 1 ? "1 amount" : `${String(preview.unreadableAmounts)} amounts`} could not be read and{" "}
          {preview.unreadableAmounts === 1 ? "is" : "are"} left out of the total.
        </p>
      )}
      {notice}
      {withProblems.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={onlyProblems}
          onClick={() => {
            setOnlyProblems((on) => !on);
          }}
        >
          {onlyProblems ? "Show all rows" : `Show only the ${String(withProblems.length)} ${withProblems.length === 1 ? "row" : "rows"} with problems`}
        </Button>
      )}
      <ul className="divide-y divide-border border-y border-border">
        {shown.map(({ row, number }) => {
          // The operator's words once it has spoken; until then, ours for an amount that cannot be read.
          const said = problems.get(row.line) ?? [];
          const wrong = said.length > 0 ? said : row.amountProblem !== null ? [row.amountProblem] : [];
          const unreadable = row.amount === null;
          return (
            <li
              key={row.line}
              style={{ "--i": Math.min(number - 1, 12) } as CSSProperties}
              className={cn(
                "row-hover slide-in grid grid-cols-[2rem_1fr_auto] items-baseline gap-x-3 gap-y-1 px-2 py-3 sm:grid-cols-[3.5rem_1fr_auto] sm:gap-x-4",
                wrong.length > 0 && "bg-problem/10",
              )}
            >
              <span className="mono text-sm text-muted-foreground">{number}</span>
              <span className="mono min-w-0 text-sm">{shortId(row.address, 6)}</span>
              <span className={cn("mono text-right text-base", unreadable && "font-semibold text-problem")}>
                {row.amount === null ? (row.amountText === "" ? "no amount" : row.amountText) : `${formatZec(row.amount)} ${unit}`}
              </span>
              {row.memo !== "" && <span className="col-span-2 col-start-2 truncate text-sm text-muted-foreground">{row.memo}</span>}
              {wrong.map((message) => (
                <span key={message} className="slide-in col-span-2 col-start-2 text-base font-medium text-problem">
                  Line {row.line}: {message}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
      {list.length > ROWS_SHOWN && (
        <p className="text-sm text-muted-foreground">And {list.length - ROWS_SHOWN} more. All of them are counted.</p>
      )}
    </div>
  );
}
