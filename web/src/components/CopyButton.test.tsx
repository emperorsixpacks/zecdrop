// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";

import { CopyButton } from "./CopyButton";

const VALUE = "a".repeat(64);
const LABEL = "Copy transaction id for batch 0";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: spy }, configurable: true });
  return spy;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

describe("CopyButton", () => {
  it("is named for what it copies, and starts with the visible word", () => {
    render(<CopyButton value={VALUE} label={LABEL} />);
    const button = screen.getByRole("button", { name: LABEL });
    expect(button).toHaveTextContent("Copy");
    expect(LABEL.startsWith(button.textContent)).toBe(true);
  });

  it("copies the full value and announces it", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard(() => Promise.resolve());
    render(<CopyButton value={VALUE} label={LABEL} />);

    await user.click(screen.getByRole("button", { name: LABEL }));

    expect(writeText).toHaveBeenCalledWith(VALUE);
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent("Copied");
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
  });

  it("says so when the clipboard refuses", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error("denied")));
    render(<CopyButton value={VALUE} label={LABEL} />);

    await user.click(screen.getByRole("button", { name: LABEL }));

    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent("Copy failed");
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy");
  });

  it("says so when there is no clipboard at all (plain http)", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<CopyButton value={VALUE} label={LABEL} />);

    await user.click(screen.getByRole("button", { name: LABEL }));

    expect(screen.getByRole("status")).toHaveTextContent("Could not copy");
  });

  it("returns to Copy after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    stubClipboard(() => Promise.resolve());
    render(<CopyButton value={VALUE} label={LABEL} />);

    await user.click(screen.getByRole("button", { name: LABEL }));
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent("Copied");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent(/^Copy$/u);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("does not update after unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    stubClipboard(() => Promise.resolve());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<CopyButton value={VALUE} label={LABEL} />);

    await user.click(screen.getByRole("button", { name: LABEL }));
    unmount();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
