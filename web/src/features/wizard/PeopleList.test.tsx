// @vitest-environment jsdom
//
// The payout list built in the page, one person at a time (REQ-IMP-002), through the whole app against the operator's
// captured answers. What a person types is on screen while they type it; the page sends it once, as CSV text in the
// create call, and keeps it nowhere else.
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSession } from "@/api/operator/session";
import "@/test/dom";
import { installFakeOperator, replyWith, type FakeOperator } from "@/test/fake-operator";
import { fixtureJson } from "@/test/operator-fixtures";
import { renderApp } from "@/test/render-app";
import { importCsv } from "@/practice/csv";
import { parseZec } from "@/lib/zec";

import { useWizardDraft } from "./draft";

type User = ReturnType<typeof userEvent.setup>;

// Shaped like the mock chain's addresses (letters and digits after a u), recognisable anywhere they turn up.
const ADDRESS = ["u1sentinelpeoplelistaddressone", "u1sentinelpeoplelistaddresstwo", "u1sentinelpeoplelistaddressthree", "u1sentinelpeoplelistaddressfour"];
const NOTE = "memo-sentinel, from the list";

let operator: FakeOperator;

beforeEach(() => {
  useWizardDraft.getState().reset();
  localStorage.clear();
  sessionStorage.clear();
  operator = installFakeOperator({
    "GET /api/health": () => replyWith("health.json"),
    "POST /api/campaigns": () => ({ status: 201, body: fixtureJson("create-valid.json") }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
  useWizardDraft.getState().reset();
});

const person = (n: number) => screen.getByRole("group", { name: `Person ${String(n)}` });
const field = (n: number, label: string) => within(person(n)).getByLabelText(label);

/** Fill person `n` the way a person does: type into each field and leave it. */
async function fill(user: User, n: number, values: { address?: string; amount?: string; note?: string }) {
  if (values.address !== undefined) {
    await user.click(field(n, "Address"));
    await user.paste(values.address);
  }
  if (values.amount !== undefined) {
    await user.click(field(n, "Amount"));
    await user.keyboard(values.amount);
  }
  if (values.note !== undefined) {
    await user.click(field(n, "Note they'll see"));
    await user.paste(values.note);
  }
  await user.tab();
}

async function addPerson(user: User) {
  await user.click(screen.getByRole("button", { name: "Add a person" }));
}

const sentCsv = () => (operator.to("POST", "/api/campaigns")[0]?.body as { csv?: string } | undefined)?.csv ?? "";
const amountsOf = (csv: string) => importCsv(csv).rows.map((row) => row.amount);

describe("the people list", () => {
  // covers: REQ-IMP-002
  it("builds the list one person at a time and sends it as the text the importer reads", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0], amount: "1.5", note: NOTE });
    await addPerson(user);
    // The new person's address takes the focus, so typing goes on there.
    expect(field(2, "Address")).toHaveFocus();
    await fill(user, 2, { address: ADDRESS[1], amount: "0.25" });
    expect(screen.getByTestId("payout-count")).toHaveTextContent("2 people");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Check the payouts" })).toBeInTheDocument();
    const csv = sentCsv();
    expect(csv).toBe(`address,amount,memo\n${ADDRESS[0] ?? ""},1.5,"${NOTE}"\n${ADDRESS[1] ?? ""},0.25,\n`);
    expect(importCsv(csv)).toEqual({
      rows: [
        { address: ADDRESS[0], amount: 150_000_000n, memo: NOTE },
        { address: ADDRESS[1], amount: 25_000_000n, memo: null },
      ],
      errors: [],
    });
    // Once the campaign exists, the list has left the draft (the lens keeps its rows for the Check stage only).
    const draft = useWizardDraft.getState();
    expect(draft.people).toHaveLength(1);
    expect(draft.people[0]).toMatchObject({ address: "", amount: "", memo: "" });
    expect(draft.list).toHaveLength(2);
  });

  it("removes a person, says so, and moves the focus to the one after", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0] });
    await addPerson(user);
    await fill(user, 2, { address: ADDRESS[1] });
    await addPerson(user);
    await fill(user, 3, { address: ADDRESS[2] });

    await user.click(within(person(2)).getByRole("button", { name: "Remove person 2" }));
    expect(screen.getAllByRole("group", { name: /^Person \d$/u })).toHaveLength(2);
    expect(field(2, "Address")).toHaveValue(ADDRESS[2]);
    expect(field(2, "Address")).toHaveFocus();
    expect(within(screen.getByTestId("people-list")).getByRole("status")).toHaveTextContent("Person 2 removed.");
    // The last one left cannot be removed, only emptied.
    await user.click(within(person(2)).getByRole("button", { name: "Remove person 2" }));
    expect(within(person(1)).queryByRole("button", { name: /Remove/u })).toBeNull();
  });

  // covers: REQ-IMP-002
  it("splits a total evenly into exactly equal shares, and says when a little is left out to keep them equal", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0] });
    await addPerson(user);
    await fill(user, 2, { address: ADDRESS[1] });
    await addPerson(user);
    await fill(user, 3, { address: ADDRESS[2] });

    await user.click(screen.getByRole("radio", { name: "Even" }));
    await user.type(screen.getByLabelText("Total to split"), "0.01");
    for (const n of [1, 2, 3]) expect(person(n)).toHaveTextContent("0.00333333 TAZ");
    expect(screen.getByText(/^Each gets 0\.00333333 TAZ\. That is 0\.00999999 TAZ in all/u)).toBeInTheDocument();
    expect(screen.getByTestId("payout-total")).toHaveTextContent("0.00999999 TAZ");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check the payouts" });
    expect(amountsOf(sentCsv())).toEqual([333_333n, 333_333n, 333_333n]);
  });

  // covers: REQ-IMP-002
  it("draws a lucky split that adds up to the total, is never all the same, and can be drawn again", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    for (const [i, address] of ADDRESS.entries()) {
      if (i > 0) await addPerson(user);
      await fill(user, i + 1, { address });
    }
    await user.click(screen.getByRole("radio", { name: "Lucky" }));
    await user.type(screen.getByLabelText("Total to split"), "1");
    expect(screen.getByText("Random shares: they can't be worked out from the total.")).toBeInTheDocument();
    const shown = () => useWizardDraft.getState().people.map((p) => p.amount);
    const first = shown();
    expect(first.reduce((sum, amount) => sum + parseZec(amount), 0n)).toBe(100_000_000n);
    expect(new Set(first).size).toBeGreaterThan(1);

    await user.click(screen.getByRole("button", { name: "Shuffle again" }));
    expect(within(screen.getByTestId("people-list")).getByRole("status")).toHaveTextContent("New shares drawn.");
    expect(shown()).not.toEqual(first);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check the payouts" });
    const sent = amountsOf(sentCsv());
    expect(sent.reduce((a, b) => a + b, 0n)).toBe(100_000_000n);
    for (const amount of sent) expect(amount >= 100_000_000n / 4n / 2n).toBe(true);
  });

  it("starts a split from what the typed amounts add up to", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0], amount: "1" });
    await addPerson(user);
    await fill(user, 2, { address: ADDRESS[1], amount: "2" });
    await user.click(screen.getByRole("radio", { name: "Even" }));
    expect(screen.getByLabelText("Total to split")).toHaveValue("3");
    expect(person(1)).toHaveTextContent("1.5 TAZ");
    // Back to one by one: the shares stay, now to edit.
    await user.click(screen.getByRole("radio", { name: "Set each" }));
    expect(field(2, "Amount")).toHaveValue("1.5");
  });

  it("shows a row's problem once the field is left, and every problem on Continue, sending nothing", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0], amount: "1,5" });
    expect(within(person(1)).getByText("Write it with a dot, like 0.5, and no spaces.")).toBeInTheDocument();
    expect(field(1, "Amount")).toHaveAttribute("aria-invalid", "true");
    await addPerson(user);
    // Nothing is said about a field nobody has left yet.
    expect(within(person(2)).queryByText("Add their address.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    const summary = await screen.findByText("3 problems to fix.");
    expect(summary).toHaveAttribute("role", "alert");
    expect(summary).toHaveFocus();
    expect(within(person(2)).getByText("Add their address.")).toBeInTheDocument();
    expect(within(person(2)).getByText("Add an amount.")).toBeInTheDocument();
    expect(operator.to("POST", "/api/campaigns")).toHaveLength(0);
    // Typing again takes the summary away.
    fireEvent.change(field(1, "Amount"), { target: { value: "1.5" } });
    expect(screen.queryByText("3 problems to fix.")).toBeNull();
  });

  it("says the same address twice and a note too long on the row, and hints at an address that looks wrong", async () => {
    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0], amount: "1" });
    await addPerson(user);
    await fill(user, 2, { address: (ADDRESS[0] ?? "").toUpperCase(), amount: "1", note: "x".repeat(513) });
    expect(within(person(2)).getByText("The same address as person 1.")).toBeInTheDocument();
    expect(within(person(2)).getByText("The note is too long: 513 of 512 bytes.")).toBeInTheDocument();

    // A public address is only a hint here: the operator is the one that refuses it.
    fireEvent.change(field(2, "Address"), { target: { value: "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD" } });
    expect(within(person(2)).getByText("This address is public. Ask for their private one, starting with utest1.")).toBeInTheDocument();
    expect(field(2, "Address")).toHaveAttribute("aria-invalid", "false");
  });

  it("puts what the operator says about a line with the person on it", async () => {
    installFakeOperator({
      "GET /api/health": () => replyWith("health.json"),
      "POST /api/campaigns": () => replyWith("create-row-errors.json", 422),
    });
    const said = (fixtureJson("create-row-errors.json") as { error: { errors: { line: number; message: string }[] } }).error.errors;
    const onLine3 = said.filter((error) => error.line === 3).map((error) => error.message);
    expect(onLine3.length).toBeGreaterThan(0);

    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0], amount: "1" });
    await addPerson(user);
    await fill(user, 2, { address: ADDRESS[1], amount: "1" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/problems to fix\./u)).toBeInTheDocument();
    // Line 3 is person 2: the operator's own sentence is on that row, word for word.
    for (const message of onLine3) expect(within(person(2)).getByText(message)).toBeInTheDocument();
    expect(within(person(1)).queryByText(onLine3[0] ?? "")).toBeNull();
    // A change to the list drops the old verdict.
    fireEvent.change(field(2, "Address"), { target: { value: ADDRESS[2] } });
    expect(screen.queryByText(/problems to fix\./u)).toBeNull();
  });
});

