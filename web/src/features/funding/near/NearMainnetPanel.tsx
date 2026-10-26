import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { OperatorApiError } from "@/api/operator/client";
import { CopyButton } from "@/components/CopyButton";
import { Why } from "@/components/Why";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTokenAmount } from "@/lib/token-amount";

import { AssetPicker } from "./AssetPicker";
import { NearFailure } from "./NearFailure";
import { NearStatusCard } from "./NearStatusCard";
import type { NearApi, NearDeposit } from "./model";
import { PriceStatement } from "./PriceStatement";
import { describeNearStatus } from "./status";

const POLL_MS = 5_000;

/** What the operator accepts for a refund address: plain letters, digits and . - _ : + */
const REFUND_ADDRESS = /^[A-Za-z0-9._:+-]{1,200}$/u;

interface NearMainnetPanelProps {
  api: NearApi;
  campaignId: string;
}

/** The operator said there is no swap for this campaign yet. */
function noSwapYet(error: unknown): boolean {
  return error instanceof OperatorApiError && error.api?.code === "no_live_quote";
}

/** For a MAINNET campaign: get a price (nothing created), then, after a separate
 * confirmation, a real quote with a deposit address, then follow the swap.
 *
 * Two deliberate steps: a price quote is free and creates nothing; the deposit
 * address is where real money goes, so asking for it needs an explicit "I
 * understand". Whatever the service reports, the campaign is funded only when
 * the operator sees the coin on chain, and the page says so throughout.
 *
 * On opening, the panel first asks where a swap stands: the operator keeps the
 * deposit address, so one that was already created is shown again (closing the row or
 * reloading the page must never strand it). */
