import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Why } from "@/components/Why";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { zecFromZatoshi } from "@/lib/zec";

import { AssetPicker } from "./AssetPicker";
import { NearFailure } from "./NearFailure";
import type { NearApi } from "./model";
import { PriceStatement } from "./PriceStatement";

interface NearPreviewPanelProps {
  api: NearApi;
  /** What the campaign needs, in zatoshi: the size of campaign to price. */
  fundingRequired: string;
}

/** For a TESTNET campaign: what it would cost, in another asset, to fund a
 * campaign this size on mainnet. A real price from the service, labelled a
 * preview. It creates nothing and shows no deposit address. */
export function NearPreviewPanel({ api, fundingRequired }: NearPreviewPanelProps) {
  const [tokenId, setTokenId] = useState("");
  const tokens = useQuery({
    queryKey: ["near", "tokens"],
    queryFn: ({ signal }) => api.tokens(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const preview = useMutation({
    mutationFn: (id: string) => api.preview({ tokenId: id, fundingRequired }),
  });

  return (
    <div className="space-y-4">
      <p className="text-base">
        Price check only. NEAR Intents works with mainnet ZEC.{" "}
        <Why inline label="Why a price check only">
          <p>
            NEAR Intents works with <strong>mainnet ZEC only</strong>, so it cannot fund this testnet campaign. This asks the
            service what it would cost, in another asset, to fund a campaign of this size ({zecFromZatoshi(fundingRequired)} ZEC)
            on mainnet. It creates nothing.
          </p>
        </Why>
      </p>

      {tokens.isPending ? (
        <div role="status" aria-busy="true" className="space-y-2">
          <p className="sr-only">Loading the list of assets</p>
          <Skeleton className="h-11 w-64" />
        </div>
      ) : tokens.isError ? (
        <NearFailure error={tokens.error} onRetry={() => void tokens.refetch()} retrying={tokens.isFetching} />
      ) : tokens.data.length === 0 ? (
        <p className="text-base text-muted-foreground">The service lists no assets right now.</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (tokenId !== "") preview.mutate(tokenId);
          }}
        >
          <AssetPicker
            tokens={tokens.data}
            value={tokenId}
            onChange={(id) => {
              setTokenId(id);
              preview.reset();
            }}
            disabled={preview.isPending}
          />
          <Button type="submit" variant="outline" disabled={tokenId === "" || preview.isPending}>
            {preview.isPending ? "Asking the service…" : "Show a price preview"}
          </Button>
        </form>
      )}

      {preview.isError && <NearFailure error={preview.error} />}
      {preview.isSuccess && <PriceStatement price={preview.data} kind="preview" />}
    </div>
  );
}
