// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { Segmented } from "./Segmented";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma", disabled: true },
] as const;

function Harness({ start = "a" as "a" | "b" | "c" }) {
  const [value, setValue] = useState<"a" | "b" | "c">(start);
  return (
    <>
      <Segmented label="Pick one" value={value} onValueChange={setValue} options={OPTIONS} />
      <p data-testid="chosen">{value}</p>
    </>
  );
}

describe("Segmented", () => {
  it("is a group of radios, named, with the chosen one checked", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Pick one" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Alpha" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Beta" })).not.toBeChecked();
  });

  it("changes with a click, and a click on the chosen one keeps it chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Beta" }));
    expect(screen.getByTestId("chosen")).toHaveTextContent("b");
    await user.click(screen.getByRole("radio", { name: "Beta" }));
    expect(screen.getByTestId("chosen")).toHaveTextContent("b");
    expect(screen.getByRole("radio", { name: "Beta" })).toBeChecked();
  });

  it("works from the keyboard: Tab in, arrows move, and a disabled option is skipped", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Beta" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("chosen")).toHaveTextContent("b");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveFocus();
  });

  it("draws a thumb behind the options, as decoration only", () => {
    const { container } = render(<Harness />);
    const thumb = container.querySelector("[data-slot='segmented-thumb']");
    expect(thumb).not.toBeNull();
    expect(thumb).toHaveAttribute("aria-hidden", "true");
  });
});
