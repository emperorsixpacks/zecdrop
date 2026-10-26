// @vitest-environment jsdom
//
// Practice mode runs the operator's own screens against a simulation inside the page (openspec REQ-DEMO-001). This file is
// the proof it is built to pass, and it was written first: the simulation is made to pass it, not the other way round.
//
// A whole practice payout is walked through, from the home page to the simulated receipt, with every way a page can talk to
// anything outside itself replaced by something that records the call and refuses it (src/test/leaks.ts). The payout must
// go through all the same: the simulation answers inside the page. Then practice mode is left, and nothing may remain.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasApiTransport } from "@/api/client";
import { getHealth, listCampaigns } from "@/api/operator/client";
import { clearSession, getToken, useSession } from "@/api/operator/session";
import { useWizardDraft } from "@/features/wizard/draft";
import { hasPracticeFlag, isPracticeId, PRACTICE_BANNER, PRACTICE_KEY, resumePractice, startPractice, stopPractice, usePractice } from "@/lib/practice-mode";
import { activity } from "@/practice/activity";
import { pace } from "@/practice/pace";
import "@/test/dom";
import { watchLeaks, type Leaks } from "@/test/leaks";
import { practicePayout } from "@/test/practice-flow";
import { recordTexts } from "@/test/record-texts";
import { renderApp } from "@/test/render-app";

import example from "../../../examples/demo-recipients.testnet.csv?raw";

/** The example list's own addresses and memos: what must not turn up anywhere the page keeps or sends things. */
const LIST_LINES = example.trim().split("\n").slice(1);
const ADDRESSES = LIST_LINES.map((line) => line.split(",")[0] ?? "");
const MEMOS = LIST_LINES.map((line) => line.split(",")[2] ?? "");

let leaks: Leaks;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearSession();
  useWizardDraft.getState().reset();
  // A step of the simulated run every few milliseconds, so a whole payout takes a moment of the test's time.
  pace.stepMs = 5;
  leaks = watchLeaks();
});

afterEach(() => {
  stopPractice();
  leaks.restore();
  clearSession();
  localStorage.clear();
  sessionStorage.clear();
});

const bannerRegion = () => screen.queryByRole("region", { name: "Practice mode" });

/** The banner is on the screen, says what practice mode is, and has the way out. */
function expectBanner(where: string) {
  const region = bannerRegion();
  expect(region, `the banner on ${where}`).not.toBeNull();
  if (region === null) return;
  expect(region, where).toHaveTextContent(PRACTICE_BANNER);
  expect(within(region).getByRole("button", { name: "Leave practice mode" }), where).toBeInTheDocument();
}

type User = ReturnType<typeof userEvent.setup>;

/** The whole payout, with the banner checked on every screen on the way. */
const payout = (user: User) =>
  practicePayout(user, (where) => {
    expectBanner(where);
    if (where === "the send sheet") {
      // The sheet covers the page, and the banner with it on a phone that has scrolled: the sheet says it too, and it does not
      // say that what it simulates cannot be undone.
      const sheet = screen.getByRole("dialog");
      expect(sheet).toHaveTextContent("Practice mode: nothing is sent anywhere. This only simulates it.");
      expect(sheet).toHaveTextContent("In a real run this cannot be undone.");
      expect(sheet).not.toHaveTextContent("It cannot be undone");
    }
    if (where === "the check screen") {
      // The lens and the privacy notes are on the check screen, with the figures of the example list.
      expect(screen.getByTestId("payout-summary")).toHaveTextContent("8 people");
      expect(screen.getByTestId("payout-summary")).toHaveTextContent("0.005 TAZ");
      expect(screen.getByRole("heading", { level: 2, name: "Who sees what" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: "Privacy warnings" })).toBeInTheDocument();
    }
  });

