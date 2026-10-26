// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import "@/test/dom";
import {
  parsePrivacyWarnings,
  warningMessage,
  warningTitle,
  type PrivacyWarning,
} from "@/api/warnings";

import { PrivacyWarnings } from "./PrivacyWarnings";

const all: PrivacyWarning[] = [
  { code: "small_campaign", recipients: 2 },
  { code: "two_recipient_batch", batchIndex: 0 },
  { code: "uniform_batch", batchIndex: 0 },
];

const show = (warnings: readonly PrivacyWarning[]) =>
  render(
    <MemoryRouter>
      <PrivacyWarnings warnings={warnings} />
    </MemoryRouter>,
  );

const chipOf = (warning: PrivacyWarning): string => {
  switch (warning.code) {
    case "singleton_campaign":
      return "Only 1 person: the total is their amount";
    case "small_campaign":
      return `Only ${String(warning.recipients)} people: amounts are easy to guess`;
    case "two_recipient_batch":
      return `Batch ${String(warning.batchIndex)}: two people can guess each other's amount`;
    case "uniform_batch":
      return `Batch ${String(warning.batchIndex)}: equal amounts are easy to see`;
  }
};

// covers: REQ-PRIV-003
describe("PrivacyWarnings", () => {
  it("shows each warning as a short chip, and keeps the core's sentence for 'Why?', word for word", async () => {
    const user = userEvent.setup();
    show(all);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const [i, warning] of all.entries()) {
      const item = items[i];
      if (!item) throw new Error("missing list item");
      expect(item).toHaveTextContent(chipOf(warning));
      // A chip is short; the long sentence is not on the page until asked for.
      expect(chipOf(warning).split(/\s+/u).length).toBeLessThanOrEqual(12);
      expect(screen.queryByText(warningMessage(warning))).toBeNull();

      await user.click(within(item).getByRole("button", { name: `Why: ${chipOf(warning)}` }));
      expect(await screen.findByText(warningMessage(warning))).toBeInTheDocument();
      await user.keyboard("{Escape}");
    }
  });

  it("still carries a text title for every code, for places that list warnings", () => {
    for (const warning of all) expect(warningTitle(warning.code)).not.toBe("");
  });

  it("names the region and counts the warnings in its heading", () => {
    show(all);
    const region = screen.getByRole("region", { name: "Privacy warnings (3)" });
    expect(within(region).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Privacy warnings (3)",
    );
  });

  it("announces the count through a status line, and updates it when the plan changes", () => {
    const { rerender } = show(all);
    expect(screen.getByRole("status")).toHaveTextContent("3 privacy warnings.");

    rerender(
      <MemoryRouter>
        <PrivacyWarnings warnings={[{ code: "singleton_campaign" }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 privacy warning.");

    rerender(
      <MemoryRouter>
        <PrivacyWarnings warnings={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("No privacy warnings.");
  });

  it("with no warnings, says so in a chip, and 'Why?' says it does not promise privacy and links the boundary", async () => {
    const user = userEvent.setup();
    show([]);
    expect(screen.getByRole("region", { name: "Privacy warnings" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("listitem")).toHaveTextContent("No privacy warnings");
    expect(screen.queryByText(/does not make the payout private/u)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Why: no privacy warnings" }));
    expect(await screen.findByText(/does not make the payout private/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "how privacy works" })).toHaveAttribute("href", "/privacy");
  });

  it("does not rely on colour: every warning is a sentence of words", () => {
    show([{ code: "singleton_campaign" }]);
    expect(screen.getByText(/Only 1 person/u)).toBeInTheDocument();
  });
});

// covers: REQ-PRIV-002
describe("no recipient data can reach the component", () => {
  const SENTINELS = ["u1sentineladdress", "7777001", "sentinel-memo"];

  it("the prop type has no field for an address, amount or memo (compile-time)", () => {
    // These lines fail `tsc` if the type ever grows such a field. Excess
    // property checks make a literal with an extra key a type error.
    show([
      // @ts-expect-error `address` is not part of a privacy warning
      { code: "singleton_campaign", address: SENTINELS[0] },
    ]);
    show([
      // @ts-expect-error `memo` is not part of a privacy warning
      { code: "small_campaign", recipients: 2, memo: SENTINELS[2] },
    ]);
    show([
      // @ts-expect-error `amount` is not part of a privacy warning
      { code: "uniform_batch", batchIndex: 1, amount: SENTINELS[1] },
    ]);
  });

  it("extra fields smuggled past the types are never rendered", () => {
    const smuggled = [
      { code: "small_campaign", recipients: 2, address: SENTINELS[0], memo: SENTINELS[2] },
      { code: "uniform_batch", batchIndex: 1, amount: SENTINELS[1] },
    ] as unknown as PrivacyWarning[];
    const { container } = show(smuggled);
    for (const sentinel of SENTINELS) {
      expect(container.textContent).not.toContain(sentinel);
      expect(container.innerHTML).not.toContain(sentinel);
    }
  });

  it("the validator the data goes through refuses such fields in the first place", () => {
    expect(() =>
      parsePrivacyWarnings([{ code: "small_campaign", recipients: 2, address: SENTINELS[0] }]),
    ).toThrow();
  });
});
