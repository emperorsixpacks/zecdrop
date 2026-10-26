import { CopyButton } from "@/components/CopyButton";
import type { ZecNetwork } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";

import { shortId } from "@/lib/ids";

interface TxActionsProps {
  txid: string;
  network: ZecNetwork;
  batchIndex: number;
}

/** A transaction id, shortened for reading, with copy and explorer actions.
 * The full id is always one tap away (copy) and in the tooltip. */
export function TxActions({ txid, network, batchIndex }: TxActionsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="font-mono text-sm" title={txid} translate="no">
        {shortId(txid)}
      </code>
      <CopyButton value={txid} label={`Copy transaction id for batch ${String(batchIndex)}`} />
      <a
        href={explorerTxUrl(network, txid)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-medium text-link underline underline-offset-4"
      >
        Explorer{" "}
        <span className="sr-only">for batch {batchIndex} (opens in a new tab)</span>
      </a>
    </div>
  );
}
