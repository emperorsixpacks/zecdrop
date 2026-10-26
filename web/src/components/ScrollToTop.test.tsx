// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { renderApp } from "@/test/render-app";

import { ScrollToTop } from "./ScrollToTop";

// A page opened by a link or a button starts at its top; going back or forward, and a change that leaves the path alone, move nothing.
// (A real browser's side of this is e2e/scroll.spec.ts: where the page really is after the click.)

function Page() {
  const navigate = useNavigate();
  return (
    <nav>
      <Link to="/b">to b</Link>
      <Link to="/b?x=1">to b, with a search</Link>
      <Link to="/a#section">to a hash of a</Link>
      <button
        type="button"
        onClick={() => {
          void navigate("/c", { replace: true });
        }}
      >
        redirect to c
      </button>
      <button
        type="button"
        onClick={() => {
          void navigate(-1);
        }}
      >
        back
      </button>
    </nav>
  );
}

function show() {
  return render(
    <MemoryRouter initialEntries={["/a"]}>
      <ScrollToTop />
      <Page />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a new page starts at its top", () => {
  it("does nothing when the first page is drawn", () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    show();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("goes to the top when a link opens another page", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("link", { name: "to b" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("goes to the top when a redirect replaces the page too", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "redirect to c" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("moves nothing for a change that leaves the path alone: a search, a hash", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const user = userEvent.setup();
    show();
    // From /a to /a#section: the same path.
    await user.click(screen.getByRole("link", { name: "to a hash of a" }));
    expect(scrollTo).not.toHaveBeenCalled();
    // To /b, which is another page (one call), and then to /b?x=1, which is the same path (no more).
    await user.click(screen.getByRole("link", { name: "to b" }));
    await user.click(screen.getByRole("link", { name: "to b, with a search" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("leaves going back to the browser: it keeps what it kept", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("link", { name: "to b" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "back" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe("in the app", () => {
  it("a link in the footer opens its page at the top", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const user = userEvent.setup();
    renderApp("/");
    expect(scrollTo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("contentinfo").querySelector("a[href='/privacy']") as HTMLElement);
    expect(await screen.findByRole("heading", { level: 1, name: "How privacy works" })).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
