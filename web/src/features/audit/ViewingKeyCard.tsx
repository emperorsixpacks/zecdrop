import { useEffect, useId, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FailureNotice } from "@/features/operator/FailureNotice";
import { useHealth, useViewingKey } from "@/features/operator/hooks";

import { DISCLOSURE_WARNING, KEY_VISIBLE_MS } from "./disclosure";

/** Reveal the campaign's viewing key, after the person has read what it
 * discloses and said they understand.
 *
 * The key lives in this component's state and nowhere else: not in the query
 * cache, not in storage, not in a URL. It is hidden again when the person
 * presses Hide, after two minutes, and when they leave the page. */
export function ViewingKeyCard({ campaignId }: { campaignId: string }) {
  const health = useHealth();
  const { state, request, clear } = useViewingKey(campaignId);
  const [agreed, setAgreed] = useState(false);
  const ids = { agree: useId(), key: useId(), warning: useId() };

  const revealed = state.status === "ready";
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(clear, KEY_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [revealed, clear]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>Give an auditor the viewing key</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="warning" role="note">
          <AlertTitle>This cannot be undone</AlertTitle>
          <AlertDescription className="text-card-foreground" id={ids.warning}>
            {DISCLOSURE_WARNING}
          </AlertDescription>
        </Alert>

        {health.isPending ? (
          <Skeleton className="h-10 w-48" />
        ) : health.data?.mock === true ? (
          <p className="text-sm text-muted-foreground">
            The mock chain has no real viewing keys, so there is nothing to export here. On a real chain this is where
            the key appears.
          </p>
        ) : state.status === "ready" ? (
          <div className="space-y-3">
            <Alert variant="warning" role="alert">
              <AlertTitle>Read this before copying</AlertTitle>
              <AlertDescription className="text-card-foreground">{state.key.warning}</AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <label htmlFor={ids.key} className="text-sm font-medium">
                Viewing key for {state.key.network}
              </label>
              <Textarea
                id={ids.key}
                readOnly
                value={state.key.ufvk}
                rows={4}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs break-all"
                onFocus={(e) => {
                  e.currentTarget.select();
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <CopyButton value={state.key.ufvk} label="Copy viewing key" />
              <Button variant="outline" size="sm" onClick={clear}>
                Hide key
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The key is hidden again after two minutes, and when you leave this page. Copying puts it on your
              clipboard, so clear the clipboard afterwards.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <label htmlFor={ids.agree} className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                id={ids.agree}
                type="checkbox"
                className="mt-0.5 size-4 accent-link"
                checked={agreed}
                onChange={(e) => {
                  setAgreed(e.target.checked);
                }}
                aria-describedby={ids.warning}
              />
              <span>
                I understand that whoever receives this key can see every recipient, amount and memo of this campaign,
                for good.
              </span>
            </label>
            <Button
              onClick={() => {
                // Each reveal needs its own "I understand": the tick does not carry over to the next one.
                setAgreed(false);
                void request();
              }}
              disabled={!agreed || state.status === "loading"}
            >
              {state.status === "loading" ? "Fetching…" : "Show the viewing key"}
            </Button>
            {state.status === "failed" && <FailureNotice error={state.error} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
