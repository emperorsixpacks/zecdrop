import { CopyButton } from "@/components/CopyButton";

/** The salted list fingerprint (the manifest commitment), and what it is for. The
 * wording follows docs/PRIVACY_BOUNDARY.md and REQ-MAN-001: it lets an auditor
 * check the payout list; the public cannot. */
export function Fingerprint({ commitment }: { commitment: string }) {
  return (
    <div className="max-w-[64ch] space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <code className="min-w-0 flex-1 rounded-lg bg-secondary px-3 py-2 font-mono text-xs break-all" translate="no">
          {commitment}
        </code>
        <CopyButton value={commitment} label="Copy list fingerprint" />
      </div>
      <p className="text-sm text-muted-foreground">
        A salted fingerprint (SHA-256) of the private payout list: every row, their order and a
        random salt. Change any of them and the fingerprint changes. By itself it reveals
        nothing about who is on the list. An auditor who holds the list and the salt can
        recompute it and confirm it matches; the public cannot check it. Its technical name is
        the manifest commitment.
      </p>
    </div>
  );
}
