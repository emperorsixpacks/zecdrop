import { useId, useState } from "react";

import type { OperatorCampaign } from "@/api/operator/schemas";
import { CopyButton } from "@/components/CopyButton";
import { QrCode } from "@/components/QrCode";
import { UnitNote } from "@/components/UnitProvider";
import { Why } from "@/components/Why";
import { Zec } from "@/components/Zec";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { operatorNearApi } from "@/features/funding/near/api";
import { NearFundingPanel } from "@/features/funding/near/NearFundingPanel";
import { shortId } from "@/lib/ids";
import { fundingPaymentUri } from "@/lib/payment-uri";
import { phaseSentence } from "@/lib/phase";
import { useMediaQuery } from "@/lib/use-media";

import { DepositSource } from "./DepositSource";
import { FailureNotice } from "./FailureNotice";
import { FUNDING_SOURCE_WORDING } from "./funding-source-wording";
import { useCheckFunding, useHealth } from "./hooks";
import { MockFunding } from "./MockFunding";

/** What has been seen of a deposit so far, in the operator's own figures. */
function Progress({ campaign }: { campaign: OperatorCampaign }) {
  const seen = campaign.fundingProgress;
  if (seen === null) {
    return <p className="text-base text-muted-foreground">No deposit seen yet. This page checks again every few seconds.</p>;
  }
  return (
    <div className="space-y-1 text-base">
      <p>
        A deposit of <Zec zatoshi={seen.amount} /> has {seen.confirmations} of {seen.requiredDepth} confirmations.
      </p>
      <DepositSource source={campaign.fundingSource} pretend={false} quiet />
      {!seen.sufficient && (
        <p className="text-problem">
          That is less than the <Zec zatoshi={campaign.fundingRequired} /> this campaign needs, so it does not count. Send the rest in a
          single deposit of at least that amount.
        </p>
      )}
    </div>
  );
}

/** From this wide, the QR code sits beside the address. Narrower, it is behind a button: a person on the phone itself copies
 * the address instead, and the code (and the library that draws it) is not loaded until it is asked for. */
const QR_BESIDE = "(min-width: 48rem)";