describe("what the people list keeps", () => {
  // covers: REQ-IMP-002
  it("keeps the list off the console, out of storage and the address bar, and out of every request but the create call", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const stored: string[] = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
      stored.push(`${key}=${value}`);
    });

    const user = userEvent.setup();
    renderApp("/new", { signedIn: true });
    await fill(user, 1, { address: ADDRESS[0], amount: "2.25", note: NOTE });
    await addPerson(user);
    await fill(user, 2, { address: ADDRESS[1] });
    await user.click(screen.getByRole("radio", { name: "Lucky" }));
    // The total starts as what the typed amounts add up to; type another over it.
    await user.clear(screen.getByLabelText("Total to split"));
    await user.type(screen.getByLabelText("Total to split"), "4.125");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check the payouts" });

    const needles = [ADDRESS[0] ?? "", ADDRESS[1] ?? "", "memo-sentinel"];
    const notCreate = operator.calls.filter((call) => !(call.method === "POST" && call.path === "/api/campaigns"));
    expect(operator.to("POST", "/api/campaigns")).toHaveLength(1);
    for (const needle of needles) {
      expect(logged.join("\n")).not.toContain(needle);
      expect(stored.join("\n")).not.toContain(needle);
      expect(window.location.href).not.toContain(needle);
      for (const call of notCreate) expect(`${call.path} ${JSON.stringify(call.body ?? null)} ${JSON.stringify([...call.headers])}`).not.toContain(needle);
      // The Check stage shows the list through the lens, as bars: none of it is in the page.
      expect(document.body.innerHTML).not.toContain(needle);
    }
    expect(JSON.stringify(useWizardDraft.getState().people)).not.toMatch(/sentinel/u);
  });
});
