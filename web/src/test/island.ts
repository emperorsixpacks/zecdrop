import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** The header capsule: the one button that is all of the closed header. Its name starts with the site's name. */
export const island = (): HTMLElement => screen.getByRole("button", { name: /^ZecDrop/u });

/** The panel the capsule opens: the links and the settings. */
export const islandPanel = (): HTMLElement => {
  const id = island().getAttribute("aria-controls");
  const panel = id === null ? null : document.getElementById(id);
  if (panel === null) throw new Error("the capsule does not control a panel");
  return panel;
};

/** Open the capsule, the way a visitor does, and give back the panel's navigation. jsdom does not know `inert`, so a test
 * could reach a link in a closed capsule: tests that choose a link go through here, as the visitor must. */
export async function openIsland(user: UserEvent): Promise<HTMLElement> {
  if (island().getAttribute("aria-expanded") !== "true") await user.click(island());
  return screen.getByRole("navigation", { name: "Primary" });
}
