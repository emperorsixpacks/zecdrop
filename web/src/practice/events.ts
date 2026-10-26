// The event stream of one campaign, as the operator serves it: Server-Sent Events, `event: progress` and the event as JSON,
// the whole history first and then each new event as it happens, closed after the last one (`settled`).

import { activity } from "./activity";
import { isTerminal, type Campaign, type WireEvent } from "./state";

const encoder = new TextEncoder();

const frame = (event: WireEvent): Uint8Array => encoder.encode(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);

/** An open stream, and the way to close it from this side (closing a closed one does nothing). */
export interface OpenStream {
  response: Response;
  close: () => void;
}

/** What `fetch` does when its signal aborts. */
function aborted(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function openEventStream(campaign: Campaign, signal: AbortSignal | null | undefined): OpenStream {
  let finish: (error?: unknown) => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      activity.streams += 1;
      let open = true;
      const listener = (event: WireEvent): void => {
        controller.enqueue(frame(event));
        if (isTerminal(event)) finish();
      };
      const onAbort = (): void => {
        finish(aborted());
      };
      finish = (error?: unknown): void => {
        if (!open) return;
        open = false;
        activity.streams -= 1;
        campaign.listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
        try {
          if (error === undefined) controller.close();
          else controller.error(error);
        } catch {
          // Already closed from the other side.
        }
      };

      for (const event of campaign.events) controller.enqueue(frame(event));
      if (campaign.events.some(isTerminal)) {
        finish();
        return;
      }
      campaign.listeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      finish();
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } }),
    close: () => {
      finish();
    },
  };
}
