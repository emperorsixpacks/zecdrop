// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import "@/test/dom";
import { THEME_STORAGE_KEY } from "@/lib/theme";

import { ThemeToggle } from "./ThemeToggle";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

describe("ThemeToggle", () => {
  it("starts unpressed (dark) when no theme is set", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("starts pressed when the page is already light", () => {
    document.documentElement.dataset["theme"] = "light";
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("switches the theme, remembers it, and switches back", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Light theme" });

    await user.click(button);
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(button).toHaveAttribute("aria-pressed", "true");

    await user.click(button);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
});