export function NearMainnetPanel({ api, campaignId }: NearMainnetPanelProps) {
  const client = useQueryClient();
  const depositKey = ["near", "deposit", campaignId] as const;
  const [tokenId, setTokenId] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [understood, setUnderstood] = useState(false);
  const understoodId = useId();
  const refundId = useId();
  const refundHintId = useId();
  // Kept in memory for as long as the page lives, so closing the row does not lose it.
  const [deposit, setDeposit] = useState<NearDeposit | undefined>(() => client.getQueryData<NearDeposit>(depositKey));

  const tokens = useQuery({
    queryKey: ["near", "tokens"],
    queryFn: ({ signal }) => api.tokens(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  // Where the swap stands, if there is one. Followed until the service says it has ended.
  const status = useQuery({
    queryKey: ["near", "status", campaignId],
    queryFn: ({ signal }) => api.status({ campaignId }, signal),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== undefined && describeNearStatus(data.status).keepPolling ? POLL_MS : false;
    },
  });
  const refundValid = REFUND_ADDRESS.test(refundTo.trim());
  const quote = useMutation({ mutationFn: (id: string) => api.dryQuote({ campaignId, tokenId: id, refundTo: refundTo.trim() }) });
  const live = useMutation({
    mutationFn: (id: string) => api.liveQuote({ campaignId, tokenId: id }),
    onSuccess: (created) => {
      client.setQueryData(depositKey, created);
      setDeposit(created);
      void status.refetch();
    },
  });

  const swapExists = deposit !== undefined || status.data !== undefined;

  if (swapExists) {
    return (
      <div className="space-y-4">
        {deposit !== undefined ? (
          <DepositInstructions deposit={deposit} />
        ) : (
          status.data !== undefined && <ResumedSwap address={status.data.depositAddress} validUntil={status.data.validUntil} />
        )}
        {status.isError && <NearFailure error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />}
        {status.data !== undefined ? (
          <NearStatusCard status={status.data} />
        ) : (
          !status.isError && (
            <p role="status" className="text-base text-muted-foreground">
              Asking the service where the swap stands…
            </p>
          )
        )}
      </div>
    );
  }

  if (status.isPending) {
    return (
      <div role="status" aria-busy="true">
        <p className="sr-only">Checking whether a swap is already under way</p>
        <Skeleton className="h-11 w-64" />
      </div>
    );
  }

  if (status.isError && !noSwapYet(status.error)) {
    return <NearFailure error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />;
  }

  return (
    <div className="space-y-5">
      <p className="text-base">
        Pay with another coin. The service swaps it into ZEC.{" "}
        <Why inline label="How paying with another coin works">
          <p>
            The service swaps what you send into ZEC and delivers it to this campaign&apos;s funding address. First get a price.
            That creates nothing.
          </p>
        </Why>
      </p>

      {tokens.isPending ? (
        <div role="status" aria-busy="true">
          <p className="sr-only">Loading the list of assets</p>
          <Skeleton className="h-11 w-64" />
        </div>
      ) : tokens.isError ? (
        <NearFailure error={tokens.error} onRetry={() => void tokens.refetch()} retrying={tokens.isFetching} />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (tokenId !== "" && refundValid) quote.mutate(tokenId);
          }}
        >
          <AssetPicker
            tokens={tokens.data}
            value={tokenId}
            onChange={(id) => {
              setTokenId(id);
              setUnderstood(false);
              quote.reset();
              live.reset();
            }}
            disabled={quote.isPending || live.isPending}
          />
          <div className="space-y-1.5">
            <Label htmlFor={refundId}>Your refund address</Label>
            <Input
              id={refundId}
              value={refundTo}
              onChange={(e) => {
                setRefundTo(e.target.value);
                setUnderstood(false);
                quote.reset();
                live.reset();
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={quote.isPending || live.isPending}
              aria-describedby={refundHintId}
              className="mono sm:max-w-md"
            />
            <p id={refundHintId} className="text-sm text-muted-foreground">
              On the chain you pay from. A late or short deposit returns here.
            </p>
          </div>
          <Button type="submit" variant="outline" disabled={tokenId === "" || !refundValid || quote.isPending || live.isPending}>
            {quote.isPending ? "Asking the service…" : "Get a price quote"}
          </Button>
        </form>
      )}

      {quote.isError && <NearFailure error={quote.error} />}
      {quote.isSuccess && (
        <div className="space-y-5">
          <PriceStatement price={quote.data} kind="quote" />
          <div className="space-y-3 border-l-4 border-highlighter pl-4">
            <h3 className="text-lg font-bold">Next: a deposit address</h3>
            <p className="text-base">
              Asking for the real quote creates a deposit address, and what you send there is real money. Only go on if you
              mean to fund this campaign now.
            </p>
            <label htmlFor={understoodId} className="flex min-h-11 cursor-pointer items-start gap-3 text-base">
              <input
                id={understoodId}
                type="checkbox"
                className="mt-1 size-5 shrink-0 accent-link"
                checked={understood}
                onChange={(e) => {
                  setUnderstood(e.target.checked);
                }}
              />
              <span>I understand that this creates a deposit address, and that what I send to it is real money.</span>
            </label>
            <Button
              disabled={!understood || live.isPending}
              onClick={() => {
                live.mutate(tokenId);
              }}
            >
              {live.isPending ? "Creating the deposit address…" : "Create the deposit address"}
            </Button>
            {live.isError && <NearFailure error={live.error} />}
          </div>
        </div>
      )}
    </div>
  );
}

function AddressLine({ label, value, testId, copyLabel }: { label: string; value: string; testId: string; copyLabel: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-semibold text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-3">
        <code className="mono text-base break-all" data-testid={testId}>
          {value}
        </code>
        <CopyButton value={value} label={copyLabel} />
      </div>
    </div>
  );
}

function DepositInstructions({ deposit }: { deposit: NearDeposit }) {
  const { token } = deposit;
  const amount = formatTokenAmount(deposit.amountIn, token.decimals);
  return (
    <div className="slide-in space-y-4 border-l-4 border-accent-2 pl-4" data-testid="near-deposit">
      <h3 className="text-lg font-bold">
        Send {amount} {token.symbol} on {token.chain}
      </h3>
      <AddressLine label="Deposit address" value={deposit.depositAddress} testId="near-deposit-address" copyLabel="Copy deposit address" />
      {deposit.depositMemo !== null && (
        <AddressLine label="Memo (required with this deposit)" value={deposit.depositMemo} testId="near-deposit-memo" copyLabel="Copy deposit memo" />
      )}
      {deposit.deadline !== null && !Number.isNaN(Date.parse(deposit.deadline)) && (
        <p className="text-base">
          Send it before <time dateTime={deposit.deadline}>{new Date(deposit.deadline).toLocaleString()}</time>.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        A late or short deposit goes back to <span className="mono break-all">{deposit.refundTo}</span>, minus fees.
      </p>
      <p className="text-sm text-muted-foreground">
        Send from a wallet you control, in one transfer, on the chain named above. The amount is a quote: send what is shown.
      </p>
    </div>
  );
}

/** A swap that was started before this page was opened (or reloaded): all the operator keeps is the address. */
function ResumedSwap({ address, validUntil }: { address: string; validUntil: string | null }) {
  return (
    <div className="slide-in space-y-4 border-l-4 border-accent-2 pl-4" data-testid="near-deposit">
      <h3 className="text-lg font-bold">A swap for this campaign is already under way</h3>
      <AddressLine label="Deposit address" value={address} testId="near-deposit-address" copyLabel="Copy deposit address" />
      {validUntil !== null && !Number.isNaN(Date.parse(validUntil)) && (
        <p className="text-base">
          It is good until <time dateTime={validUntil}>{new Date(validUntil).toLocaleString()}</time>.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        The amount and the coin were shown when it was created. If you did not note them, wait for the address to lapse and ask
        for a new quote.
      </p>
    </div>
  );
}
