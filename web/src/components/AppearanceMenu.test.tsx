// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { initAppearance } from "@/lib/appearance";

import { AppearanceMenu } from "./AppearanceMenu";

function system(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduced && query.includes("reduce"), media: query })),
  );
}

const html = () => document.documentElement.dataset;

beforeEach(() => {
  localStorage.clear();
  system(false);
  initAppearance();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  return await screen.findByRole("dialog");
}

describe("the appearance menu", () => {
  it("offers the mode and the motion, with the current ones chosen, and no choice of palette", async () => {
    const user = userEvent.setup();
    render(<AppearanceMenu />);
    await open(user);
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Lively" })).toBeChecked();
    expect(screen.queryByText("Palette")).toBeNull();
    expect(screen.queryByRole("radio", { name: /Ocean|Sunrise|Paper|Midnight/u })).toBeNull();
  });

  it("changes the page the moment a choice is made", async () => {
    const user = userEvent.setup();
    render(<AppearanceMenu />);
    await open(user);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(html()["theme"]).toBe("dark");
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(html()["theme"]).toBe("light");
    await user.click(screen.getByRole("radio", { name: "Calm" }));
    expect(html()["motion"]).toBe("calm");
  });

  it("says why Lively cannot be chosen when the system asks for reduced motion", async () => {
    system(true);
    initAppearance();
    const user = userEvent.setup();
    render(<AppearanceMenu />);
    await open(user);
    expect(screen.getByRole("radio", { name: "Lively" })).toBeDisabled();
    expect(screen.getByText(/system asks for reduced motion, so this stays Calm/u)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Calm" })).toBeChecked();
  });
});
