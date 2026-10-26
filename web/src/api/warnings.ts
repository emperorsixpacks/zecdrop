// Privacy warnings for the review step, as the core reports them
// (crates/drop-core/src/warnings.rs). They carry only a code and a batch index
// or a count: the schema has no place for a recipient address, an amount or a
// memo, and every object is strict, so a payload that tries to add one is
// refused rather than rendered.
//
// The user-facing sentences below are word-for-word the core's `message()`,
// so the review step and the core's own logs say the same thing. warnings.test.ts
// compares them with the Rust source and fails if either side changes alone.

import { z } from "zod";

const U32_MAX = 4_294_967_295;
const u32 = z.number().int().min(0).max(U32_MAX);

export type PrivacyWarning =
  | { code: "singleton_campaign" }
  | { code: "small_campaign"; recipients: number }
  | { code: "two_recipient_batch"; batchIndex: number }
  | { code: "uniform_batch"; batchIndex: number };

export type PrivacyWarningCode = PrivacyWarning["code"];

const warningWire = z.discriminatedUnion("code", [
  z.object({ code: z.literal("singleton_campaign") }).strict(),
  z.object({ code: z.literal("small_campaign"), recipients: u32 }).strict(),
  z.object({ code: z.literal("two_recipient_batch"), batch_index: u32 }).strict(),
  z.object({ code: z.literal("uniform_batch"), batch_index: u32 }).strict(),
]);

const warningsWire = z
  .array(warningWire)
  .max(10_000)
  .transform(
    (items): PrivacyWarning[] =>
      items.map((w): PrivacyWarning => {
        switch (w.code) {
          case "singleton_campaign":
            return { code: w.code };
          case "small_campaign":
            return { code: w.code, recipients: w.recipients };
          case "two_recipient_batch":
          case "uniform_batch":
            return { code: w.code, batchIndex: w.batch_index };
        }
      }),
  );

/** Validate the warnings list from the operator API. Throws ZodError on any
 * unknown code, extra field or out-of-range number. */
export function parsePrivacyWarnings(input: unknown): PrivacyWarning[] {
  return warningsWire.parse(input);
}

/** The core's sentence for a warning (see the file header). */
export function warningMessage(warning: PrivacyWarning): string {
  switch (warning.code) {
    case "singleton_campaign":
      return "This campaign pays one recipient, so the public total is that recipient's exact amount.";
    case "small_campaign":
      return `Only ${String(warning.recipients)} recipients: the public total narrows down every amount.`;
    case "two_recipient_batch":
      return `Batch ${String(warning.batchIndex)} has two recipients; each can work out the other's amount from the public total and their own.`;
    case "uniform_batch":
      return `Every recipient in batch ${String(warning.batchIndex)} gets the same amount, so the public total reveals each amount.`;
  }
}

/** A short heading for a warning, so it never relies on colour alone. */
export function warningTitle(code: PrivacyWarningCode): string {
  switch (code) {
    case "singleton_campaign":
      return "One recipient";
    case "small_campaign":
      return "Small campaign";
    case "two_recipient_batch":
      return "Two-recipient batch";
    case "uniform_batch":
      return "Equal amounts";
  }
}

/** The warnings as the operator API sends them: each is the warning's own
 * fields plus the core's sentence in `message`. The sentence is required (a
 * missing one means the shape changed) but is not what gets shown: the text
 * shown is rendered from the code by {@link warningMessage}, and warnings
 * tests prove the two are identical. Everything else stays strict, so a
 * warning that carried anything beyond a code and a number is refused. */
export function parseWarningViews(input: unknown): PrivacyWarning[] {
  const items = z
    .array(z.looseObject({ message: z.string().min(1).max(500) }))
    .max(10_000)
    .parse(input);
  return parsePrivacyWarnings(
    items.map((item) => {
      const rest: Record<string, unknown> = { ...item };
      delete rest["message"];
      return rest;
    }),
  );
}
