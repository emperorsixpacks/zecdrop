import type { CSSProperties, ReactNode } from "react";

import type { PublicReceipt } from "@/api/types";
import { Why } from "@/components/Why";
import { Unknown, Zec } from "@/components/Zec";
import { shortId } from "@/lib/ids";
import { useInView } from "@/lib/use-in-view";

import { outputCount } from "./format";
import { RECEIPT_SOURCE_WORDING } from "./funding-source-wording";

function Station({ index, label, help, children }: { index: number; label: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <li style={{ "--i": index } as CSSProperties} className="relative pb-7 pl-9 last:pb-0">
      <span aria-hidden className="flow-dot absolute top-1 left-0 size-4 rounded-full border-[3px] border-primary bg-card" />
      <div className="flex h-6 items-center gap-1 text-sm text-muted-foreground">
        {label}
        {/* The button is 44px for fingers; it hangs over the line above and below so the three stations stay level. */}
        {help !== undefined && <span className="-my-4 inline-flex">{help}</span>}
      </div>
      <div className="text-xl font-bold tracking-tight">{children}</div>
    </li>
  );
}

/** Three stations down a line, like the lines of a receipt: where it was funded from, what
 * entered the private pool, how many outputs came out. Only what the verifier read from the chain.
 * The line fills and the stations pop in, one after the other, when it scrolls into view. */
export function FundsFlow({ receipt }: { receipt: PublicReceipt }) {
  const outputs = outputCount(receipt);
  // What the deposit spent, when the verifier said.
  const source = receipt.fundingSource === "shielded" || receipt.fundingSource === "transparent" ? receipt.fundingSource : null;
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} data-in={inView} className="flow relative">
      <div aria-hidden className="flow-line absolute top-3 bottom-[2.5rem] left-[7px] w-[3px] rounded-full bg-border">
        <i />
      </div>
      <ol aria-label="Where the funds went">
        <Station
          index={0}
          label="Funded from"
          {...(source !== null
            ? {
                help: (
                  <Why label="About the deposit">
                    <p>{RECEIPT_SOURCE_WORDING.flowHelp}</p>
                  </Why>
                ),
              }
            : {})}
        >
          {receipt.fundingAddress === null ? (
            <Unknown />
          ) : (
            <span className="mono text-lg" translate="no" title={receipt.fundingAddress}>
              {shortId(receipt.fundingAddress, 6)}
            </span>
          )}
          {source !== null && (
            <span className="block text-sm font-normal text-muted-foreground" data-testid="flow-source">
              {source === "shielded" ? RECEIPT_SOURCE_WORDING.flowShielded : RECEIPT_SOURCE_WORDING.flowTransparent}
            </span>
          )}
        </Station>
        <Station
          index={1}
          label="Into the private pool"
          help={
            <Why label="About the private pool">
              <p>The shielded pool is where Zcash keeps amounts and recipients encrypted. The chain shows how much entered it, not who got what.</p>
            </Why>
          }
        >
          <Zec zatoshi={receipt.declaredTotal} />
        </Station>
        <Station index={2} label="Out in">
          {outputs === null ? <Unknown /> : outputs === 1 ? "1 output" : `${String(outputs)} outputs`}
        </Station>
      </ol>
    </div>
  );
}
