// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { Disclosure } from "./Disclosure";

describe("Disclosure", () => {
  it("is closed until asked, and its text is not on the page while it is", async () => {
    const user = userEvent.setup();
    render(<Disclosure summary="Details">the detail</Disclosure>);
    const button = screen.getByRole("button", { name: "Details" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("the detail")).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("the detail")).toBeInTheDocument();
  });

  it("opens and closes by the keyboard", async () => {
    const user = userEvent.setup();
    render(<Disclosure summary="Details">the detail</Disclosure>);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByText("the detail")).toBeInTheDocument();
    await user.keyboard(" ");
    expect(screen.queryByText("the detail")).toBeNull();
  });

  it("can be opened from outside, and says so to the page", async () => {
    const user = userEvent.setup();
    function Outside() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            onClick={() => {
              setOpen(true);
            }}
          >
            Open it
          </button>
          <Disclosure summary="Details" open={open} onOpenChange={setOpen}>
            the detail
          </Disclosure>
        </>
      );
    }
    render(<Outside />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    expect(screen.getByText("the detail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.queryByText("the detail")).toBeNull();
  });

  it("is a panel whose height animates from nothing (the grid-rows trick), so it does not jump", async () => {
    const user = userEvent.setup();
    render(<Disclosure summary="Details">the detail</Disclosure>);
    await user.click(screen.getByRole("button", { name: "Details" }));
    const panel = screen.getByText("the detail").closest(".accordion-panel");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("data-state", "open");
    expect(panel?.querySelector(".accordion-inner")).not.toBeNull();
  });
});
