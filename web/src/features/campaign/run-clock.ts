// When this page started a campaign, for the elapsed time on the timeline. Memory
// only, one number per campaign id: nothing about a recipient, and it is gone when
// the tab is. A page that did not start the run can only say how long it has been watching.

const started = new Map<string, number>();

export function markStarted(id: string): void {
  started.set(id, Date.now());
}

export function startedHere(id: string): number | undefined {
  return started.get(id);
}
