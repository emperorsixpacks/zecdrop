// @vitest-environment jsdom
//
// The viewing key discloses every payout, for good. These tests carry a
// recognisable key through the whole flow (ask, show, copy, hide, leave the
// page, come back) and fail if any part of it turns up anywhere but on screen
// while it is shown: not in browser storage, a URL, a link, the console, the
// query cache, a later request, or the page after it has been hidden.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/dom";
import { clearSession } from "@/api/operator/session";
import { installFakeOperator, replyWith, replyWithGolden, type FakeOperator, type RouteHandler } from "@/test/fake-operator";
import { goldenJson } from "@/test/operator-fixtures";
import { renderApp } from "@/test/render-app";
import cardSource from "./ViewingKeyCard.tsx?raw";
import hooksSource from "../operator/hooks.ts?raw";
import { between } from "@/test/rust-source";

/** Not a real key and not like any other text in the app. */
const KEY = "uviewSENTINEL4f9a1c7e0b8d2635aa91c4e7d03f6b28e5a7c19d4b0f3e86a25c7d91";
const ID = "c-000000000001";

/** Overlapping pieces of the key, so a truncated or re-wrapped copy is caught too. */
function fragments(key: string, size = 14): string[] {
  const out = new Set<string>();
  for (let i = 0; i + size <= key.length; i += 7) out.add(key.slice(i, i + size));
  out.add(key.slice(-size));
  return [...out];
}

const FRAGMENTS = fragments(KEY);

/** Which pieces of the key are in `text` (their count, not their value). */
const found = (text: string): number => FRAGMENTS.filter((f) => text.includes(f)).length;

const health: RouteHandler = () => replyWithGolden("health-real.json");
const exportKey: RouteHandler = () => ({
  body: { ...(goldenJson("audit-ufvk-export.json") as object), campaign_id: ID, ufvk: KEY },
});

let fake: FakeOperator;
let consoleText: string[];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  consoleText = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleText.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  fake = installFakeOperator({
    "GET /api/health": health,
    "GET /api/campaigns": () => replyWith("campaigns-list.json"),
    "GET /api/campaigns/:id": () => replyWithGolden("campaign-real-awaiting-deposit.json"),
    "GET /api/campaigns/:id/audit-ufvk-export": exportKey,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearSession();
});

/** Go back to the campaign from the list, the way a person would. */
async function openCampaignFromList(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("list", { name: "Payouts" });
  const link = screen.getAllByRole("link").find((a) => a.getAttribute("href") === `/campaign/${ID}`);
  if (link === undefined) throw new Error("no link to the campaign in the list");
  await user.click(link);
  await screen.findByRole("button", { name: "Auditor access" });
}

/** The section is closed until it is opened. */
async function openSection(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("button", { name: "Auditor access" });
  if (trigger.getAttribute("aria-expanded") !== "true") await user.click(trigger);
}

async function reveal(user: ReturnType<typeof userEvent.setup>) {
  await openSection(user);
  await user.click(await screen.findByRole("checkbox", { name: /I understand/u }));
  await user.click(screen.getByRole("button", { name: "Show the viewing key" }));
  await screen.findByDisplayValue(KEY);
}

