/** Closing the share sheet rejects with an AbortError: a choice the person made, not a failure to explain. */
export function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
