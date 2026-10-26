import { useEffect, useId, useRef, useState } from "react";

import { CountInt, CountUp } from "@/components/CountUp";
import { Segmented } from "@/components/Segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_MEMO_BYTES, memoBytes } from "@/lib/memo";
import { useCoinUnit } from "@/lib/units";
import { cn } from "@/lib/utils";
import { formatZec, parsePositiveZec } from "@/lib/zec";

import { useWizardDraft } from "./draft";
import { addressHint, amountProblem, cleanMemo, listTotal, personProblems, totalProblem, type AmountMode, type Person } from "./people";

const MODES = [
  { value: "each", label: "Set each" },
  { value: "even", label: "Even" },
  { value: "lucky", label: "Lucky" },
] as const satisfies readonly { value: AmountMode; label: string }[];

/** A note this long shows how much room is left. */
const MEMO_COUNT_FROM = 400;

type Field = "address" | "amount" | "memo";

interface PeopleListProps {
  /** Show every problem now, not only those of fields already left: the person pressed Continue. */
  showAll: boolean;
  /** What the operator said about each person's line, by person key: its sentences only. */
  operatorProblems: ReadonlyMap<string, readonly string[]>;
  /** The operator's network, for the hint about an address that looks wrong for it. */
  network: "testnet" | "mainnet" | null;
  disabled: boolean;
  /** The list changed, so the operator's old verdict no longer applies. */
  onChange: () => void;
}

/** The payout list built in the page, one person at a time (REQ-IMP-002): an address, an amount and the note they will
 * see, with the amounts set one by one or split from a total, evenly or at random.
 *
 * It holds the person's own list while they work on it, in the page's memory (the wizard's draft) and nowhere else,
 * and no sentence it builds repeats an address, an amount or a note. Its problems are hints until Continue: the
 * operator's importer is the check that counts, and what it says about a line appears with the person on it. */
