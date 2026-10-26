import { useId, useState, type FormEvent } from "react";

import { adoptTokenFromText } from "@/api/operator/session";
import { Disclosure } from "@/components/Disclosure";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OpenOperatorLinkProps {
  /** `missing`: no link was opened. `rejected`: the operator refused the token. */
  reason: "missing" | "rejected";
}

/** Shown instead of an operator page when there is no usable token. It says what
 * happened, how to get back in, and why the page works this way. */
export function OpenOperatorLink({ reason }: OpenOperatorLinkProps) {
  const inputId = useId();
  const errorId = useId();
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (adoptTokenFromText(pasted)) {
      setPasted(""); // the pasted text is not kept
      setProblem(null);
    } else {
      setProblem("That does not contain an operator token. Paste the whole line that starts with \"open:\", or just the token.");
    }
  }

  return (
    <>
      <PageHeader
        kicker="Operator"
        title="Open the operator link"
        description="This part of ZecDrop talks to the operator program on this computer, and it needs the link that program printed when it started."
      />
      <div className="space-y-6">
        <Alert variant={reason === "rejected" ? "warning" : "info"} role="alert">
          <AlertTitle>
            {reason === "rejected" ? "The operator did not accept this link" : "No operator link was opened"}
          </AlertTitle>
          <AlertDescription>
            {reason === "rejected"
              ? "The link changes every time the operator restarts, so a tab or link from an earlier run stops working."
              : "You may have opened this address directly, or reloaded the page. The page forgets the link on reload, on purpose."}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>How to get back in</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Look at the terminal where the operator is running. If it is not running, start it.</li>
              <li>
                Find the line that begins <code className="font-mono">open:</code>. It is an address ending in{" "}
                <code className="font-mono">#token=</code> and a long string of letters and numbers.
              </li>
              <li>Open that whole address in this browser, or paste it below.</li>
            </ol>

            <form onSubmit={submit} className="space-y-2" noValidate>
              <Label htmlFor={inputId}>Operator link or token</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={inputId}
                  type="password"
                  value={pasted}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    setProblem(null);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={problem !== null}
                  aria-describedby={problem !== null ? errorId : undefined}
                  className="min-w-0 flex-1"
                />
                <Button type="submit">Use this link</Button>
              </div>
              {problem !== null && (
                <p id={errorId} role="alert" className="text-sm text-destructive">
                  {problem}
                </p>
              )}
            </form>
          </CardContent>
        </Card>

        <div className="border-b border-border">
          <Disclosure summary="Why it works this way">
            <div className="max-w-[64ch] space-y-3 text-base text-muted-foreground">
              <p>
                The link holds a one-time key that proves this page is allowed to use your operator. Anyone who has it can
                use the operator, so keep it to yourself.
              </p>
              <p>
                The page keeps the key in memory only: not in browser storage, cookies or the address bar. That is why
                reloading asks for the link again.
              </p>
            </div>
          </Disclosure>
        </div>
      </div>
    </>
  );
}
