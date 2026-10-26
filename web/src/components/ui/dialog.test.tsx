// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { Sheet } from "./dialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
        }}
      >
        Ask
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Are you sure?" description="It cannot be undone.">
        <button>Yes</button>
        <button data-autofocus onClick={() => { setOpen(false); }}>
          No
        </button>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("is not there until it is opened", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a dialog with a name and a description, and puts focus on the safe answer", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    const dialog = screen.getByRole("dialog", { name: "Are you sure?" });
    expect(dialog).toHaveAccessibleDescription("It cannot be undone.");
    expect(screen.getByRole("button", { name: "No" })).toHaveFocus();
  });

  it("closes with Escape, with its own button, and with a click on the dim area", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    for (const close of [
      () => user.keyboard("{Escape}"),
      () => user.click(screen.getByRole("button", { name: "No" })),
      () => user.click(document.querySelector("dialog") as HTMLElement),
    ]) {
      await user.click(screen.getByRole("button", { name: "Ask" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await close();
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("is not closed by a late `close` event about an earlier closing, when it was opened again before the event came", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    // The browser tells of the first closing some milliseconds late, when the sheet is open again.
    act(() => {
      dialog.dispatchEvent(new Event("close"));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // A `close` that is true to what the dialog is now still closes the sheet's state, as it always did.
    act(() => {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is the browser's own dialog, so it adds no <style> element for a Content-Security-Policy to refuse", async () => {
    const user = userEvent.setup();
    const before = document.querySelectorAll("style").length;
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(document.querySelectorAll("style")).toHaveLength(before);
  });
});
