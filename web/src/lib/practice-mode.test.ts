// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasApiTransport } from "@/api/client";
import { getCampaign, getHealth, listCampaigns } from "@/api/operator/client";
import { subscribeToEvents } from "@/api/operator/events";
import { adoptTokenFromText, clearSession, getToken, PRACTICE_TOKEN, useSession } from "@/api/operator/session";
import { watchLeaks, type Leaks } from "@/test/leaks";

import {
  beginLeavingPractice,
  hasPracticeFlag,
  isPracticeId,
  PRACTICE_BANNER,
  PRACTICE_KEY,
  PRACTICE_MARKER,
  practiceId,
  resumePractice,
  startPractice,
  stopPractice,
  usePractice,
  type SimulationLoader,
} from "./practice-mode";

let leaks: Leaks | null = null;

beforeEach(() => {
  sessionStorage.clear();
  clearSession();
});

afterEach(() => {
  stopPractice();
  leaks?.restore();
  leaks = null;
  vi.unstubAllGlobals();
  sessionStorage.clear();
  clearSession();
});

describe("the marker that says a value is simulated", () => {
  it("is the ASCII of 'practice', so anyone who decodes an id can read what it is", () => {
    expect(PRACTICE_MARKER).toBe(Array.from("practice", (character) => character.charCodeAt(0).toString(16)).join(""));
    expect(PRACTICE_MARKER).toHaveLength(16);
  });

  it("makes ids of 64 hex characters that begin with it, from the randomness it is given", () => {
    const id = practiceId(() => Uint8Array.from({ length: 24 }, (_, i) => i));
    expect(id).toBe(`${PRACTICE_MARKER}000102030405060708090a0b0c0d0e0f1011121314151617`);
    expect(isPracticeId(id)).toBe(true);
    // And from the browser's own, by default: two are not the same.
    expect(practiceId()).not.toBe(practiceId());
    expect(isPracticeId(practiceId())).toBe(true);
  });

  it("is told only by an id that is one: 64 lowercase hex, beginning with the marker", () => {
    const good = practiceId(() => new Uint8Array(24).fill(0xab));
    expect(isPracticeId(good)).toBe(true);
    expect(isPracticeId(good.toUpperCase())).toBe(false);
    expect(isPracticeId(good.slice(0, 63))).toBe(false);
    expect(isPracticeId(`${good}0`)).toBe(false);
    expect(isPracticeId(`g${good.slice(1)}`)).toBe(false);
    expect(isPracticeId("ab".repeat(32))).toBe(false);
    expect(isPracticeId("")).toBe(false);
    // A real transaction id of the same length that happens to start with other bytes is not one.
    expect(isPracticeId(`7072616374696364${"0".repeat(48)}`)).toBe(false);
  });
});

describe("the banner's words", () => {
  it("say that everything is simulated, that nothing real or networked is involved, and that reloading starts over", () => {
    expect(PRACTICE_BANNER).toBe(
      "Practice mode: everything here is simulated in your browser. No real money, nothing is sent anywhere, nothing is saved. Reloading starts over.",
    );
  });
});

describe("turning it on", () => {
  // covers: REQ-DEMO-001
  it("writes the flag and nothing else, takes the operator link's place, and answers the app's calls", async () => {
    leaks = watchLeaks();
    expect(usePractice.getState()).toEqual({ on: false, exampleList: null, leaving: false });
    await startPractice();
    expect(usePractice.getState().on).toBe(true);
    expect(usePractice.getState().exampleList).toContain("address,amount,memo");
    expect(hasPracticeFlag()).toBe(true);
    expect(hasApiTransport()).toBe(true);
    // The operator pages open without the link the operator prints, and with no token in any address.
    expect(useSession.getState().status).toBe("ready");
    expect(getToken()).toBe(PRACTICE_TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(leaks.storage).toEqual([{ area: "session", op: "setItem", key: PRACTICE_KEY, value: "1" }]);
    expect(leaks.network).toEqual([]);
  });

  it("starts from a clean sheet: a list that was being added to the wizard before is not in the practice payout", async () => {
    const { useWizardDraft } = await import("@/features/wizard/draft");
    useWizardDraft.getState().setCsv("address,amount\nu1before,1\n", "mine.csv");
    useWizardDraft.getState().setName("Before");
    await startPractice();
    expect(useWizardDraft.getState().csvText).toBe("");
    expect(useWizardDraft.getState().csvFileName).toBeNull();
    expect(useWizardDraft.getState().name).toBe("");
  });

  it("is once, however often it is asked, and the second ask waits for the first", async () => {
    const loads = vi.fn(() => import("@/practice/simulation"));
    await Promise.all([startPractice(loads), startPractice(loads)]);
    await startPractice(loads);
    expect(loads).toHaveBeenCalledTimes(1);
  });

  it("does not turn on, and writes nothing, when the simulation cannot be loaded", async () => {
    await expect(startPractice(() => Promise.reject(new Error("no chunk")))).rejects.toThrow("no chunk");
    expect(usePractice.getState().on).toBe(false);
    expect(hasPracticeFlag()).toBe(false);
    expect(hasApiTransport()).toBe(false);
    expect(useSession.getState().status).toBe("no-token");
    // And it can be asked again, and then it works.
    await startPractice();
    expect(usePractice.getState().on).toBe(true);
  });

  it("works for as long as the page does when the browser will not keep a flag", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(hasPracticeFlag()).toBe(false);
    await startPractice();
    expect(usePractice.getState().on).toBe(true);
    expect(hasApiTransport()).toBe(true);
    stopPractice();
    expect(usePractice.getState().on).toBe(false);
    expect(hasApiTransport()).toBe(false);
  });
});

