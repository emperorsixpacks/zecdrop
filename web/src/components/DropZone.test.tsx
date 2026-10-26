// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import "@/test/dom";

import { DropZone } from "./DropZone";

describe("the drop zone", () => {
  it("offers a file and a paste, and no example list, unless it is given one", () => {
    render(<DropZone onList={() => undefined} />);
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "or paste it" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the example list" })).toBeNull();
  });

  // covers: REQ-RUN-003
  it("offers the example list first, when it is given one, and hands over nothing but the press", async () => {
    const onList = vi.fn();
    const onExample = vi.fn();
    const user = userEvent.setup();
    render(<DropZone onList={onList} onExample={onExample} />);
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons.slice(0, 2)).toEqual(["Use the example list", "Choose a file"]);
    await user.click(screen.getByRole("button", { name: "Use the example list" }));
    expect(onExample).toHaveBeenCalledTimes(1);
    expect(onList).not.toHaveBeenCalled();
  });

  it("does not offer it while it is disabled", () => {
    render(<DropZone onList={() => undefined} onExample={() => undefined} disabled />);
    expect(screen.getByRole("button", { name: "Use the example list" })).toBeDisabled();
  });
});
