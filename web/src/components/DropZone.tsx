import { useId, useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CSV_MAX_BYTES } from "@/features/wizard/validation";
import { cn } from "@/lib/utils";

interface DropZoneProps {
  /** The list arrived, from a file (with its name) or pasted text. Held in memory by the caller. */
  onList: (text: string, fileName: string | null) => void;
  disabled?: boolean;
  /** Not the highlighted button of the screen: another one on it is. */
  quiet?: boolean;
  /** Offered in practice mode: use the example list instead of a file of one's own. It becomes the main button. */
  onExample?: () => void;
}

/** "Drop a CSV here, or paste it." The one big, obvious place to start.
 *
 * It reads the file in the browser and hands the text to the caller. Nothing is
 * uploaded, saved or logged here. A file over the size the operator accepts is
 * refused before it is read. */
export function DropZone({ onList, disabled = false, quiet = false, onExample }: DropZoneProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { paste: useId(), problem: useId() };

  async function take(file: File | undefined) {
    if (!file) return;
    if (file.size > CSV_MAX_BYTES) {
      setProblem("That file is larger than 32 MB, the most the operator takes.");
      return;
    }
    try {
      setProblem(null);
      onList(await file.text(), file.name);
    } catch {
      setProblem("That file could not be read. Try pasting the list instead.");
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    if (!disabled) void take(event.dataTransfer.files[0]);
  }

  return (
    <div
      role="group"
      aria-label="Payout list"
      data-over={over}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={onDrop}
      className={cn(
        "rounded-(--r-card) border-2 border-dashed bg-card p-6 transition-[border-color,background-color,transform] duration-200 sm:p-10",
        // Dragging a file over it: it takes the accent and grows a little (when Lively, via motion).
        over ? "scale-[1.01] border-primary bg-primary/15" : "border-input",
      )}
    >
      <div className="space-y-5">
        <p className="text-[1.75rem] leading-tight font-bold tracking-tight">Drop a CSV here</p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void take(file);
            }}
          />
          {onExample !== undefined && (
            <Button type="button" size="lg" disabled={disabled} onClick={onExample}>
              Use the example list
            </Button>
          )}
          <Button
            type="button"
            size="lg"
            variant={quiet || onExample !== undefined ? "outline" : "default"}
            disabled={disabled}
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            Choose a file
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="px-1 underline underline-offset-4 hover:bg-transparent"
            aria-expanded={pasting}
            disabled={disabled}
            onClick={() => {
              setPasting((open) => !open);
            }}
          >
            or paste it
          </Button>
        </div>

        {pasting && (
          <div className="space-y-3">
            <Label htmlFor={ids.paste}>Paste your list</Label>
            <Textarea
              id={ids.paste}
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
              }}
              onPaste={(e) => {
                // A paste is a whole list: use it at once.
                const text = e.clipboardData.getData("text/plain");
                if (text.trim() !== "") {
                  e.preventDefault();
                  setPasted("");
                  setPasting(false);
                  onList(text, null);
                }
              }}
              rows={6}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              className="mono text-sm"
              placeholder="address,amount,memo"
              disabled={disabled}
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled || pasted.trim() === ""}
              onClick={() => {
                onList(pasted, null);
                setPasted("");
                setPasting(false);
              }}
            >
              Use this list
            </Button>
          </div>
        )}

        <p className="text-sm text-muted-foreground">Columns: address, amount, memo (optional).</p>
        {problem !== null && (
          <p id={ids.problem} role="alert" className="font-medium text-problem">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
