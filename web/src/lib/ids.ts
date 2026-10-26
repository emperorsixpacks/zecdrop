// Small helpers for showing ids.

/** "ab12cd34…ef56ab78": enough to compare by eye, short enough for a phone. */
export function shortId(hex: string, edge = 8): string {
  if (hex.length <= edge * 2 + 1) return hex;
  return `${hex.slice(0, edge)}…${hex.slice(-edge)}`;
}
