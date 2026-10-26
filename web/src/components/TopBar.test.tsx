// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { island, islandPanel, openIsland } from "@/test/island";

import { TopBar } from "./TopBar";

type Props = Parameters<typeof TopBar>[0];

function show(props: Props, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar {...props} />
    </MemoryRouter>,
  );
}

/** The capsule's element, the one that is open or closed. */
const capsuleOf = () => island().closest(".island") as HTMLElement;

const PUBLIC_LABELS = ["Make a payout", "Home", "Sample receipt", "Get paid", "Check a payslip", "How privacy works"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the capsule, closed", () => {
  it("is one button that names the site, the page and the network, and says it is closed", () => {
    show({ showOperatorNav: false });
    expect(island()).toHaveAccessibleName("ZecDrop Home testnet");
    expect(island().closest("header")).toBe(screen.getByRole("banner"));
    expect(island()).toHaveAttribute("aria-expanded", "false");
    expect(island()).toHaveAttribute("aria-controls", islandPanel().id);
    // Its name is made of what it shows: no label of its own that could say something else.
    expect(island()).not.toHaveAttribute("aria-label");
    // One button, not a row of controls: a button cannot hold a link.
    expect(within(island()).queryAllByRole("link")).toHaveLength(0);
  });

  it.each([
    ["/", false, "Home"],
    ["/r/demo", false, "Receipt"],
    ["/get-paid", false, "Get paid"],
    ["/payslip", false, "Payslip"],
    ["/privacy", false, "How privacy works"],
    ["/nope", false, "ZecDrop"],
    ["/campaigns", true, "Payouts"],
    ["/new/check", true, "New payout"],
    ["/campaign/x", true, "Payout"],
    ["/audit", true, "Audit"],
  ])("on %s it names the page %s", (path, operator, name) => {
    show({ showOperatorNav: operator }, path);
    expect(island()).toHaveTextContent(new RegExp(`${name}\\s*(testnet|Mainnet)$`, "u"));
  });

  it("says the name of the site once on a page that has no name of its own", () => {
    show({ showOperatorNav: false }, "/nope");
    expect(island()).toHaveAccessibleName("ZecDrop testnet");
  });

  it("has its links out of reach: the panel is inert until it is opened", () => {
    show({ showOperatorNav: false });
    expect(islandPanel()).toHaveAttribute("inert");
    expect(within(islandPanel()).getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("does not move on its own: its transitions are off until it is opened or closed", () => {
    show({ showOperatorNav: false });
    expect(capsuleOf()).toHaveAttribute("data-morph", "false");
  });
});

describe("the network on the capsule", () => {
  it("is quiet text on testnet, which is the default", () => {
    show({ showOperatorNav: false, network: "testnet" });
    const chip = within(island()).getByText("testnet");
    expect(chip).toHaveAttribute("data-network", "testnet");
    expect(within(island()).queryByText("Mainnet")).toBeNull();
  });

  it("is loud on mainnet, where the coins are real, and names the network on the capsule itself", () => {
    show({ showOperatorNav: false, network: "mainnet" });
    expect(island()).toHaveAccessibleName("ZecDrop Home Mainnet");
    expect(within(island()).getByText("Mainnet")).toHaveAttribute("data-network", "mainnet");
    expect(within(island()).queryByText("testnet")).toBeNull();
  });

  it("is said in full in the open panel", async () => {
    const user = userEvent.setup();
    const { unmount } = show({ showOperatorNav: false, network: "mainnet" });
    await openIsland(user);
    expect(within(islandPanel()).getByText("Zcash mainnet")).toBeInTheDocument();
    unmount();
    show({ showOperatorNav: false, network: "testnet" });
    expect(within(islandPanel()).getByText("Zcash testnet")).toBeInTheDocument();
    expect(screen.queryByText("Zcash mainnet")).toBeNull();
  });
});

describe("opening the capsule", () => {
  it("opens on a click, and closes on the next", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await user.click(island());
    expect(island()).toHaveAttribute("aria-expanded", "true");
    expect(islandPanel()).not.toHaveAttribute("inert");
    await user.click(island());
    expect(island()).toHaveAttribute("aria-expanded", "false");
    expect(islandPanel()).toHaveAttribute("inert");
  });

  it("opens with Enter and with Space, as a button does", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    island().focus();
    await user.keyboard("{Enter}");
    expect(island()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(island()).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(island()).toHaveAttribute("aria-expanded", "true");
  });

  // covers: REQ-RUN-002
  it("holds the six public links, in order, with Make a payout first: on the operator's own page, its payouts", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false }, "/privacy");
    const nav = await openIsland(user);
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(PUBLIC_LABELS);
    // On the public site the first is the page that says how to run ZecDrop (HostedNotice.test.tsx).
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/campaigns", "/", "/r/demo?demo=real", "/get-paid", "/payslip", "/privacy"]);
    for (const label of PUBLIC_LABELS) expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
  });

  it("marks the page you are on with aria-current, and the highlighter", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false }, "/privacy");
    const nav = await openIsland(user);
    const current = within(nav).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual(["How privacy works"]);
    // The highlighter is on the label, and the heavier type says it too.
    expect(current[0]?.firstElementChild).toHaveClass("bg-marker", "font-extrabold");
    expect(within(nav).getByRole("link", { name: "Get paid" }).firstElementChild).not.toHaveClass("bg-marker");
  });

  it("marks Home only on the home page, not on every page", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false }, "/get-paid");
    const nav = await openIsland(user);
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("holds the theme and the appearance settings in a footer row", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await openIsland(user);
    expect(within(islandPanel()).getByRole("button", { name: /^Switch to (dark|light) theme$/u })).toBeInTheDocument();
    expect(within(islandPanel()).getByRole("button", { name: "Appearance" })).toBeInTheDocument();
  });
});

