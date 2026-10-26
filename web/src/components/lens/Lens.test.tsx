// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";

import { LensList, RedactionLens, type LensMode, type LensRow } from "./Lens";

// Strings that stand for a real list. None of them may be in the page while it is hidden.
const ROWS: LensRow[] = [
  { id: "r1", label: "Person 1", address: "u1sentineladdressone0000000000000000", amount: "150000000", memo: "memo-sentinel-one" },
  { id: "r2", label: "Person 2", address: "u1sentineladdresstwo0000000000000000", amount: "225000000", memo: null },
  { id: "r3", label: "Person 3", address: "u1sentineladdressthree00000000000000", amount: "75000000" },
];

const SECRETS = [/u1sentineladdress/u, /memo-sentinel/u, /1\.5\b/u, /2\.25\b/u, /0\.75\b/u];

function Harness({ initial = "public" }: { initial?: LensMode }) {
  const [mode, setMode] = useState<LensMode>(initial);
  const [selected, setSelected] = useState<string | null>("r2");
  return <RedactionLens rows={ROWS} mode={mode} onModeChange={setMode} selectedId={selected} onSelect={setSelected} unit="TAZ" />;
}

describe("the redaction lens", () => {
  // covers: REQ-PRIV-002
  it("public: no address, amount or memo is in the page at all, only bars", () => {
    render(<Harness />);
    const html = document.body.innerHTML;
    for (const secret of SECRETS) expect(html, String(secret)).not.toMatch(secret);
    expect(screen.getAllByRole("img", { name: "hidden" })).toHaveLength(ROWS.length * 2);
    // The labels were made for the list and are always readable.
    expect(screen.getByText("Person 2")).toBeInTheDocument();
  });

  it("one person: exactly the chosen row is revealed, the others stay out of the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "One person" }));

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-revealed"))).toEqual(["false", "true", "false"]);
    expect(within(rows[1] as HTMLElement).getByText(/2\.25 TAZ/u)).toBeInTheDocument();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/u1sentineladdressone|u1sentineladdressthree|memo-sentinel/u);
    expect(html).not.toMatch(/1\.5 TAZ|0\.75 TAZ/u);

    // Picking someone else moves the reveal, and takes the first one's text away again.
    await user.selectOptions(screen.getByLabelText("Who?"), "r3");
    expect(screen.getAllByRole("listitem").map((r) => r.getAttribute("data-revealed"))).toEqual(["false", "false", "true"]);
    expect(document.body.innerHTML).not.toMatch(/2\.25 TAZ/u);
  });

  it("auditor: everything is revealed, memos too", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Auditor" }));
    expect(screen.getAllByRole("listitem").every((r) => r.getAttribute("data-revealed") === "true")).toBe(true);
    expect(screen.getByText("memo-sentinel-one")).toBeInTheDocument();
    expect(screen.queryAllByRole("img", { name: "hidden" })).toHaveLength(0);
  });

  it("going back to public takes the text out of the page again", async () => {
    const user = userEvent.setup();
    render(<Harness initial="auditor" />);
    expect(document.body.innerHTML).toMatch(/memo-sentinel-one/u);
    await user.click(screen.getByRole("radio", { name: "Public" }));
    for (const secret of SECRETS) expect(document.body.innerHTML, String(secret)).not.toMatch(secret);
  });

  it("pressing the chosen lens again leaves it chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Public" }));
    expect(screen.getByRole("radio", { name: "Public" })).toBeChecked();
  });

  it("a row with only a count (the public receipt) is a bar in every lens", () => {
    render(<LensList rows={[{ id: "a", label: "Output 1" }, { id: "b", label: "Output 2" }]} mode="auditor" selectedId={null} unit="TAZ" />);
    expect(screen.getAllByRole("img", { name: "hidden" })).toHaveLength(4);
  });

  it("bars are the same width whatever they hide", () => {
    render(<LensList rows={ROWS} mode="public" selectedId={null} unit="TAZ" />);
    const widths = screen.getAllByRole("img", { name: "hidden" }).map((b) => b.className.split(" ").find((c) => c.startsWith("w-")));
    // Two kinds of bar (address, amount), each one width for every row.
    expect(new Set(widths).size).toBe(2);
  });
});

describe("the wipes", () => {
  function lively() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })),
    );
    document.documentElement.dataset["motion"] = "lively";
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset["motion"];
  });

  it("a cell that is lifted draws its text at once, with a bar wiping away over it, which then goes", async () => {
    lively();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const { container } = render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Auditor" }));

    expect(screen.getByText("memo-sentinel-one")).toBeInTheDocument();
    const covers = container.querySelectorAll(".bar-out");
    expect(covers.length).toBe(ROWS.length * 2);
    for (const cover of covers) expect(cover).toHaveAttribute("aria-hidden", "true");
    // Each row starts a little after the one before it.
    expect((covers[2] as HTMLElement).style.getPropertyValue("--i") || (covers[2]?.parentElement as HTMLElement).style.getPropertyValue("--i")).toBe("1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(container.querySelectorAll(".bar-out")).toHaveLength(0);
    expect(screen.getByText("memo-sentinel-one")).toBeInTheDocument();
  });

  it("a cell that is put back loses its text at once, and a bar wipes in", async () => {
    lively();
    const user = userEvent.setup();
    const { container } = render(<Harness initial="auditor" />);
    await user.click(screen.getByRole("radio", { name: "Public" }));
    for (const secret of SECRETS) expect(document.body.innerHTML, String(secret)).not.toMatch(secret);
    expect(container.querySelectorAll(".bar-in").length).toBe(ROWS.length * 2);
  });

  it("nothing moves the first time the list is drawn", () => {
    lively();
    const { container } = render(<Harness />);
    expect(container.querySelectorAll(".bar-in, .bar-out, .reveal-in")).toHaveLength(0);
  });

  it("nothing moves, and no bar is left over the text, when motion is reduced", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })),
    );
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Auditor" }));
    expect(container.querySelectorAll(".bar-out, .bar-in")).toHaveLength(0);
    expect(screen.getByText("memo-sentinel-one")).toBeInTheDocument();
  });
});
