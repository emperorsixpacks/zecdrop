// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { Timeline, type TimelineStep } from "./Timeline";

const STEPS: TimelineStep[] = [
  { key: "a", label: "Preparing", state: "done" },
  { key: "b", label: "Proving", state: "active", detail: "About 10 seconds." },
  { key: "c", label: "Sending", state: "next", detail: "never shown while it is not yet" },
];

describe("Timeline", () => {
  it("is a list with one item per step, named", () => {
    render(<Timeline steps={STEPS} label="Sending progress" />);
    const items = within(screen.getByRole("list", { name: "Sending progress" })).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "active", "next"]);
  });

  it("says each state in words, so a picture is never the only thing that says it", () => {
    render(<Timeline steps={[...STEPS, { key: "d", label: "Confirming", state: "failed", detail: "It failed." }]} label="x" />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Preparing (done)");
    expect(items[1]).toHaveTextContent("Proving (in progress)");
    expect(items[2]).toHaveTextContent("Sending (not yet)");
    expect(items[3]).toHaveTextContent("Confirming (failed)");
  });

  it("marks only the step in progress as the current one, and shows detail only for steps that have started", () => {
    render(<Timeline steps={STEPS} label="x" />);
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Proving");
    expect(screen.getByText("About 10 seconds.")).toBeInTheDocument();
    expect(screen.queryByText(/never shown/u)).toBeNull();
  });

  it("draws the pictures as decoration", () => {
    const { container } = render(<Timeline steps={STEPS} label="x" />);
    for (const marker of container.querySelectorAll("li > span")) expect(marker).toHaveAttribute("aria-hidden", "true");
  });
});
