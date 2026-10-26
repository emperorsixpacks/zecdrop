// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { TOAST_MS, toast, useToast } from "@/lib/toast";

import { CopyButton } from "./CopyButton";
import { Toaster } from "./Toaster";

afterEach(() => {
  vi.useRealTimers();
  useToast.setState({ id: 0, text: null });
});

describe("toasts", () => {
  it("say a thing happened for a moment, then go", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    expect(screen.getByTestId("toast")).toHaveTextContent("");
    act(() => {
      toast("Receipt link copied");
    });
    expect(screen.getByTestId("toast")).toHaveTextContent("Receipt link copied");
    act(() => {
      vi.advanceTimersByTime(TOAST_MS + 50);
    });
    expect(screen.getByTestId("toast")).toHaveTextContent("");
  });

  it("a second message is not cut short by the first one's timer", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast("One");
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 200);
      toast("Two");
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId("toast")).toHaveTextContent("Two");
  });

  it("are hidden from assistive technology: whatever caused one already says so", () => {
    render(<Toaster />);
    expect(screen.getByTestId("toast").closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("a copy button raises one, named from its label", async () => {
    const user = userEvent.setup();
    render(
      <>
        <CopyButton value="x" label="Copy receipt link" />
        <Toaster />
      </>,
    );
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy receipt link" }));
    expect(await screen.findByTestId("toast")).toHaveTextContent("Receipt link copied");
    // And the button still says it to assistive technology, which the toast does not.
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
  });
});
