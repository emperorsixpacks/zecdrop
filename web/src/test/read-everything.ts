// What a person could read on the page if they opened everything: the sections behind
// a click, every "Why?" and "?" explanation, what each picture says it shows, and the sheet
// before an irreversible step. The copy guard reads this, so folding text away behind a
// button never takes it out of the guard's reach.

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

export async function readEverything(): Promise<string> {
  const user = userEvent.setup();
  let text = "";

  // Sections behind a click. Opening one can show another, so go round until none is left.
  for (let pass = 0; pass < 4; pass += 1) {
    const closed = Array.from(document.querySelectorAll<HTMLElement>("button[aria-expanded='false']")).filter(
      (button) => button.getAttribute("data-slot") !== "why-trigger" && button.getAttribute("aria-haspopup") === null,
    );
    if (closed.length === 0) break;
    for (const button of closed) await user.click(button);
  }
  text += document.body.textContent ?? "";
  // What a picture says it shows is read out to people who cannot see it, so it is read here too.
  text += ` ${Array.from(document.querySelectorAll("img[alt]"), (img) => img.getAttribute("alt") ?? "").join(" ")}`;

  // Each explanation, one at a time: only one popover is open at once.
  for (const trigger of document.querySelectorAll<HTMLElement>("[data-slot='why-trigger']")) {
    await user.click(trigger);
    text += ` ${document.querySelector("[data-slot='popover-content']")?.textContent ?? ""}`;
    await user.keyboard("{Escape}");
  }

  // A sheet that asks before something that cannot be undone.
  for (const trigger of document.querySelectorAll<HTMLElement>("button[aria-haspopup='dialog']:not([data-slot='why-trigger'])")) {
    await user.click(trigger);
    text += ` ${screen.queryByRole("dialog")?.textContent ?? ""}`;
    await user.keyboard("{Escape}");
  }
  return text;
}
