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
  it("in a light page, offers the dark theme", () => {
    document.documentElement.dataset["theme"] = "light";
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
  });

  it("in a dark page, offers the light theme", () => {
    document.documentElement.dataset["theme"] = "dark";
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
  });

  it("is an icon: it has no visible words that could read as a status label", () => {
    document.documentElement.dataset["theme"] = "light";
    render(<ThemeToggle />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    // It names the action, so there is no pressed state to misread.
    expect(button).not.toHaveAttribute("aria-pressed");
  });

  it("switches the theme, remembers it, and says what it will do next", async () => {
    const user = userEvent.setup();
    document.documentElement.dataset["theme"] = "light";
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
  });
});
