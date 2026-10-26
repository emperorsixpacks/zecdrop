// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import "@/test/dom";
import boundaryDoc from "../../../../docs/PRIVACY_BOUNDARY.md?raw";

import PrivacyPage from "./PrivacyPage";

// The page mirrors docs/PRIVACY_BOUNDARY.md. Its status line says how far the
// design has been checked; the page must say the same, and when the document
// moves on (mainnet checked, an audit done) this fails until the page does too.
describe("the privacy page's status", () => {
  const status = boundaryDoc.split("\n").find((line) => line.startsWith("Status:")) ?? "";
  // The document wraps the line, so look at the paragraph after "Status:".
  const paragraph = boundaryDoc.slice(boundaryDoc.indexOf("Status:"), boundaryDoc.indexOf("\n\n", boundaryDoc.indexOf("Status:")));

  it("the document says the shape is confirmed on public testnet, not on mainnet, not audited", () => {
    expect(status).not.toBe("");
    expect(paragraph).toMatch(/confirmed on public testnet/u);
    expect(paragraph).toMatch(/Not yet checked on mainnet/u);
    expect(paragraph).toMatch(/not independently audited/u);
  });

  it("the page says the same, and not the old 'written from the design' line", () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );
    const note = screen.getByText(/confirmed on\s+public testnet/u);
    expect(note).toHaveTextContent("has not been checked on mainnet");
    expect(note).toHaveTextContent("not been independently audited");
    expect(document.body.textContent).not.toMatch(/Written from the design|before the transaction\s+shape was confirmed/u);
  });
});