describe("a whole practice payout", () => {
  // covers: REQ-DEMO-001
  it("goes from the home page to the simulated receipt, and no call leaves the page", async () => {
    const user = userEvent.setup();
    renderApp("/");
    // Practice is off: the home page is the home page, and nothing answers the app's calls in its place.
    expect(bannerRegion()).toBeNull();
    expect(hasApiTransport()).toBe(false);
    expect(activity.requests).toBe(0);

    await payout(user);

    // The simulation answered the app's calls, from inside the page ...
    expect(activity.requests).toBeGreaterThan(10);
    // ... and not one of them was a call to the network, however it is made.
    expect(leaks.network).toEqual([]);
    expect(leaks.databases).toEqual([]);
    expect(leaks.cookies).toEqual([]);
  });

  // covers: REQ-DEMO-001
  it("writes nothing to local storage, cookies or a database, and to session storage only the flag", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await payout(user);

    expect(leaks.storage.filter((write) => write.area !== "session")).toEqual([]);
    expect(leaks.storage).toEqual([{ area: "session", op: "setItem", key: PRACTICE_KEY, value: "1" }]);
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([PRACTICE_KEY]);
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBe("1");
    expect(leaks.cookies).toEqual([]);
    expect(leaks.databases).toEqual([]);
  });

  // covers: REQ-DEMO-001
  it("keeps the list off the console, out of storage and out of the page once the payout exists", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await payout(user);

    const everythingLogged = leaks.console.join("\n");
    const everythingStored = leaks.storage.map((write) => `${write.key}=${write.value}`).join("\n");
    for (const address of ADDRESSES) {
      expect(everythingLogged).not.toContain(address);
      expect(everythingStored).not.toContain(address);
      expect(document.body.innerHTML).not.toContain(address);
    }
    for (const memo of MEMOS) {
      expect(everythingLogged).not.toContain(memo);
      expect(document.body.innerHTML).not.toContain(memo);
    }
    // What the draft held is gone from the wizard too: the list left it when the campaign was made.
    expect(useWizardDraft.getState().csvText).toBe("");
    expect(useWizardDraft.getState().list).toBeNull();
  });

  // covers: REQ-DEMO-001
  it("marks every simulated id as one, and offers no explorer for any of them", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await payout(user);

    // The receipt says it is a practice receipt, and its id is labelled as a practice id.
    expect(screen.getByText(/^Practice id:/u)).toBeInTheDocument();
    expect(screen.getByText("A practice receipt")).toBeInTheDocument();
    // Every id on it begins with the marker, which no chain's id does, so it can be told from a real one by eye and by code:
    // the transaction, the deposit it was funded from, and the list fingerprint.
    await user.click(screen.getByRole("button", { name: "Transaction" }));
    const ids = Array.from(document.querySelectorAll<HTMLElement>("[title]"))
      .map((element) => element.getAttribute("title") ?? "")
      .filter((title) => /^[0-9a-f]{64}(:\d+)?$/u.test(title));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(isPracticeId(id.split(":")[0] ?? ""), id).toBe(true);
    await user.click(screen.getByRole("button", { name: "List fingerprint" }));
    expect(isPracticeId(screen.getByText(/^[0-9a-f]{64}$/u).textContent ?? "")).toBe(true);
    // No link points an explorer at any of it: there is nothing on any chain to find, and the page says so where the link was.
    expect(screen.queryByRole("link", { name: /Explorer/u })).toBeNull();
    expect(screen.getAllByText("Practice id: on no chain, so no explorer").length).toBeGreaterThan(0);
    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href") ?? "", "a link out of the page").not.toMatch(/^https?:/u);
    }
    // And the funding address is said not to exist, rather than "unknown to the verifier".
    await user.click(screen.getByRole("button", { name: "Funding address" }));
    expect(screen.getByText(/A practice payout has no funding address/u)).toBeInTheDocument();
  });

  // covers: REQ-DEMO-001
  it("marks the pretend deposit's id, on the funded campaign, with the marker too", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await practicePayout(user, (where) => {
      if (where !== "the funded campaign") return;
      const deposit = screen.getByText(/in deposit/u).querySelector(".mono[title]")?.getAttribute("title") ?? "";
      expect(isPracticeId(deposit), deposit).toBe(true);
    });
  });

  // covers: REQ-DEMO-001
  it("offers the example list on the empty payouts list too, and carries it to the first screen of a payout", async () => {
    const user = userEvent.setup();
    await startPractice();
    renderApp("/campaigns");
    await user.click(await screen.findByRole("button", { name: "Use the example list" }));
    await screen.findByRole("heading", { level: 1, name: "Add the payouts" });
    expect(await screen.findByTestId("payout-count")).toHaveTextContent("8 people");
    expectBanner("the payouts screen, from the empty list");
  });
});

