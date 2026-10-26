import { useId, useState } from "react";

import type { InboxView, OperatorCampaign } from "@/api/operator/schemas";
import { CopyButton } from "@/components/CopyButton";
import { Disclosure } from "@/components/Disclosure";
import { QrCode } from "@/components/QrCode";
import { UnitNote } from "@/components/UnitProvider";
import { Why } from "@/components/Why";
import { Zec } from "@/components/Zec";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { operatorNearApi } from "@/features/funding/near/api";
import { NearFundingPanel } from "@/features/funding/near/NearFundingPanel";
import { TESTNET_FAUCET_URL, testCoinsRequestUrl } from "@/lib/faucet";
import { shortId } from "@/lib/ids";
import { fundingPaymentUri } from "@/lib/payment-uri";
import { phaseSentence } from "@/lib/phase";
import { useMediaQuery } from "@/lib/use-media";
import { formatZec } from "@/lib/zec";

import { DepositSource } from "./DepositSource";
import { FailureNotice } from "./FailureNotice";
import { FUNDING_SOURCE_WORDING } from "./funding-source-wording";
import { useCheckFunding, useHealth, useReturnInbox } from "./hooks";
import { INBOX_WORDING } from "./inbox-wording";
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

/** An address to pay, with a copy button, a wallet link and a QR code for exactly `zatoshi`. `testId` names the parts
 * (`<testId>-address`, `<testId>-qr`). */
function AddressBlock({
  address,
  zatoshi,
  testId,
  copyLabel,
  qrLabel,
  qrCaption,
}: {
  address: string;
  zatoshi: string;
  testId: string;
  copyLabel: string;
  qrLabel: string;
  qrCaption: string;
}) {
  const qrId = useId();
  const wide = useMediaQuery(QR_BESIDE);
  const [qrOpen, setQrOpen] = useState(false);
  // A link that opens a wallet app with the address and amount filled in. Null if either looks wrong.
  const walletLink = fundingPaymentUri(address, zatoshi);
  return (
    <div className="md:grid md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-10">
      <div className="space-y-2">
        <p className="mono text-lg break-all" data-testid={`${testId}-address`}>
          {address}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <CopyButton value={address} label={copyLabel} />
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
          <p className="max-w-[64ch] text-sm text-muted-foreground">Opens a wallet app that handles zcash links. If nothing opens, copy the address.</p>
        )}
      </div>
      {/* The same request the wallet link carries, nothing more: this address and the amount. Only where there is a link. */}
      {walletLink !== null && (wide || qrOpen) && (
        <figure id={qrId} data-testid={`${testId}-qr`} className="mt-4 w-full max-w-[18rem] space-y-2 md:mt-0 md:w-fit">
          <QrCode text={walletLink} label={qrLabel} className="md:w-auto" />
          {/* The caption wraps to the width of the code and never makes the figure wider than it. */}
          <figcaption className="w-0 min-w-full text-sm text-muted-foreground">{qrCaption}</figcaption>
        </figure>
      )}
    </div>
  );
}

/** Paying the payout's public funding address. On its own it is the whole funding screen; `nested` inside the shielded
 * address's screen it is the fallback, without a heading of its own. */
