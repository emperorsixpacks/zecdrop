import { Badge } from "@/components/ui/badge";
import { formatTokenAmount } from "@/lib/token-amount";
import { zecFromZatoshi } from "@/lib/zec";

import type { NearPrice } from "./model";

interface PriceStatementProps {
  price: NearPrice;
  /** "preview" or a dry "quote": both create nothing. */
  kind: "preview" | "quote";
}

/** "To fund a campaign this size on mainnet you would send about X <asset>."
 *
 * NEAR Intents delivers MAINNET ZEC, so the amount the campaign receives is in ZEC
 * here whatever the campaign's own network is. The asset's amount is rounded UP
 * and shown as "about": it is a price at one moment, not a promise. */
export function PriceStatement({ price, kind }: PriceStatementProps) {
  const { token } = price;
  const youSend = formatTokenAmount(price.amountIn, token.decimals);
  const campaignGets = zecFromZatoshi(price.amountOut);
  return (
    <div className="slide-in space-y-2 border-l-4 border-accent-2 pl-4" data-testid="near-price">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="shielded">{kind === "preview" ? "Preview" : "Price quote"}</Badge>
        <span className="text-sm text-muted-foreground">
          {kind === "preview" ? "Nothing is created. There is no deposit address." : "Nothing is created yet."}
        </span>
      </div>
      <p className="text-base">
        To fund a campaign this size on mainnet ({campaignGets} ZEC) you would send about{" "}
        <strong>
          {youSend} {token.symbol}
        </strong>{" "}
        on {token.chain}.
      </p>
      <p className="text-sm text-muted-foreground">Prices change, and the amount is rounded up. A real quote can differ.</p>
    </div>
  );
}