describe("closing the capsule", () => {
  it("closes on Escape and gives the focus back to the capsule", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await openIsland(user);
    within(islandPanel()).getByRole("link", { name: "Get paid" }).focus();
    await user.keyboard("{Escape}");
    expect(island()).toHaveAttribute("aria-expanded", "false");
    expect(island()).toHaveFocus();
  });

  it("does nothing on Escape when it is closed", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await user.keyboard("{Escape}");
    expect(island()).toHaveAttribute("aria-expanded", "false");
    expect(island()).not.toHaveFocus();
  });

  it("closes on a press anywhere outside it, and does not take the focus from what was pressed", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TopBar showOperatorNav={false} />
        <button type="button">elsewhere on the page</button>
      </MemoryRouter>,
    );
    await openIsland(user);
    await user.click(screen.getByRole("button", { name: "elsewhere on the page" }));
    expect(island()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "elsewhere on the page" })).toHaveFocus();
  });

  it("closes on a press on bare page", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await openIsland(user);
    await user.click(document.body);
    expect(island()).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open on a press inside it, on its panel as much as on its links", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await openIsland(user);
    await user.click(within(islandPanel()).getByText("Zcash testnet"));
    expect(island()).toHaveAttribute("aria-expanded", "true");
    await user.click(within(islandPanel()).getByRole("button", { name: /^Switch to (dark|light) theme$/u }));
    expect(island()).toHaveAttribute("aria-expanded", "true");
  });

  it("closes when the focus goes to something outside it, and not when it moves about inside", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TopBar showOperatorNav={false} />
        <button type="button">elsewhere on the page</button>
      </MemoryRouter>,
    );
    await openIsland(user);
    const focus = (element: HTMLElement) => {
      act(() => {
        element.focus();
      });
    };
    focus(within(islandPanel()).getByRole("link", { name: "Home" }));
    focus(within(islandPanel()).getByRole("link", { name: "Get paid" }));
    expect(island()).toHaveAttribute("aria-expanded", "true");
    focus(screen.getByRole("button", { name: "elsewhere on the page" }));
    expect(island()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on choosing a link, and the focus waits on the capsule", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    const nav = await openIsland(user);
    await user.click(within(nav).getByRole("link", { name: "How privacy works" }));
    expect(island()).toHaveAttribute("aria-expanded", "false");
    expect(island()).toHaveFocus();
  });

  it("closes on a new page, however the visitor got there", async () => {
    const user = userEvent.setup();
    const go: { current: (to: string) => void } = { current: () => undefined };
    function Remote() {
      const navigate = useNavigate();
      go.current = (to) => {
        void navigate(to);
      };
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Remote />
        <TopBar showOperatorNav={false} />
      </MemoryRouter>,
    );
    await openIsland(user);
    expect(island()).toHaveAttribute("aria-expanded", "true");
    // The back button, or a link in the page: no press on the capsule, and nothing outside it pressed.
    act(() => {
      go.current("/privacy");
    });
    await waitFor(() => {
      expect(island()).toHaveAttribute("aria-expanded", "false");
    });
    expect(island()).toHaveAccessibleName("ZecDrop How privacy works testnet");
    // And it opens again on the new page.
    await user.click(island());
    expect(island()).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the appearance panel's Escape for the panel: that closes the panel, and the capsule stays open", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await openIsland(user);
    await user.click(within(islandPanel()).getByRole("button", { name: "Appearance" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(island()).toHaveAttribute("aria-expanded", "true");
    // The next Escape is the capsule's.
    await user.keyboard("{Escape}");
    expect(island()).toHaveAttribute("aria-expanded", "false");
  });

  it("takes the appearance panel with it when it closes, so that panel is not left open on a page it has no way back from", async () => {
    const user = userEvent.setup();
    const go: { current: (to: string) => void } = { current: () => undefined };
    function Remote() {
      const navigate = useNavigate();
      go.current = (to) => {
        void navigate(to);
      };
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Remote />
        <TopBar showOperatorNav={false} />
      </MemoryRouter>,
    );
    await openIsland(user);
    await user.click(within(islandPanel()).getByRole("button", { name: "Appearance" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    act(() => {
      go.current("/privacy");
    });
    await waitFor(() => {
      expect(island()).toHaveAttribute("aria-expanded", "false");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open while the appearance panel, which is drawn outside it, is used", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    await openIsland(user);
    await user.click(within(islandPanel()).getByRole("button", { name: "Appearance" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Calm" }));
    expect(island()).toHaveAttribute("aria-expanded", "true");
  });
});

describe("how the capsule moves", () => {
  it("holds its transitions on only while it is being opened or closed", async () => {
    const user = userEvent.setup();
    show({ showOperatorNav: false });
    // Recorded, not looked at: the transitions are on for 450ms after a press, and a test that looks at the flag after the
    // press can look too late, on a slow machine, to see it on. The observer sees each change as it is made.
    const flag: (string | null)[] = [];
    const watcher = new MutationObserver(() => {
      flag.push(capsuleOf().getAttribute("data-morph"));
    });
    watcher.observe(capsuleOf(), { attributes: true, attributeFilter: ["data-morph"] });
    expect(capsuleOf()).toHaveAttribute("data-morph", "false");

    await user.click(island());
    await waitFor(() => {
      expect(flag).toEqual(["true", "false"]);
    });
    expect(capsuleOf()).toHaveAttribute("data-open", "true");

    flag.length = 0;
    await user.click(island());
    await waitFor(() => {
      expect(flag).toEqual(["true", "false"]);
    });
    expect(capsuleOf()).toHaveAttribute("data-open", "false");
    watcher.disconnect();
  });

  it("is as wide as its row, in pixels, once that is measured: a width to grow from", () => {
    let notify: () => void = () => undefined;
    class Watcher {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", Watcher);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 257.25 } as DOMRect);
    show({ showOperatorNav: false });
    expect(capsuleOf().style.getPropertyValue("--island-w")).toBe("");
    act(() => {
      notify();
    });
    expect(capsuleOf().style.getPropertyValue("--island-w")).toBe("258px");
  });
});

describe("the operator's header", () => {
  it("is Payouts and Audit in the panel, and the state of the chain in a line of its own under the capsule", () => {
    show({ showOperatorNav: true, mock: true }, "/campaigns");
    const nav = within(islandPanel()).getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Payouts", "Audit"]);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Fake chain: nothing is sent to Zcash");
    // Seen without opening anything: not in the panel, which is closed.
    expect(islandPanel()).not.toContainElement(status);
    expect(island()).not.toContainElement(status);
    expect(within(island()).getByText("testnet")).toBeInTheDocument();
  });

  it("says when the chain is not known, in the same line", () => {
    show({ showOperatorNav: true, modeUnknown: true }, "/campaigns");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Chain mode unknown: fake-chain controls hidden");
    expect(islandPanel()).not.toContainElement(status);
  });

  it("has no such line when there is nothing to say", () => {
    show({ showOperatorNav: true }, "/campaigns");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("has the one button once, at the end of the capsule and not in the closed panel, so it is one press away", () => {
    show({ showOperatorNav: true }, "/campaigns");
    const links = screen.getAllByRole("link", { name: "New payout" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/new");
    expect(islandPanel()).not.toContainElement(links[0] as HTMLElement);
    expect(islandPanel()).toHaveAttribute("inert");
    // Its end of the capsule: next to the button, in the row that is the closed capsule.
    expect(links[0]?.parentElement).toBe(island().parentElement);
  });

  it("highlights it on the payouts page, where starting one is the point, and is quiet elsewhere", () => {
    const { unmount } = show({ showOperatorNav: true }, "/campaigns");
    expect(screen.getByRole("link", { name: "New payout" })).toHaveClass("bg-island-ink");
    unmount();
    show({ showOperatorNav: true }, "/audit");
    expect(screen.getByRole("link", { name: "New payout" })).not.toHaveClass("bg-island-ink");
  });

  it.each(["/new", "/new/check", "/new/send"])("does not offer it while paying, on %s", (path) => {
    show({ showOperatorNav: true }, path);
    expect(screen.queryByRole("link", { name: "New payout" })).toBeNull();
  });

  it("offers it nowhere on a public page", () => {
    show({ showOperatorNav: false }, "/");
    expect(screen.queryByRole("link", { name: "New payout" })).toBeNull();
  });
});

