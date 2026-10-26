// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { Tracker } from "./Tracker";

const STAGES = [
  { key: "payouts", label: "Payouts", to: "/new" },
  { key: "check", label: "Check", to: "/new/check" },
  { key: "send", label: "Send" },
];

function at(current: number) {
  return render(
    <MemoryRouter>
      <Tracker stages={STAGES} current={current} />
    </MemoryRouter>,
  );
}

describe("Tracker", () => {
  it("names the stage you are on, and only that one", () => {
    at(1);
    const nav = screen.getByRole("navigation", { name: "Progress" });
    const current = nav.querySelectorAll("[aria-current='step']");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Check");
  });

  it("lets you go back to a finished stage, but not forward to one you have not reached", () => {
    at(2);
    expect(screen.getByRole("link", { name: /Payouts/u })).toHaveAttribute("href", "/new");
    expect(screen.getByRole("link", { name: /Check/u })).toHaveAttribute("href", "/new/check");
    expect(screen.queryByRole("link", { name: /Send/u })).toBeNull();
  });

  it("says in words that a stage is done, not only with a tick", () => {
    at(1);
    expect(screen.getAllByText("(done)")).toHaveLength(1);
  });

  it("the first stage has nothing behind it to link to", () => {
    at(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