export function PeopleList({ showAll, operatorProblems, network, disabled, onChange }: PeopleListProps) {
  const unit = useCoinUnit();
  const people = useWizardDraft((s) => s.people);
  const mode = useWizardDraft((s) => s.amountMode);
  const splitTotal = useWizardDraft((s) => s.splitTotal);
  const { updatePerson, addPerson, removePerson, setAmountMode, setSplitTotal, shuffle } = useWizardDraft.getState();
  const ids = { total: useId(), totalHelp: useId() };

  // A field shows its problem once it has been left, or once Continue was pressed.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (key: string, field: Field | "total") => {
    setTouched((was) => (was.has(`${key}:${field}`) ? was : new Set(was).add(`${key}:${field}`)));
  };
  const shows = (key: string, field: Field | "total") => showAll || touched.has(`${key}:${field}`);

  // Focus follows an add or a remove, and a polite line says what happened.
  const addressInputs = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  // Who gets the focus once the list has changed: the person added, or the one beside the person removed ("" for the
  // add button).
  const focusNext = useRef<string | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    const key = focusNext.current;
    if (key === null) return;
    focusNext.current = null;
    (addressInputs.current.get(key) ?? addButton.current)?.focus();
  }, [people]);

  const changed = () => {
    onChange();
  };

  const { total } = listTotal(people);
  // Amounts typed that cannot be read yet; an amount not typed yet is not worth a word.
  const unreadable = people.filter((person) => person.amount.trim() !== "" && amountProblem(person.amount) !== null).length;
  const split = mode !== "each";
  const totalWrong = split ? totalProblem(splitTotal, people.length, mode) : null;
  const shownTotalProblem = totalWrong !== null && shows("list", "total") ? totalWrong : null;

  let splitNote: string | null = null;
  if (split && totalWrong === null) {
    if (mode === "lucky") splitNote = "Random shares: they can't be worked out from the total.";
    else {
      const share = people[0]?.amount ?? "";
      const typed = parsePositiveZec(splitTotal.trim());
      splitNote =
        total === typed
          ? `Each gets ${share} ${unit}. Equal shares can be worked out from the total.`
          : `Each gets ${share} ${unit}. That is ${formatZec(total)} ${unit} in all, a little less than you typed, so the shares stay equal.`;
    }
  }

  return (
    <div className="space-y-8" data-testid="people-list" data-recipient-preview>
      <div className="flex flex-wrap items-end gap-x-10 gap-y-2">
        <p className="display text-[1.75rem] sm:text-[2.75rem]" data-testid="payout-count">
          <CountInt value={people.length} /> {people.length === 1 ? "person" : "people"}
        </p>
        <p className="display text-[1.75rem] sm:text-[2.75rem]" data-testid="payout-total">
          <CountUp zatoshi={total} /> <span className="text-[1.25rem] font-semibold tracking-normal text-muted-foreground">{unit}</span>
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          {/* The control names itself to assistive technology; this is the same word for the eye. */}
          <p aria-hidden className="text-base font-semibold">
            Amounts
          </p>
          <Segmented
            label="Amounts"
            value={mode}
            options={MODES}
            onValueChange={(next) => {
              setAmountMode(next);
              changed();
            }}
          />
        </div>
        {split && (
          <div className="space-y-2">
            <Label htmlFor={ids.total}>Total to split</Label>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Input
                  id={ids.total}
                  value={splitTotal}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  aria-invalid={shownTotalProblem !== null}
                  aria-describedby={ids.totalHelp}
                  className="mono w-40"
                  onChange={(e) => {
                    setSplitTotal(e.target.value);
                    changed();
                  }}
                  onBlur={() => {
                    touch("list", "total");
                  }}
                />
                <span className="text-base font-semibold text-muted-foreground">{unit}</span>
              </div>
              {mode === "lucky" && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || totalWrong !== null}
                  onClick={() => {
                    shuffle();
                    changed();
                    setSaid("New shares drawn.");
                  }}
                >
                  Shuffle again
                </Button>
              )}
            </div>
            <p id={ids.totalHelp} className={cn("text-sm", shownTotalProblem !== null ? "font-medium text-problem" : "text-muted-foreground")}>
              {shownTotalProblem ?? splitNote ?? (mode === "lucky" ? "Random shares of a total, like lucky money." : "Everyone gets the same share of a total.")}
            </p>
          </div>
        )}
      </div>

      <ol className="divide-y divide-border border-y border-border">
        {people.map((person, index) => (
          <PersonRow
            key={person.key}
            person={person}
            index={index}
            problems={personProblems(people, index, mode)}
            hint={addressHint(person.address, network)}
            operator={operatorProblems.get(person.key) ?? []}
            split={split}
            unit={unit}
            network={network}
            disabled={disabled}
            canRemove={people.length > 1}
            shows={(field) => shows(person.key, field)}
            onLeave={(field) => {
              touch(person.key, field);
            }}
            registerAddress={(input) => {
              if (input === null) addressInputs.current.delete(person.key);
              else addressInputs.current.set(person.key, input);
            }}
            onEdit={(change) => {
              updatePerson(person.key, change);
              changed();
            }}
            onRemove={() => {
              const next = people[index + 1] ?? people[index - 1];
              removePerson(person.key);
              changed();
              setSaid(`Person ${String(index + 1)} removed.`);
              focusNext.current = next?.key ?? "";
            }}
          />
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            const key = addPerson();
            changed();
            setSaid(`Person ${String(people.length + 1)} added.`);
            focusNext.current = key;
          }}
        >
          Add a person
        </Button>
        {unreadable > 0 && !split && (
          <p className="text-sm text-muted-foreground">
            {unreadable === 1 ? "1 amount is" : `${String(unreadable)} amounts are`} not in the total yet.
          </p>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}

interface PersonRowProps {
  person: Person;
  index: number;
  problems: ReturnType<typeof personProblems>;
  hint: string | null;
  operator: readonly string[];
  split: boolean;
  unit: string;
  network: "testnet" | "mainnet" | null;
  disabled: boolean;
  canRemove: boolean;
  shows: (field: Field) => boolean;
  onLeave: (field: Field) => void;
  registerAddress: (input: HTMLInputElement | null) => void;
  onEdit: (change: Partial<Omit<Person, "key">>) => void;
  onRemove: () => void;
}

function PersonRow({ person, index, problems, hint, operator, split, unit, network, disabled, canRemove, shows, onLeave, registerAddress, onEdit, onRemove }: PersonRowProps) {
  const number = index + 1;
  const ids = { name: useId(), address: useId(), addressHelp: useId(), amount: useId(), amountHelp: useId(), memo: useId(), memoHelp: useId() };
  const addressProblem = shows("address") ? problems.address : null;
  const amountProblem = shows("amount") ? problems.amount : null;
  const memoProblem = shows("memo") ? problems.memo : null;
  const addressNote = addressProblem ?? (shows("address") ? hint : null);
  const bytes = memoBytes(cleanMemo(person.memo));

  return (
    <li className={cn("space-y-4 py-5", operator.length > 0 && "bg-problem/10 px-2")}>
      <div role="group" aria-labelledby={ids.name} className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <p id={ids.name} className="text-base font-semibold">
            Person {number}
          </p>
          {canRemove && (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`Remove person ${String(number)}`} onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor={ids.address}>Address</Label>
          <Input
            ref={registerAddress}
            id={ids.address}
            value={person.address}
            placeholder={`Starts with ${network === "testnet" ? "utest1" : "u1"}`}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={addressProblem !== null}
            aria-describedby={addressNote === null ? undefined : ids.addressHelp}
            className="mono text-sm"
            onChange={(e) => {
              onEdit({ address: e.target.value });
            }}
            onBlur={() => {
              onLeave("address");
            }}
          />
          {addressNote !== null && (
            <p id={ids.addressHelp} className={cn("text-sm font-medium", addressProblem !== null ? "text-problem" : "text-foreground")}>
              {addressNote}
            </p>
          )}
        </div>

        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="space-y-2">
            {split ? (
              <>
                <p className="text-base leading-snug font-semibold" id={ids.amount}>
                  Amount
                </p>
                <p className="mono flex h-11 items-center text-base" aria-labelledby={ids.amount}>
                  {person.amount === "" ? "Not set yet" : `${person.amount} ${unit}`}
                </p>
              </>
            ) : (
              <>
                <Label htmlFor={ids.amount}>Amount</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={ids.amount}
                    value={person.amount}
                    placeholder="0.5"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    aria-invalid={amountProblem !== null}
                    aria-describedby={amountProblem === null ? undefined : ids.amountHelp}
                    className="mono"
                    onChange={(e) => {
                      onEdit({ amount: e.target.value });
                    }}
                    onBlur={() => {
                      onLeave("amount");
                    }}
                  />
                  <span className="text-base font-semibold text-muted-foreground">{unit}</span>
                </div>
                {amountProblem !== null && (
                  <p id={ids.amountHelp} className="text-sm font-medium text-problem">
                    {amountProblem}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={ids.memo}>{"Note they'll see"}</Label>
            <Input
              id={ids.memo}
              value={person.memo}
              placeholder="Optional, like Happy Eid"
              autoComplete="off"
              disabled={disabled}
              aria-invalid={memoProblem !== null}
              aria-describedby={memoProblem !== null || bytes >= MEMO_COUNT_FROM ? ids.memoHelp : undefined}
              onChange={(e) => {
                onEdit({ memo: e.target.value });
              }}
              onBlur={() => {
                onLeave("memo");
              }}
            />
            {(memoProblem !== null || bytes >= MEMO_COUNT_FROM) && (
              <p id={ids.memoHelp} className={cn("text-sm", memoProblem !== null ? "font-medium text-problem" : "text-muted-foreground")}>
                {memoProblem ?? `${String(bytes)} of ${String(MAX_MEMO_BYTES)} bytes`}
              </p>
            )}
          </div>
        </div>

        {operator.map((message) => (
          <p key={message} className="text-base font-medium text-problem">
            {message}
          </p>
        ))}
      </div>
    </li>
  );
}