describe("the words of the run", () => {
  // covers: REQ-DEMO-001
  it("say that it is pretended wherever the operator's screens speak of the network or of a block: the timeline and the activity log", async () => {
    // A step a second, and the test looks at none of them: it records. The page learns of a step by a refresh that waits 150ms
    // after the last event, so the sending step (built, not yet sent: 0.6 of a step) is drawn only if that refresh comes before
    // the next event. At 300ms a step that left a margin of about 30ms, and a busy machine took it. At a second it is 450ms.
    pace.stepMs = 1_000;
    const user = userEvent.setup();
    renderApp("/");
    // Each of these wordings is on the screen for a moment only, and a test that polls for one can look away for just that
    // moment. Recorded, it is in the list when the run is over, if the page showed it at all.
    const recorder = recordTexts();
    await practicePayout(
      user,
      async (where) => {
        expectBanner(where);
        if (where === "the settled campaign") {
          await user.click(screen.getByRole("button", { name: "Activity" }));
          // The log is what the stream has told the page, and the page opens the stream again when the campaign settles, so for a
          // moment after that it is told its story afresh. It is the whole story that is waited for, which stays once it is told.
          await waitFor(
            () => {
              const lines = within(screen.getByRole("log", { name: "Activity log" }))
                .getAllByRole("listitem")
                .map((item) => item.textContent);
              expect(lines).toEqual([
                "Batch 0: transaction built (8 shielded outputs).",
                "Batch 0: pretend-sent (practice).",
                "Batch 0: waiting (simulated), 0 of 3 confirmations.",
                "Batch 0: 1 of 3 confirmations (simulated).",
                "Batch 0: 2 of 3 confirmations (simulated).",
                "Batch 0: 3 of 3 confirmations (simulated).",
                "All 1 batch is confirmed.",
              ]);
            },
            { timeout: 10_000 },
          );
        }
      },
      { settleMs: 20_000 },
    );
    recorder.stop();
    const said = recorder.texts();

    // It was looking: the timeline was on the screen, from its start to its end.
    expect(said).toContain("Sending the payouts");
    expect(said).toContain("All 1 batch is confirmed");
    // The timeline said that the send was pretended, and that the confirmations were simulated ...
    expect(said).toContain("Pretending to send: nothing leaves your browser.");
    expect(said).toContain("0 of 3 confirmations (simulated).");
    // ... and every confirmation it counted said so.
    for (const text of said.filter((line) => /^\d of \d confirmations/u.test(line))) expect(text).toMatch(/\(simulated\)\.$/u);
    // Nowhere on the page, at any moment of the run, was anything said to have been sent to the network, or to wait for a block.
    expect(said.filter((text) => /Sending to the network\.|Waiting for the next block/u.test(text))).toEqual([]);
    expect(said.filter((text) => /to the network|next block/iu.test(text))).toEqual([]);
  }, 90_000);
});

