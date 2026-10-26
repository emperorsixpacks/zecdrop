/** What the simulation is doing right now, counted, so that a test can say that leaving practice mode stopped all of it:
 * the calls it has answered, the timers it has set and not yet fired or cleared, the event streams it has open. */
export const activity = { requests: 0, timers: 0, streams: 0 };
