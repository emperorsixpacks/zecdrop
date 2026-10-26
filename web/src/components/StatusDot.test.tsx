// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/test/dom";
import { phaseLabel } from "@/lib/phase";

import { StatusDot } from "./StatusDot";

describe("StatusDot", () => {
  it.each(["draft", "awaiting_funding", "funded", "sending", "settled", "failed"] as const)("%s always comes with a word, not a colour alone", (phase) => {
    render(<StatusDot phase={{ phase } as never} />);
    expect(screen.getByText(phaseLabel(phase))).toBeInTheDocument();
  });
});