function RealChainFunding({ campaign, address, nested = false }: { campaign: OperatorCampaign; address: string; nested?: boolean }) {
  const check = useCheckFunding(campaign.id);
  const headingId = useId();
  // On mainnet the deposit should be exactly what is asked: a surplus comes back as change to an address this
  // operator cannot spend there, so it would stay stuck.
  const exact = campaign.network === "mainnet";
  return (
    <section {...(nested ? { "aria-label": INBOX_WORDING.publicInstead } : { "aria-labelledby": headingId })} className="space-y-5">
      {!nested && (
        <h2 id={headingId} className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
          Is it funded?
        </h2>
      )}
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
      <AddressBlock
        address={address}
        zatoshi={campaign.fundingRequired}
        testId="funding"
        copyLabel="Copy funding address"
        qrLabel="QR code for this deposit: the funding address and the exact amount"
        qrCaption="Scan with a Zcash wallet on your phone: it fills in this address and the exact amount."
      />
      {campaign.network === "testnet" && (
        <p className="max-w-[64ch] text-base" data-testid="faucet">
          No test coins? The{" "}
          <a href={TESTNET_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-link underline underline-offset-4">
            testnet faucet<span className="sr-only"> (opens in a new tab)</span>
          </a>{" "}
          pays this address for free. If it can&apos;t,{" "}
          <a
            href={testCoinsRequestUrl(address, formatZec(BigInt(campaign.fundingRequired)))}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-link underline underline-offset-4"
            data-testid="ask-for-coins"
          >
            ask us on GitHub<span className="sr-only"> (opens in a new tab)</span>
          </a>{" "}
          and we&apos;ll pay it from ZecDrop&apos;s test wallet.
        </p>
      )}
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
      {!nested && <UnitNote />}
    </section>
  );
}

/** "21:34", in the reader's own clock. */
function clock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A send-back on its way, with its transaction (REQ-FUND-007). */
function ReturningLine({ txid }: { txid: string | null }) {
  return (
    <p className="text-base">
      Sending what is left back
      {txid !== null && (
        <>
          , in transaction{" "}
          <span className="mono" title={txid}>
            {shortId(txid)}
          </span>
        </>
      )}
      .
    </p>
  );
}

/** Where the shielded address stands, in a sentence or two (REQ-FUND-008). */
function InboxStatus({ inbox, campaign }: { inbox: InboxView; campaign: OperatorCampaign }) {
  const line = (() => {
    switch (inbox.state) {
      case "preparing":
        return <p className="text-base text-muted-foreground">{INBOX_WORDING.preparing}</p>;
      case "checking":
        return <p className="text-base text-muted-foreground">{INBOX_WORDING.checking}</p>;
      case "unavailable":
        return <p className="text-base text-problem">{INBOX_WORDING.unavailable}</p>;
      case "waiting":
        return <p className="text-base text-muted-foreground">{INBOX_WORDING.waiting}</p>;
      case "confirming":
        return (
          <p className="text-base">
            A deposit of <Zec zatoshi={inbox.received} /> has {inbox.confirmations ?? 0} of {inbox.requiredConfirmations} confirmations.
          </p>
        );
      case "short":
        return (
          <p className="text-base">
            <Zec zatoshi={inbox.received} /> has arrived. Send <Zec zatoshi={inbox.need ?? "0"} /> more. {INBOX_WORDING.shortTail}
          </p>
        );
      case "dust":
        return (
          <p className="text-base">
            <Zec zatoshi={inbox.received} /> has arrived, a little more than asked. Send <Zec zatoshi={inbox.need ?? "0"} /> more,{" "}
            {INBOX_WORDING.dustTail}
          </p>
        );
      case "scheduled":
        return (
          <div className="space-y-1 text-base">
            <p>
              <Zec zatoshi={inbox.spendable} /> is ready.
              {inbox.moveAt !== null && <> At about {clock(inbox.moveAt)},</>} ZecDrop moves <Zec zatoshi={campaign.fundingRequired} /> to the
              payout&apos;s public address.
            </p>
            <p className="text-sm text-muted-foreground">{INBOX_WORDING.scheduledWhy}</p>
          </div>
        );
      case "moving":
      case "moved":
        return (
          <p className="text-base">
            Moving <Zec zatoshi={campaign.fundingRequired} /> to the payout&apos;s public address
            {inbox.txid !== null && (
              <>
                , in transaction{" "}
                <span className="mono" title={inbox.txid}>
                  {shortId(inbox.txid)}
                </span>
              </>
            )}
            . {INBOX_WORDING.movingTail}
          </p>
        );
      case "unused":
        return <p className="text-base">{INBOX_WORDING.unused}</p>;
      case "returning":
        return <ReturningLine txid={inbox.txid} />;
    }
  })();
  return (
    <>
      {line}
      {inbox.orchard !== "0" && (
        <p className="text-base text-problem">
          <Zec zatoshi={inbox.orchard} /> {INBOX_WORDING.orchardTail}
        </p>
      )}
    </>
  );
}

/** A shielded address, roughly: the operator decides; this only keeps the button off for what cannot be one. */
const SHIELDED_SHAPE = /^u(test)?1[0-9a-z]{20,}$/u;

/** Sends what is left in the payout's shielded address back to a shielded address of the person's, after they confirm
 * (REQ-FUND-007). */
function InboxReturn({ campaign }: { campaign: OperatorCampaign }) {
  const send = useReturnInbox(campaign.id);
  const headingId = useId();
  const inputId = useId();
  const [to, setTo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const valid = SHIELDED_SHAPE.test(to.trim());
  if (send.isSuccess) {
    return (
      <p role="status" className="text-base" data-testid="inbox-return-sent">
        {INBOX_WORDING.returnSent}{" "}
        <span className="mono" title={send.data.txid}>
          {shortId(send.data.txid)}
        </span>
        .
      </p>
    );
  }
  return (
    <section aria-labelledby={headingId} className="max-w-[64ch] space-y-3" data-testid="inbox-return">
      <h3 id={headingId} className="text-lg font-bold">
        {INBOX_WORDING.returnHeading}
      </h3>
      <p className="text-base">{INBOX_WORDING.returnWhy}</p>
      <div className="space-y-1">
        <label htmlFor={inputId} className="block text-sm font-semibold">
          {INBOX_WORDING.returnLabel}
        </label>
        <input
          id={inputId}
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setConfirming(false);
          }}
          autoComplete="off"
          spellCheck={false}
          className="mono h-11 w-full rounded-(--r-control) border border-input bg-card px-3 text-base"
        />
      </div>
      {confirming ? (
        <div className="space-y-3">
          <p className="text-base font-semibold">{INBOX_WORDING.returnConfirm}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                send.mutate(to.trim());
              }}
              disabled={send.isPending}
            >
              {send.isPending ? "Sending…" : INBOX_WORDING.returnYes}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          disabled={!valid}
          onClick={() => {
            setConfirming(true);
          }}
        >
          {INBOX_WORDING.returnButton}
        </Button>
      )}
      {send.isError && <FailureNotice error={send.error} />}
    </section>
  );
}