describe("leaving practice mode", () => {
  // covers: REQ-DEMO-001
  it("removes the flag and every handler, and the app talks to the network again", async () => {
    const user = userEvent.setup();
    const { client } = renderApp("/");
    await payout(user);
    expect(hasPracticeFlag()).toBe(true);
    expect(hasApiTransport()).toBe(true);
    expect(client.getQueryCache().findAll({ queryKey: ["operator"] }).length).toBeGreaterThan(0);

    await user.click(within(screen.getByRole("region", { name: "Practice mode" })).getByRole("button", { name: "Leave practice mode" }));

    // Back at the start, and the page is not in practice mode any more.
    await screen.findByRole("heading", { level: 1, name: /Pay many people/u });
    await waitFor(() => {
      expect(bannerRegion()).toBeNull();
    });
    // The flag is gone, nothing answers the app's calls, nothing is still running, and nothing of the payout is held.
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBeNull();
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(hasPracticeFlag()).toBe(false);
    expect(hasApiTransport()).toBe(false);
    expect(usePractice.getState()).toEqual({ on: false, exampleList: null, leaving: false });
    expect(activity.timers).toBe(0);
    expect(activity.streams).toBe(0);
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("no-token");
    expect(useWizardDraft.getState().created).toBeNull();
    expect(client.getQueryCache().findAll({ queryKey: ["operator"] })).toHaveLength(0);
    expect(client.getQueryCache().findAll({ queryKey: ["receipt"] })).toHaveLength(0);

    // The app is itself again: a call to the operator now goes out to the network (which this test refuses).
    expect(leaks.network).toEqual([]);
    await getHealth().catch(() => undefined);
    expect(leaks.network).toEqual(["fetch"]);
  });

  // covers: REQ-DEMO-001
  it("stops a run that is still going: no timer, no stream and no call is left", async () => {
    // A step every second and a half, so the run is certainly still going when it is left, however slow the machine is to get
    // there: the test never needs it to finish. (At 50ms a step the whole run was over in a third of a second, which a busy
    // machine can take longer than to get to look at it.)
    pace.stepMs = 1_500;
    const user = userEvent.setup();
    renderApp("/");
    await user.click(screen.getByRole("button", { name: "Try a practice payout" }));
    await user.click(await screen.findByRole("button", { name: "Use the example list" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("link", { name: "Looks right, continue" }));
    await user.click(await screen.findByRole("button", { name: "Record mock deposit" }));
    await user.click(await screen.findByRole("button", { name: "Send 8 payouts" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send 8 payouts" }));
    await screen.findByRole("heading", { level: 2, name: "Sending the payouts" });
    // The run is under way: something is scheduled and the page is listening.
    await waitFor(() => {
      expect(activity.timers).toBeGreaterThan(0);
      expect(activity.streams).toBeGreaterThan(0);
    });

    await user.click(within(screen.getByRole("region", { name: "Practice mode" })).getByRole("button", { name: "Leave practice mode" }));
    await screen.findByRole("heading", { level: 1, name: /Pay many people/u });
    await waitFor(() => {
      expect(bannerRegion()).toBeNull();
    });
    expect(activity.timers).toBe(0);
    expect(activity.streams).toBe(0);

    // Nothing wakes up afterwards: no step of the run, no new answer, no call to the network. The next step was due no more than
    // a step away, and the page looks again 150ms after an event, so a step and a little more is long enough for anything that
    // was left behind to have come.
    const answered = activity.requests;
    await new Promise((resolve) => setTimeout(resolve, pace.stepMs + 250));
    expect(activity.requests).toBe(answered);
    expect(activity.timers).toBe(0);
    expect(leaks.network).toEqual([]);
  }, 60_000);
});

describe("starting and resuming", () => {
  // covers: REQ-DEMO-001
  it("starts empty every time: reloading starts over", async () => {
    await startPractice();
    const first = await listCampaigns();
    expect(first).toEqual([]);
    expect(hasPracticeFlag()).toBe(true);

    // A reload: the flag is still in the tab's storage, the page's memory is not.
    stopPractice();
    sessionStorage.setItem(PRACTICE_KEY, "1");
    await resumePractice();
    expect(usePractice.getState().on).toBe(true);
    expect(await listCampaigns()).toEqual([]);
  });

  // covers: REQ-DEMO-001
  it("does nothing when the flag is not set", async () => {
    await resumePractice();
    expect(usePractice.getState().on).toBe(false);
    expect(hasApiTransport()).toBe(false);
  });

  // covers: REQ-DEMO-001
  it("leaves practice mode, and starts the app as it normally starts, when the simulation cannot be loaded", async () => {
    sessionStorage.setItem(PRACTICE_KEY, "1");
    await resumePractice(() => Promise.reject(new Error("the chunk did not load")));
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBeNull();
    expect(usePractice.getState().on).toBe(false);
    expect(hasApiTransport()).toBe(false);
    expect(getToken()).toBeNull();
  });

  // covers: REQ-DEMO-001
  it("does not start at all, and says so, when the simulation cannot be loaded from the start button", async () => {
    await expect(startPractice(() => Promise.reject(new Error("the chunk did not load")))).rejects.toThrow();
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBeNull();
    expect(usePractice.getState().on).toBe(false);
    expect(hasApiTransport()).toBe(false);
  });

  // covers: REQ-DEMO-001
  it("is one simulation however many times it is started", async () => {
    await Promise.all([startPractice(), startPractice()]);
    await startPractice();
    expect(hasApiTransport()).toBe(true);
    const created = await getHealth();
    expect(created).toEqual({ network: "testnet", mock: true });
    stopPractice();
    expect(hasApiTransport()).toBe(false);
  });
});

describe("every screen carries the banner", () => {
  const SCREENS: readonly (readonly [string, string, string | RegExp])[] = [
    ["the home page", "/", "Pay many people. Keep who got what private. Prove the total."],
    ["the payouts list", "/campaigns", "Payouts"],
    ["the first stage", "/new", "Add the payouts"],
    ["a stage reached without a list", "/new/check", "Add the payouts first"],
    ["the audit page", "/audit", "Audit"],
    ["the privacy page", "/privacy", "How privacy works"],
    ["the get-paid page", "/get-paid", "Get paid in ZEC"],
    ["the payslip page", "/payslip", "Check a payslip"],
    ["a sample receipt", "/r/demo?demo=real", "Payout receipt"],
    ["a campaign that does not exist", "/campaign/practice-nothing", /Campaign|Payout/u],
    ["a page that does not exist", "/nowhere", "Page not found"],
  ];

  // covers: REQ-DEMO-001
  it.each(SCREENS)("%s", async (_name, path, heading) => {
    await startPractice();
    renderApp(path);
    await screen.findAllByRole("heading", { level: 1, name: heading });
    expectBanner(path);
  });

  // covers: REQ-DEMO-001
  it("is not on any screen when practice mode is off", async () => {
    for (const path of ["/", "/privacy", "/payslip", "/get-paid"]) {
      const { unmount } = renderApp(path);
      await screen.findAllByRole("heading", { level: 1 });
      expect(bannerRegion(), path).toBeNull();
      unmount();
    }
  });
});

describe("the simulation's source", () => {
  const folder = join(process.cwd(), "src", "practice");
  const files = Object.fromEntries(
    readdirSync(folder)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => [name, readFileSync(join(folder, name), "utf8")]),
  );

  // covers: REQ-DEMO-001
  it("names no way to reach the network or to keep anything, so it cannot", () => {
    const entries = Object.entries(files);
    expect(entries.length).toBeGreaterThan(5);
    for (const [name, source] of entries) {
      const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
      for (const forbidden of [
        /\bfetch\b/u,
        /XMLHttpRequest/u,
        /sendBeacon/u,
        /WebSocket/u,
        /EventSource/u,
        /\bXMLHttp/u,
        /localStorage/u,
        /sessionStorage/u,
        /document\.cookie/u,
        /indexedDB/u,
        /window\.open/u,
        /\bnew Image\b/u,
        /\bimportScripts\b/u,
        /\bWorker\b/u,
        /\bconsole\./u,
      ]) {
        expect(code, `${name}: ${String(forbidden)}`).not.toMatch(forbidden);
      }
      // The only import() in it would be a way to fetch more code; there is none.
      expect(code, name).not.toMatch(/\bimport\(/u);
    }
  });

  // covers: REQ-DEMO-001
  it("never says what an address, an amount or a memo was: it is given them once and keeps counts and totals", async () => {
    await startPractice();
    const campaign = await (
      await import("@/api/operator/client")
    ).createCampaign({ name: "Counts only", csv: example, maxOutputsPerBatch: 50, feePolicy: "zip317_text" });
    const everything = JSON.stringify(campaign);
    for (const address of ADDRESSES) expect(everything).not.toContain(address);
    for (const memo of MEMOS) expect(everything).not.toContain(memo);
    expect(campaign.recipientCount).toBe(8);
    expect(campaign.declaredTotal).toBe("500000");
    expect(campaign.feeTotal).toBe("45000");
  });
});