function RealChainFunding({ campaign, address }: { campaign: OperatorCampaign; address: string }) {
  const check = useCheckFunding(campaign.id);
  const headingId = useId();
  const qrId = useId();
  const wide = useMediaQuery(QR_BESIDE);
  const [qrOpen, setQrOpen] = useState(false);
  // A link that opens a wallet app with the address and amount filled in. Null if either looks wrong.
  const walletLink = fundingPaymentUri(address, campaign.fundingRequired);
  // On mainnet the deposit should be exactly what is asked: a surplus comes back as change to an address this
  // operator cannot spend there, so it would stay stuck.
  const exact = campaign.network === "mainnet";
  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <h2 id={headingId} className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
        Is it funded?
      </h2>
      <p className="flex max-w-[64ch] flex-wrap items-center gap-x-1 text-base">
        <span>
          Send {exact ? "exactly" : "at least"} <strong><Zec zatoshi={campaign.fundingRequired} /></strong> to this address, in one
          deposit.
        </span>
        <Why label="About the deposit">
          <p>That is the declared total plus fees. The funding address and the amount are public; see how privacy works.</p>
        </Why>
      </p>
      <p className="flex max-w-[64ch] flex-wrap items-center gap-x-1 text-base" data-testid="funding-ask">
        <span>
          <strong>{FUNDING_SOURCE_WORDING.ask}</strong> {FUNDING_SOURCE_WORDING.askWhy}
        </span>
        <Why label="About paying from a shielded balance">
          <div className="space-y-2">
            {FUNDING_SOURCE_WORDING.askMore.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </Why>
      </p>
      {exact && (
        <p className="max-w-[64ch] text-base">
          Send exactly that amount. A surplus comes back as change to an address this operator cannot spend on mainnet.
        </p>
      )}
      <div className="md:grid md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-10">
        <div className="space-y-2">
          <p className="mono text-lg break-all" data-testid="funding-address">
            {address}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton value={address} label="Copy funding address" />
            {walletLink !== null && (
              <Button asChild variant="outline" size="sm">
                <a href={walletLink}>Open in wallet</a>
              </Button>
            )}
            {walletLink !== null && !wide && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={qrOpen}
                aria-controls={qrOpen ? qrId : undefined}
                onClick={() => {
                  setQrOpen((open) => !open);
                }}
              >
                {qrOpen ? "Hide QR code" : "Show QR code"}
              </Button>
            )}
          </div>
          {walletLink !== null && (
            <p className="max-w-[64ch] text-sm text-muted-foreground">
              Opens a wallet app that handles zcash links. If nothing opens, copy the address.
            </p>
          )}
        </div>
        {/* The same request the wallet link carries, nothing more: this address and the exact amount. Only where there is a link. */}
        {walletLink !== null && (wide || qrOpen) && (
          <figure id={qrId} data-testid="funding-qr" className="mt-4 w-full max-w-[18rem] space-y-2 md:mt-0 md:w-fit">
            <QrCode text={walletLink} label="QR code for this deposit: the funding address and the exact amount" className="md:w-auto" />
            {/* The caption wraps to the width of the code and never makes the figure wider than it. */}
            <figcaption className="w-0 min-w-full text-sm text-muted-foreground">
              Scan with a Zcash wallet on your phone: it fills in this address and the exact amount.
            </figcaption>
          </figure>
        )}
      </div>
      <NearFundingPanel
        api={operatorNearApi}
        campaign={{ id: campaign.id, network: campaign.network, fundingRequired: campaign.fundingRequired }}
      />
      <div role="status" aria-live="polite" className="space-y-2">
        <p className="flex items-center gap-3 text-lg font-bold">
          <span aria-hidden className="size-3 rounded-full border border-foreground bg-primary motion-safe:animate-pulse" />
          {phaseSentence({ phase: "awaiting_funding" })}
        </p>
        <Progress campaign={campaign} />
      </div>
      <Button
        variant="outline"
        onClick={() => {
          check.mutate();
        }}
        disabled={check.isPending}
      >
        {check.isPending ? "Checking…" : "Check for the deposit now"}
      </Button>
      {check.isError && <FailureNotice error={check.error} />}
      <UnitNote />
    </section>
  );
}

/** Where the money comes from: what is already there, the address to send to on a
 * real chain, or the pretend-deposit form on the mock chain. */
export function FundingPanel({ campaign }: { campaign: OperatorCampaign }) {
  const health = useHealth();

  if (!campaign.walletMatches) {
    return (
      <Alert variant="warning" role="alert">
        <AlertTitle>This campaign belongs to a different wallet</AlertTitle>
        <AlertDescription className="text-card-foreground">
          It was created with a different wallet seed than the one this operator is using now, so it can&apos;t be funded, started or
          have its viewing key exported from here. Start the operator with the original wallet.
        </AlertDescription>
      </Alert>
    );
  }

  if (campaign.funding !== null) {
    return (
      <div className="space-y-3">
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-base">
          <span aria-hidden className="flex size-6 items-center justify-center rounded-full bg-verified text-sm font-bold text-background">
            ✓
          </span>
          <strong>Funded.</strong>
          <span>
            <Zec zatoshi={campaign.funding.amount} /> in deposit{" "}
            <span className="mono" title={campaign.funding.outpoint.txid}>
              {shortId(campaign.funding.outpoint.txid)}:{campaign.funding.outpoint.vout}
            </span>
            .
          </span>
        </p>
        {/* No funding address: nothing real could have been sent to it (the mock chain, practice mode), so the deposit is pretend. */}
        <DepositSource source={campaign.fundingSource} pretend={campaign.fundingAddress === null || health.data?.mock === true} />
      </div>
    );
  }

  if (health.data?.mock === true) return <MockFunding campaign={campaign} />;

  return campaign.fundingAddress !== null ? (
    <RealChainFunding campaign={campaign} address={campaign.fundingAddress} />
  ) : health.isPending ? (
    <p className="text-base text-muted-foreground">Asking the operator where to send the deposit…</p>
  ) : (
    <p className="text-base text-muted-foreground">The operator has not given a funding address for this campaign. Check its terminal for details.</p>
  );
}
