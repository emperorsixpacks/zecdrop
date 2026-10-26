// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { TxActions } from "./TxActions";

const REAL = "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955";

describe("a transaction id with its actions", () => {
  it("has a copy button and a link to the explorer for a transaction on a chain", () => {
    render(<TxActions txid={REAL} network="testnet" batchIndex={0} />);
    expect(screen.getByRole("button", { name: "Copy transaction id for batch 0" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Explorer/u });
    expect(link).toHaveAttribute("href", expect.stringContaining(REAL));
    expect(link).toHaveAttribute("target", "_blank");
  });

});
