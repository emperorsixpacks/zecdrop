import { activity } from "./activity";

/** The simulation's only use of time. Every timer it sets goes through here, so that leaving practice mode can cancel all of
 * them at once, and so that the count of what is pending (activity.timers) is honest. */
export class Scheduler {
  #pending = new Set<ReturnType<typeof setTimeout>>();
  #stopped = false;

  /** Run `task` after `ms` milliseconds, unless the scheduler has been stopped. */
  after(ms: number, task: () => void): void {
    if (this.#stopped) return;
    const timer = setTimeout(() => {
      this.#pending.delete(timer);
      activity.timers -= 1;
      task();
    }, ms);
    this.#pending.add(timer);
    activity.timers += 1;
  }

  /** Cancel everything that is waiting, and refuse anything more. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#pending) clearTimeout(timer);
    activity.timers -= this.#pending.size;
    this.#pending.clear();
  }
}
