// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { OperatorBatchList } from "./OperatorBatchList";

describe("the batch list of a payout with no batches yet", () => {
  it("says so kindly and says when they appear, instead of leaving a blank", () => {
    render(<OperatorBatchList campaign={{ batches: [], network: "testnet", phase: { phase: "awaiting_funding" } }} />);
    const empty = screen.getByTestId("batches-empty");
    expect(empty).toHaveTextContent("No batches yet");
    expect(empty).toHaveTextContent("Each batch of payouts shows up here, with its transaction and fee, once the payout is sent.");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
