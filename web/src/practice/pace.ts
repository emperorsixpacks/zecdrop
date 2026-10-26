/** The time between the steps of a simulated run (built, sent, waiting, each confirmation), in milliseconds. A second or two
 * is long enough to watch the timeline move and short enough not to wait; the tests set it to a few milliseconds. */
export const pace = { stepMs: 1_200 };