describe("turning it off", () => {
  // covers: REQ-DEMO-001
  it("removes the flag, the transport, the stand-in token and the simulation's state, and a second stop is harmless", async () => {
    await startPractice();
    stopPractice();
    expect(usePractice.getState()).toEqual({ on: false, exampleList: null, leaving: false });
    expect(sessionStorage.getItem(PRACTICE_KEY)).toBeNull();
    expect(hasApiTransport()).toBe(false);
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("no-token");
    expect(() => {
      stopPractice();
    }).not.toThrow();
  });

  it("leaves a real operator token alone: only the stand-in goes", async () => {
    await startPractice();
    const real = "ab".repeat(32);
    const { adoptTokenFromText } = await import("@/api/operator/session");
    adoptTokenFromText(real);
    stopPractice();
    expect(getToken()).toBe(real);
  });

  it("is begun by asking, which changes nothing else until the screens have gone", async () => {
    beginLeavingPractice();
    expect(usePractice.getState().leaving).toBe(false);
    await startPractice();
    beginLeavingPractice();
    expect(usePractice.getState()).toMatchObject({ on: true, leaving: true });
    expect(hasApiTransport()).toBe(true);
    stopPractice();
    expect(usePractice.getState().leaving).toBe(false);
  });
});

describe("carrying on after a reload", () => {
  // covers: REQ-DEMO-001
  it("starts a simulation again when the flag is there, and is not in practice mode when it is not", async () => {
    await resumePractice();
    expect(usePractice.getState().on).toBe(false);
    sessionStorage.setItem(PRACTICE_KEY, "1");
    await resumePractice();
    expect(usePractice.getState().on).toBe(true);
    expect(hasApiTransport()).toBe(true);
  });

  it("takes only the exact flag: another value is not practice mode", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      sessionStorage.setItem(PRACTICE_KEY, value);
      await resumePractice();
      expect(usePractice.getState().on, value).toBe(false);
    }
  });
});

describe("a real operator session", () => {
  const REAL = "ab".repeat(32);
  const OTHER = "cd".repeat(32);

  /** A simulation that only writes down what it is asked and with what token, in place of the real one. */
  function recording(seen: { path: string; authorization: string | null }[]): SimulationLoader {
    return () =>
      Promise.resolve({
        createPractice: () => ({
          transport: (path, init) => {
            seen.push({ path, authorization: new Headers(init.headers).get("authorization") });
            return Promise.resolve(new Response(path.endsWith("/events") ? "{}" : "[]", { status: path.endsWith("/events") ? 404 : 200 }));
          },
          exampleList: "address,amount,memo\n",
          dispose: () => undefined,
        }),
      });
  }

  // covers: REQ-DEMO-001
  it("is kept through practice mode and is the operator's again on leaving, and no call in between carried it", async () => {
    adoptTokenFromText(REAL);
    const seen: { path: string; authorization: string | null }[] = [];
    await startPractice(recording(seen));
    expect(getToken()).toBe(PRACTICE_TOKEN);

    // Every kind of call the screens make: with a token, without one, and the event stream, which asks for its token itself.
    await Promise.allSettled([listCampaigns(), getHealth(), getCampaign("practice-000001")]);
    await subscribeToEvents({
      campaignId: "practice-000001",
      getToken,
      signal: new AbortController().signal,
      onOpen: () => undefined,
      onEvent: () => undefined,
      onStatus: () => undefined,
      onUnauthorized: () => undefined,
    });
    // The operator's link is opened in this tab meanwhile: another real token. It is not what calls carry either.
    adoptTokenFromText(OTHER);
    await Promise.allSettled([listCampaigns()]);

    expect(seen.map((call) => call.path)).toEqual([
      "/campaigns",
      "/health",
      "/campaigns/practice-000001",
      "/campaigns/practice-000001/events",
      "/campaigns",
    ]);
    // The health call has no token to send. Every other call carried the stand-in, and none carried a real one.
    expect(seen.map((call) => call.authorization)).toEqual([
      `Bearer ${PRACTICE_TOKEN}`,
      null,
      `Bearer ${PRACTICE_TOKEN}`,
      `Bearer ${PRACTICE_TOKEN}`,
      `Bearer ${PRACTICE_TOKEN}`,
    ]);
    expect(JSON.stringify(seen)).not.toContain(REAL);
    expect(JSON.stringify(seen)).not.toContain(OTHER);

    // On leaving, the operator's own session is back: the token that was last given to the page, and it is what calls carry.
    stopPractice();
    expect(getToken()).toBe(OTHER);
    expect(useSession.getState().status).toBe("ready");
    const fetched = vi.fn(() => Promise.resolve(new Response("[]", { status: 200 })));
    vi.stubGlobal("fetch", fetched);
    await listCampaigns();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetched.mock.calls)).toContain(`Bearer ${OTHER}`);
    expect(JSON.stringify(fetched.mock.calls)).not.toContain(PRACTICE_TOKEN);
  });

  // covers: REQ-DEMO-001
  it("is the same token, and the same status, after practice mode as before it, when nothing else happened", async () => {
    adoptTokenFromText(REAL);
    await startPractice();
    expect(useSession.getState().status).toBe("ready");
    stopPractice();
    expect(getToken()).toBe(REAL);
    expect(useSession.getState().status).toBe("ready");

    // And with no operator session at all, it is none afterwards: practice mode does not leave one behind.
    clearSession();
    await startPractice();
    stopPractice();
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("no-token");
  });
});
