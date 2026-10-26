// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
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

// covers: REQ-PRIV-003
describe("PrivacyWarnings", () => {
  it("shows each warning with a text title and the core's sentence", () => {
    show(all);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    all.forEach((warning, i) => {
      const item = items[i];
      if (!item) throw new Error("missing list item");
      expect(within(item).getByText(warningTitle(warning.code))).toBeInTheDocument();
      expect(within(item).getByText(warningMessage(warning))).toBeInTheDocument();
    });
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

  it("with no warnings, says so without promising privacy, and links the boundary", () => {
    show([]);
    expect(screen.getByRole("region", { name: "Privacy warnings" })).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/does not make the payout private/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "privacy boundary" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("does not rely on colour: every warning carries its own title text", () => {
    show([{ code: "singleton_campaign" }]);
    expect(screen.getByText("One recipient")).toBeInTheDocument();
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