describe("carrying a sentinel key through the whole flow", () => {
  it("is on screen only while shown, and nowhere else at any point", async () => {
    const user = userEvent.setup();
    const view = renderApp(`/campaign/${ID}`, { signedIn: true });

    // Positive control: the scan below would see the key if it were there.
    await reveal(user);
    const box = screen.getByDisplayValue<HTMLTextAreaElement>(KEY);
    expect(found(box.value)).toBe(FRAGMENTS.length);

    await user.click(screen.getByRole("button", { name: "Copy viewing key" }));

    // While it is on screen it is in the box and nowhere else on the page, and not in any link.
    const outsideTheBox = (() => {
      const copy = document.body.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("textarea").forEach((t) => {
        t.remove();
      });
      return copy.innerHTML;
    })();
    expect(found(outsideTheBox), "elsewhere on the page").toBe(0);

    // Hide it, leave the page, come back.
    await user.click(screen.getByRole("button", { name: "Hide key" }));
    expect(found(document.documentElement.outerHTML), "after Hide").toBe(0);

    await reveal(user);
    await user.click(screen.getByRole("link", { name: "All payouts" }));
    await screen.findByRole("heading", { level: 1, name: "Payouts" });
    expect(found(document.documentElement.outerHTML), "after leaving the page").toBe(0);

    await openCampaignFromList(user);
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
    await openSection(user);
    expect(screen.getByRole("button", { name: "Show the viewing key" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /I understand/u })).not.toBeChecked();

    // Everywhere a key could have been put.
    expect(found(JSON.stringify({ ...localStorage })), "localStorage").toBe(0);
    expect(found(JSON.stringify({ ...sessionStorage })), "sessionStorage").toBe(0);
    expect(found(document.cookie), "cookies").toBe(0);
    expect(found(window.location.href), "the address").toBe(0);
    expect(found(document.title), "the title").toBe(0);
    expect(found(JSON.stringify(history.state)), "history state").toBe(0);
    expect(found([...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).join(" ")), "links").toBe(0);
    expect(found(consoleText.join("\n")), "console").toBe(0);

    const cache = view.client;
    expect(found(JSON.stringify(cache.getQueryCache().getAll().map((q) => q.state.data))), "query cache").toBe(0);
    expect(found(JSON.stringify(cache.getMutationCache().getAll().map((m) => [m.state.data, m.state.variables]))), "mutation cache").toBe(0);

    // The key only ever came IN: no request carried any of it.
    expect(found(fake.calls.map((c) => `${c.path} ${JSON.stringify(c.body)}`).join("\n")), "requests").toBe(0);
    // This walks the whole flow through the full app; a loaded machine needs more than the default 5 s.
  }, 30_000);

  it("is gone when the page is left, and coming back does not bring it back", async () => {
    const user = userEvent.setup();
    renderApp(`/campaign/${ID}`, { signedIn: true });
    await reveal(user);
    await user.click(screen.getByRole("link", { name: "All payouts" }));
    await screen.findByRole("heading", { level: 1, name: "Payouts" });
    await openCampaignFromList(user);
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
    expect(fake.to("GET", /audit-ufvk-export$/u)).toHaveLength(1);
  });

  it("a refused request puts nothing of a key in the error", async () => {
    fake = installFakeOperator({
      "GET /api/health": health,
      "GET /api/campaigns/:id": () => replyWithGolden("campaign-real-awaiting-deposit.json"),
      "GET /api/campaigns/:id/audit-ufvk-export": () => replyWithGolden("error-wrong-wallet-seed.json", 409),
    });
    const user = userEvent.setup();
    renderApp(`/campaign/${ID}`, { signedIn: true });
    await openSection(user);
    await user.click(await screen.findByRole("checkbox", { name: /I understand/u }));
    await user.click(screen.getByRole("button", { name: "Show the viewing key" }));
    expect(await screen.findByRole("heading", { name: "This campaign belongs to a different wallet" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Viewing key for/u)).toBeNull();
    expect(found(document.body.innerHTML)).toBe(0);
  });
});

describe("the code that holds the key", () => {
  // Words that mean "kept somewhere": none of them may appear in the card or in
  // the hook that fetches the key.
  const KEPT = /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|navigate\(|console\.|useQuery|useMutation|queryClient|setQueryData|Zustand|zustand|persist/u;

  it("the card never stores, logs, navigates with, or caches it", () => {
    expect(cardSource).not.toMatch(KEPT);
  });

  it("the hook keeps it in its own state only", () => {
    const hook = between(hooksSource, "export function useViewingKey", "// ---- the live event stream");
    expect(hook).not.toMatch(KEPT);
    expect(hook).toMatch(/useState/u);
  });
});
