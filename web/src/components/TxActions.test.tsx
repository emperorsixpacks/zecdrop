// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/test/dom";
import { practiceId } from "@/lib/practice-mode";

import { TxActions } from "./TxActions";

const REAL = "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955";

describe("a transaction id with its actions", () => {
  it("has a copy button and a link to the explorer for a transaction on a chain", () => {
    render(<TxActions txid={REAL} network="testnet" batchIndex={0} />);
    expect(screen.getByRole("button", { name: "Copy transaction id for batch 0" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Explorer/u });
    expect(link).toHaveAttribute("href", expect.stringContaining(REAL));
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByText(/Practice id/u)).toBeNull();
  });

  // covers: REQ-DEMO-001
  it("has the copy button but no explorer for an id practice mode made: it is on no chain, and says so", () => {
    const fake = practiceId(() => new Uint8Array(24).fill(7));
    render(<TxActions txid={fake} network="testnet" batchIndex={1} />);
    expect(screen.getByRole("button", { name: "Copy transaction id for batch 1" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Practice id: on no chain, so no explorer")).toBeInTheDocument();
    // The whole id is still one tap away.
    expect(screen.getByTitle(fake)).toBeInTheDocument();
  });

  // covers: REQ-DEMO-001
  it("is not fooled by an id that only looks like one of practice mode's: the whole marker, at the start", () => {
    const nearly = `${"0".repeat(8)}7072616374696365${"0".repeat(40)}`;
    render(<TxActions txid={nearly} network="testnet" batchIndex={0} />);
    expect(screen.getByRole("link", { name: /Explorer/u })).toBeInTheDocument();
  });
});