/** The inbox states in which what it holds can go back: no move can happen from them. */
const RETURNABLE: ReadonlySet<InboxView["state"]> = new Set<InboxView["state"]>(["short", "dust", "unused", "moved"]);

/** The inbox states in which paying the public address as well could only make trouble: something is already on its way,
 * or (checking, after the operator restarts) the payer may already have paid the shielded address. */
const PUBLIC_CLOSED: ReadonlySet<InboxView["state"]> = new Set<InboxView["state"]>([
  "checking",
  "scheduled",
  "moving",
  "moved",
  "returning",
]);

/** The inbox states in which a payment to it is what happens next: nothing yet, or not enough. In any other the ask, and the
 * QR code that pays it, would only invite paying twice. */
const ASK_STATES: ReadonlySet<InboxView["state"]> = new Set<InboxView["state"]>(["waiting", "short", "dust"]);

/** The funding screen of a payout with a shielded deposit address: that address first, the public one as the fallback
 * until anything reaches the shielded one (REQ-FUND-008). */
function InboxFunding({ campaign, inbox }: { campaign: OperatorCampaign; inbox: InboxView }) {
  const headingId = useId();
  const showPublic = campaign.fundingAddress !== null && inbox.received === "0" && !PUBLIC_CLOSED.has(inbox.state);
  const asking = ASK_STATES.has(inbox.state);
  // When short (or over by too little), what is missing: the payment that makes the move possible, not the whole again.
  const amount = inbox.state !== "waiting" && inbox.need !== null ? inbox.need : inbox.asked;
  return (
    <section aria-labelledby={headingId} className="space-y-5" data-testid="inbox-funding">
      <h2 id={headingId} className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em]">
        Is it funded?
      </h2>
      {asking && (
        <p className="flex max-w-[64ch] flex-wrap items-center gap-x-1 text-base" data-testid="inbox-ask">
          <span>
            Send <strong><Zec zatoshi={amount} /></strong> {INBOX_WORDING.ask}
          </span>
          <Why label={INBOX_WORDING.whyLabel}>
            <div className="space-y-2">
              {INBOX_WORDING.why.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </Why>
        </p>
      )}
      {asking && inbox.depositAddress !== null && (
        <AddressBlock
          address={inbox.depositAddress}
          zatoshi={amount}
          testId="inbox"
          copyLabel={INBOX_WORDING.copyLabel}
          qrLabel={INBOX_WORDING.qrLabel}
          qrCaption={INBOX_WORDING.qrCaption}
        />
      )}
      <div role="status" aria-live="polite" className="space-y-2" data-testid="inbox-status">
        <InboxStatus inbox={inbox} campaign={campaign} />
      </div>
      {showPublic && campaign.fundingAddress !== null && (
        <Disclosure summary={INBOX_WORDING.publicInstead} data-testid="public-instead">
          <RealChainFunding campaign={campaign} address={campaign.fundingAddress} nested />
        </Disclosure>
      )}
      {RETURNABLE.has(inbox.state) && inbox.spendable !== "0" && <InboxReturn campaign={campaign} />}
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
    const inbox = campaign.inbox;
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
        {inbox?.state === "moved" && <p className="text-base">{INBOX_WORDING.movedFrom}</p>}
        {/* No funding address: nothing real could have been sent to it (the mock chain), so the deposit is pretend. */}
        <DepositSource source={campaign.fundingSource} pretend={campaign.fundingAddress === null || health.data?.mock === true} />
        {inbox !== null && inbox.left !== "0" && (
          <p className="text-base" data-testid="inbox-left">
            <Zec zatoshi={inbox.left} /> {INBOX_WORDING.leftTail}
          </p>
        )}
        {inbox !== null && inbox.left !== "0" && RETURNABLE.has(inbox.state) && <InboxReturn campaign={campaign} />}
        {inbox?.state === "returning" && (
          <div role="status" data-testid="inbox-returning">
            <ReturningLine txid={inbox.txid} />
          </div>
        )}
      </div>
    );
  }

  if (health.data?.mock === true) return <MockFunding campaign={campaign} />;

  if (campaign.inbox !== null) return <InboxFunding campaign={campaign} inbox={campaign.inbox} />;

  return campaign.fundingAddress !== null ? (
    <RealChainFunding campaign={campaign} address={campaign.fundingAddress} />
  ) : health.isPending ? (
    <p className="text-base text-muted-foreground">Asking the operator where to send the deposit…</p>
  ) : (
    <p className="text-base text-muted-foreground">The operator has not given a funding address for this campaign. Check its terminal for details.</p>
  );
}
