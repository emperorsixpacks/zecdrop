import { useId, useState } from "react";

import type { Payslip } from "@/api/payslip-input";
import { payslipLink } from "@/api/payslip-link";
import { CopyButton } from "@/components/CopyButton";
import { QrCode } from "@/components/QrCode";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { config } from "@/lib/config";
import { isLoopbackHost } from "@/lib/mode";
import { isAbort } from "@/lib/share";

import { LINK_FEEDBACK, LINK_WARNING, LOOPBACK_NOTE, QR_CAPTION, SHARE_TEXT, type LinkFeedback } from "./wording";

// A payslip as a link and a QR code (openspec REQ-PAY-004). The link holds the whole payslip after its "#", where a
// browser never sends it to a server; it is made only when the person asks, is on the page only while they want it,
// and is never put in storage, in the address bar of this page or anywhere else by this file.

/** Where the link points: the public site if the build knows it, else this page's own origin. */
function linkBase(): string {
  return config.publicReceiptBaseUrl ?? window.location.origin;
}

/** The buttons to make a link and a QR code of a payslip, and what they show, for a payslip that has been read from the box. */
export function SendPayslip({ payslip }: { payslip: Payslip }) {
  const headingId = useId();
  const linkId = useId();
  const qrId = useId();
  const [showLink, setShowLink] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [feedback, setFeedback] = useState<LinkFeedback | null>(null);
  const canShare = typeof navigator.share === "function";
  const base = linkBase();
  // Not made until it is wanted: nothing of the payslip is in the page's link before then.
  const link = () => payslipLink(payslip, base);
  const here = isLoopbackHost(new URL(base).hostname);

  async function copyInstead() {
    try {
      await navigator.clipboard.writeText(link());
      setFeedback("fallback_copied");
    } catch {
      setFeedback("copy_failed");
    }
  }

  async function share() {
    try {
      await navigator.share({ text: SHARE_TEXT, url: link() });
      setFeedback(null);
    } catch (error) {
      // Closing the share sheet is a choice, not a failure: nothing is said. Anything else, copy instead.
      if (isAbort(error)) return;
      await copyInstead();
    }
  }

  return (
    <section aria-labelledby={headingId} className="space-y-4 border-t border-border pt-6">
      <h2 id={headingId} className="text-xl leading-snug font-bold tracking-[-0.01em]">
        Send this payslip
      </h2>
      <Alert role="note" variant="warning">
        <AlertDescription className="text-card-foreground">
          <p>{LINK_WARNING}</p>
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="secondary"
          aria-expanded={showLink}
          aria-controls={showLink ? linkId : undefined}
          onClick={() => {
            setShowLink((shown) => !shown);
          }}
        >
          {showLink ? "Hide the link" : "Make a link"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={showQr}
          aria-controls={showQr ? qrId : undefined}
          onClick={() => {
            setShowQr((shown) => !shown);
          }}
        >
          {showQr ? "Hide QR code" : "Show QR code"}
        </Button>
        {canShare && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void share();
            }}
          >
            Share
          </Button>
        )}
      </div>
      {here && <p className="text-sm text-muted-foreground">{LOOPBACK_NOTE}</p>}

      {showLink && (
        <div className="space-y-2">
          <Label htmlFor={linkId}>Payslip link</Label>
          <Textarea
            id={linkId}
            readOnly
            rows={4}
            value={link()}
            spellCheck={false}
            autoComplete="off"
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            className="mono break-all"
          />
          <div>
            <CopyButton value={link()} label="Copy payslip link" />
          </div>
        </div>
      )}

      {showQr && (
        <figure id={qrId} data-testid="payslip-qr" className="w-full max-w-[26rem] space-y-2 md:w-fit">
          {/* The whole width of a phone; from md up, four pixels to a module, so that every module is as wide as every other. */}
          <QrCode text={link()} ecc="L" moduleSize={4} label="QR code of the payslip link" className="md:w-auto" />
          <figcaption className="w-0 min-w-full text-sm text-muted-foreground">{QR_CAPTION}</figcaption>
        </figure>
      )}

      <div role="status" aria-live="polite" data-testid="link-feedback">
        {feedback !== null && <p className="text-base font-medium">{LINK_FEEDBACK[feedback]}</p>}
      </div>
    </section>
  );
}
