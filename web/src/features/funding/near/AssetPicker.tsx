import { useId, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { NearToken } from "./model";

interface AssetPickerProps {
  tokens: readonly NearToken[];
  value: string;
  onChange: (tokenId: string) => void;
  disabled?: boolean;
}

/** Choose the asset the funder would pay with. The list is long (hundreds), so
 * it can be narrowed by typing part of a name or a chain. */
export function AssetPicker({ tokens, value, onChange, disabled = false }: AssetPickerProps) {
  const ids = { filter: useId(), select: useId(), count: useId() };
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const sorted = [...tokens].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.chain.localeCompare(b.chain));
    const matching = needle === "" ? sorted : sorted.filter((t) => `${t.symbol} ${t.chain}`.toLowerCase().includes(needle));
    // Never drop the chosen one from the list, or the select would silently change what is chosen.
    const chosen = tokens.find((t) => t.id === value);
    return chosen !== undefined && !matching.includes(chosen) ? [chosen, ...matching] : matching;
  }, [tokens, filter, value]);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={ids.filter}>Find an asset</Label>
        <Input
          id={ids.filter}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
          placeholder="e.g. USDC, or a chain such as sol"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-describedby={ids.count}
          className="sm:max-w-xs"
        />
        <p id={ids.count} className="text-sm text-muted-foreground" role="status">
          {shown.length === 1 ? "1 asset" : `${String(shown.length)} assets`}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={ids.select}>Asset to pay with</Label>
        <select
          id={ids.select}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          disabled={disabled}
          className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base text-foreground sm:max-w-xs"
        >
          <option value="">Choose an asset…</option>
          {shown.map((token) => (
            <option key={token.id} value={token.id}>
              {token.symbol} on {token.chain}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
