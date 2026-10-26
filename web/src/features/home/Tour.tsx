import { Link } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { useAppearance } from "@/lib/appearance";

import { AUDIT_RESULT, TOUR_STEPS, TOUR_WIDTH, tourImageSrc, type TourShot } from "./tour-steps";

/** One screen, in the look the page is in. The size is written on the tag, so the space is held before the
 * picture arrives and nothing moves; it loads only when it is near. */
function Picture({ shot }: { shot: TourShot }) {
  const look = useAppearance((s) => s.theme);
  return (
    <figure className="space-y-2">
      <img
        src={tourImageSrc(shot, look)}
        alt={shot.alt}
        width={TOUR_WIDTH}
        height={shot.height}
        loading="lazy"
        decoding="async"
        className="h-auto w-full max-w-[640px] rounded-md border border-border"
      />
      <figcaption className="text-sm text-muted-foreground">{shot.caption}</figcaption>
    </figure>
  );
}

const textLink = "inline-flex min-h-11 items-center text-base font-medium underline underline-offset-4";

/** One payout in six screens: what to do at each step, what the public can see then, and what stays hidden.
 * The operator's screens are from a practice run on the mock chain; the receipt is the real testnet batch. */
export function Tour() {
  return (
    <section aria-labelledby="tour-heading" className="space-y-8 border-t border-border pt-10">
      <div className="space-y-3">
        <h2 id="tour-heading" className="display text-[1.75rem] sm:text-[2.25rem]">
          A payout, screen by screen
        </h2>
        <div className="max-w-[48ch] space-y-1 text-lg">
          <p>The operator screens are from a practice run on a fake chain. No real money moved.</p>
          <p>The receipt is the real batch from public testnet.</p>
          <p>Under each step: what the public can see, and what stays hidden.</p>
        </div>
      </div>

      <ol className="divide-y divide-border border-y border-border">
        {TOUR_STEPS.map((step, index) => (
          <li key={step.id} className="grid gap-x-12 gap-y-6 py-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
            {/* Sticks below the header capsule (which is 56px from the top of the screen, with room to breathe). */}
            <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
              <span aria-hidden className="mono flex size-8 items-center justify-center rounded-[4px] bg-primary text-base font-medium text-primary-foreground">
                {index + 1}
              </span>
              <h3 className="text-xl leading-snug font-bold tracking-[-0.01em]">{step.title}</h3>
              <p className="max-w-[40ch] text-base">{step.text}</p>
              <dl className="divide-y divide-border border-y border-border text-base" data-testid="tour-note">
                <div className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[5rem_1fr]">
                  <dt className="font-bold">Public</dt>
                  <dd>{step.publicNote}</dd>
                </div>
                <div className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[5rem_1fr]">
                  <dt className="font-bold">Hidden</dt>
                  <dd>{step.hiddenNote}</dd>
                </div>
              </dl>
              {step.id === "receipt" && (
                <Link to={SAMPLE_RECEIPT_HREF} className={textLink}>
                  Open this receipt
                </Link>
              )}
              {step.id === "audit" && (
                <div className="space-y-2">
                  <p className="text-base">When everything matches, the command ends with:</p>
                  <code className="mono block rounded-lg border border-border bg-secondary p-3 text-sm break-words">{AUDIT_RESULT}</code>
                </div>
              )}
            </div>
            <div className="space-y-8">
              {step.shots.map((shot) => (
                <Picture key={shot.id} shot={shot} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
