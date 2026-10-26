import type { VariantProps } from "class-variance-authority";
import { describe, expect, it } from "vitest";

import { badgeVariants } from "@/components/ui/badge";
import phaseRust from "../../../crates/drop-core/src/phase.rs?raw";
import { between, fill, stringLiterals } from "@/test/rust-source";

import {
  CAMPAIGN_PHASES,
  isTerminalPhase,
  phaseBadgeVariant,
  phaseLabel,
  phaseProgress,
  phaseSentence,
  type CampaignPhase,
  type PhaseState,
} from "./phase";

const expected: Record<
  CampaignPhase,
  { label: string; badge: string; terminal: boolean }
> = {
  draft: { label: "Draft", badge: "secondary", terminal: false },
  awaiting_funding: { label: "Awaiting funding", badge: "outline", terminal: false },
  funded: { label: "Funded", badge: "shielded", terminal: false },
  sending: { label: "Sending", badge: "default", terminal: false },
  settled: { label: "Settled", badge: "done", terminal: true },
  failed: { label: "Failed", badge: "destructive", terminal: true },
};

describe.each(CAMPAIGN_PHASES)("phase %s", (phase) => {
  it("has the expected label, badge variant and terminal flag", () => {
    expect(phaseLabel(phase)).toBe(expected[phase].label);
    expect(phaseBadgeVariant(phase)).toBe(expected[phase].badge);
    expect(isTerminalPhase(phase)).toBe(expected[phase].terminal);
  });

  it("is labelled in plain words, not an identifier", () => {
    expect(phaseLabel(phase)).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
  });

  it("maps to a variant the Badge component really defines", () => {
    // Compile time: the result must be assignable to the Badge prop.
    const variant: VariantProps<typeof badgeVariants>["variant"] =
      phaseBadgeVariant(phase);
    // Run time: an unknown variant yields only the base classes, so a real
    // one (including "default") must add classes on top.
    const baseOnly = badgeVariants({ variant: "nonexistent" as never });
    expect(badgeVariants({ variant })).not.toBe(baseOnly);
  });
});

describe("terminal phases", () => {
  it("are exactly settled and failed", () => {
    expect(CAMPAIGN_PHASES.filter(isTerminalPhase)).toEqual([
      "settled",
      "failed",
    ]);
  });
});

describe("the phase list", () => {
  it("covers every key of the expectation table (no phase left untested)", () => {
    expect([...CAMPAIGN_PHASES].sort()).toEqual(Object.keys(expected).sort());
  });
});

describe("PhaseState", () => {
  it("has exactly the same kinds as CampaignPhase (compile-time check)", () => {
    // Fails to compile if a kind is added to one type but not the other.
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const kindsMatch: Same<PhaseState["phase"], CampaignPhase> = true;
    expect(kindsMatch).toBe(true);
  });

  it("reports progress only for sending", () => {
    expect(phaseProgress({ phase: "sending", done: 2, total: 5 })).toBe(
      "2 of 5 batches confirmed",
    );
    expect(phaseProgress({ phase: "sending", done: 0, total: 1 })).toBe(
      "0 of 1 batches confirmed",
    );
    const none: PhaseState[] = [
      { phase: "draft" },
      { phase: "awaiting_funding" },
      { phase: "funded" },
      { phase: "settled" },
      { phase: "failed" },
    ];
    for (const state of none) expect(phaseProgress(state)).toBeNull();
  });
});

describe("phaseSentence equals the core's CampaignPhase::label", () => {
  // The six literals inside `label()`, in declaration order.
  const [draft, awaiting, funded, sending, settled, failed] = stringLiterals(
    between(phaseRust, "pub fn label(&self) -> String {", "pub(crate) fn is_final"),
  );

  it("found the six sentences in the Rust source", () => {
    expect([draft, awaiting, funded, sending, settled, failed].every((s) => !!s)).toBe(true);
  });

  it.each<[PhaseState, string | undefined]>([
    [{ phase: "draft" }, draft],
    [{ phase: "awaiting_funding" }, awaiting],
    [{ phase: "funded" }, funded],
    [{ phase: "settled" }, settled],
    [{ phase: "failed" }, failed],
  ])("%o", (state, rust) => {
    expect(phaseSentence(state)).toBe(rust);
  });

  it.each([
    [0, 1],
    [2, 5],
    [7, 7],
  ])("sending %i of %i", (done, total) => {
    expect(phaseSentence({ phase: "sending", done, total })).toBe(
      fill(sending ?? "", { done, total }),
    );
  });
});
