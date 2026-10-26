import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { TESTNET_FAUCET_URL } from "@/lib/faucet";

import { START_COMMANDS } from "./commands";

// "Make a payout" (REQ-RUN-002): the one command that runs ZecDrop on your own computer, what it needs, and what happens
// next. ZecDrop holds your keys and your payout list, so it never runs on this site (docs/ADR/0002).

const DOCKER_URL = "https://www.docker.com/products/docker-desktop/";

const link = "font-medium text-link underline underline-offset-4";

export default function StartPage() {
  const commands = START_COMMANDS.join("\n");
  return (
    <div className="max-w-[44rem] space-y-10">
      <PageHeader title="Make a payout" description="ZecDrop runs on your own computer, so your keys and your list never leave it." />

      <section aria-labelledby="need-heading" className="space-y-2">
        <h2 id="need-heading" className="text-xl leading-tight font-bold tracking-[-0.01em]">
          You need Docker and git
        </h2>
        <p className="text-base">
          Install{" "}
          <a href={DOCKER_URL} target="_blank" rel="noopener noreferrer" className={link}>
            Docker Desktop<span className="sr-only"> (opens in a new tab)</span>
          </a>{" "}
          and start it. On Windows, run the commands in WSL. The first start builds ZecDrop, which takes a few minutes to half an
          hour.
        </p>
      </section>

      <section aria-labelledby="run-heading" className="space-y-3">
        <h2 id="run-heading" className="text-xl leading-tight font-bold tracking-[-0.01em]">
          Then run
        </h2>
        <div className="slip flex flex-wrap items-start justify-between gap-4 p-4 sm:p-5">
          {/* On a phone the clone line is wider than the box: it scrolls, so it takes the focus and has a name. */}
          <pre role="region" aria-label="The commands" tabIndex={0} className="mono max-w-full overflow-x-auto text-sm leading-relaxed" data-testid="start-command">
            {commands}
          </pre>
          <CopyButton value={commands} label="Copy the commands" />
        </div>
      </section>

      <section aria-labelledby="next-heading" className="space-y-3">
        <h2 id="next-heading" className="text-xl leading-tight font-bold tracking-[-0.01em]">
          ZecDrop opens in your browser
        </h2>
        <ol className="list-decimal space-y-1.5 pl-6 text-base">
          <li>Add the people you&apos;re paying, or use the example list.</li>
          <li>
            Fund the payout. Test coins are free from the{" "}
            <a href={TESTNET_FAUCET_URL} target="_blank" rel="noopener noreferrer" className={link}>
              testnet faucet<span className="sr-only"> (opens in a new tab)</span>
            </a>
            , or from us when it can&apos;t pay.
          </li>
          <li>Send it, and share the receipt.</li>
        </ol>
      </section>

      <p className="text-sm text-muted-foreground">Testnet only for now. Stop it with ./zecdrop down.</p>
    </div>
  );
}
