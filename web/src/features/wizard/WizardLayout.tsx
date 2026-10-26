import { NavLink, Outlet, useMatch } from "react-router";

import { cn } from "@/lib/utils";

import { useWizardDraft } from "./draft";
import { stepIndex, WIZARD_STEPS } from "./steps";

/** Frame for the five wizard steps: the step picker and the active step
 * (through <Outlet />). The current step is read from the URL, so there is no
 * second copy of "where am I" to fall out of sync. Each step draws its own
 * heading and its own Back / Next, because what "Next" does differs: the
 * Recipients step creates the campaign, the last one starts it. */
export default function WizardLayout() {
  const slug = useMatch("/new/:step")?.params.step;
  const active = stepIndex(slug);
  const created = useWizardDraft((s) => s.created);

  return (
    <div className="space-y-8">
      <nav aria-label="Wizard progress">
        <ol className="grid gap-2 sm:grid-cols-5">
          {WIZARD_STEPS.map((step, i) => {
            // After the campaign exists the first two steps are done; before it, the rest wait.
            const state = created !== null && i < 2 ? "done" : created === null && i >= 2 ? "waiting" : null;
            return (
              <li key={step.slug}>
                <NavLink
                  to={`/new/${step.slug}`}
                  aria-current={i === active ? "step" : undefined}
                  className={cn(
                    "block h-full rounded-lg border p-3 transition-colors",
                    i === active ? "border-link bg-primary/10" : "hover:bg-secondary",
                  )}
                >
                  <span className="block text-xs text-muted-foreground">
                    Step {i + 1}
                    {state === "done" && <span> (done)</span>}
                    {state === "waiting" && <span> (needs the campaign)</span>}
                  </span>{" "}
                  <span className="block text-sm font-medium">{step.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ol>
      </nav>

      <Outlet />
    </div>
  );
}
