// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adoptTokenFromLocation,
  adoptTokenFromText,
  clearSession,
  enterPracticeSession,
  getToken,
  leavePracticeSession,
  PRACTICE_TOKEN,
  rejectToken,
  useSession,
} from "./session";

const TOKEN = "ab".repeat(32);

beforeEach(() => {
  clearSession();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function adopt(hash: string, pathname = "/campaigns", search = "?x=1") {
  const replaceState = vi.fn();
  adoptTokenFromLocation({ hash, pathname, search }, { replaceState, state: { k: 1 } });
  return replaceState;
}

describe("adoptTokenFromLocation", () => {
  it("takes a well-formed token and marks the session ready", () => {
    adopt(`#token=${TOKEN}`);
    expect(getToken()).toBe(TOKEN);
    expect(useSession.getState().status).toBe("ready");
  });

  it("removes the fragment from the address bar, keeping path and query", () => {
    const replaceState = adopt(`#token=${TOKEN}`);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/campaigns?x=1");
    expect(String(replaceState.mock.calls[0]?.[2])).not.toContain("token");
  });

  it.each([
    ["too short", `#token=${TOKEN.slice(1)}`],
    ["too long", `#token=${TOKEN}0`],
    ["uppercase", `#token=${TOKEN.toUpperCase()}`],
    ["not hex", `#token=${"zz".repeat(32)}`],
    ["empty", "#token="],
    ["extra fragment content", `#token=${TOKEN}&x=1`],
  ])("a %s token is refused, but still removed from the address bar", (_label, hash) => {
    const replaceState = adopt(hash);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("rejected");
  });

  it("ignores a URL with no token fragment (and does not touch history)", () => {
    for (const hash of ["", "#", "#section", "#tokens=abc", `#other=${TOKEN}`]) {
      const replaceState = adopt(hash);
      expect(replaceState).not.toHaveBeenCalled();
    }
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("no-token");
  });

  it("a new token replaces the old one (the operator was restarted)", () => {
    adopt(`#token=${TOKEN}`);
    adopt(`#token=${"cd".repeat(32)}`);
    expect(getToken()).toBe("cd".repeat(32));
  });

  it("really does rewrite the address bar in a browser", () => {
    window.history.replaceState(null, "", `/campaigns#token=${TOKEN}`);
    expect(window.location.hash).toContain("token=");
    adoptTokenFromLocation(window.location, window.history);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname).toBe("/campaigns");
  });
});

describe("the token is never persisted", () => {
  it("writes to no storage, cookie or session state", () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    adopt(`#token=${TOKEN}`);
    rejectToken();
    adopt(`#token=${TOKEN}`);

    expect(local).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
  });

  it("is not part of the observable state either", () => {
    adopt(`#token=${TOKEN}`);
    expect(JSON.stringify(useSession.getState())).not.toContain(TOKEN);
    expect(Object.keys(useSession.getState())).toEqual(["status"]);
  });
});

describe("rejectToken and clearSession", () => {
  it("rejecting forgets the token and says so", () => {
    adopt(`#token=${TOKEN}`);
    rejectToken();
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("rejected");
  });

  it("clearing returns to the start", () => {
    adopt(`#token=${TOKEN}`);
    clearSession();
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("no-token");
  });
});

describe("adoptTokenFromText (a pasted link or token)", () => {
  it("takes the token from the whole link the operator prints", () => {
    expect(adoptTokenFromText(`http://127.0.0.1:8787/#token=${TOKEN}`)).toBe(true);
    expect(getToken()).toBe(TOKEN);
    expect(useSession.getState().status).toBe("ready");
  });

  it("takes a bare token, with surrounding whitespace", () => {
    expect(adoptTokenFromText(`  ${TOKEN}\n`)).toBe(true);
    expect(getToken()).toBe(TOKEN);
  });

  it("finds the link inside a pasted block of terminal text", () => {
    const banner = `ZecDrop operator\n  network: testnet\n  open:    http://127.0.0.1:63974/#token=${TOKEN}\n  The token is new on every start.`;
    expect(adoptTokenFromText(banner)).toBe(true);
    expect(getToken()).toBe(TOKEN);
  });

  it.each([
    ["nothing", ""],
    ["words", "not a token"],
    ["a token that is too short", `#token=${TOKEN.slice(2)}`],
    ["uppercase", TOKEN.toUpperCase()],
    ["a 64-hex string that is part of something longer", `${TOKEN}ab`],
    ["a bare 64-hex string inside other text (could be a txid)", `txid ${TOKEN} confirmed`],
  ])("finds nothing in %s and leaves the session alone", (_label, text) => {
    expect(adoptTokenFromText(text)).toBe(false);
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("no-token");
  });

  it("persists nothing", () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    adoptTokenFromText(TOKEN);
    expect(set).not.toHaveBeenCalled();
  });
});

// covers: REQ-DEMO-001
describe("practice mode's stand-in for the operator link", () => {
  const OTHER = "cd".repeat(32);

  afterEach(() => {
    leavePracticeSession();
  });

  it("opens the operator pages with no link, and is the token every call carries while it lasts", () => {
    expect(useSession.getState().status).toBe("no-token");
    enterPracticeSession();
    expect(useSession.getState().status).toBe("ready");
    expect(getToken()).toBe(PRACTICE_TOKEN);
    leavePracticeSession();
    expect(useSession.getState().status).toBe("no-token");
    expect(getToken()).toBeNull();
  });

  it("keeps a real operator's session through it: the real token is back on leaving, and was not the token in between", () => {
    adopt(`#token=${TOKEN}`);
    enterPracticeSession();
    expect(getToken()).toBe(PRACTICE_TOKEN);
    expect(getToken()).not.toBe(TOKEN);
    leavePracticeSession();
    expect(getToken()).toBe(TOKEN);
    expect(useSession.getState().status).toBe("ready");
  });

  it("keeps a refusal through it too: a session the operator refused is a refused session again afterwards", () => {
    adopt(`#token=${TOKEN}`);
    rejectToken();
    enterPracticeSession();
    expect(useSession.getState().status).toBe("ready");
    leavePracticeSession();
    expect(getToken()).toBeNull();
    expect(useSession.getState().status).toBe("rejected");
  });

  it("is still the token when the operator's link is opened while it lasts, and the new token is what is back on leaving", () => {
    adopt(`#token=${TOKEN}`);
    enterPracticeSession();
    // A link opened in this tab changes only the fragment: it is adopted (and stripped), but it is not what calls carry.
    const replaceState = adopt(`#token=${OTHER}`);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe(PRACTICE_TOKEN);
    expect(useSession.getState().status).toBe("ready");
    leavePracticeSession();
    expect(getToken()).toBe(OTHER);
    expect(useSession.getState().status).toBe("ready");
  });

  it("is not undone by a link that does not read, or a token pasted, while it lasts", () => {
    enterPracticeSession();
    adopt(`#token=${TOKEN.slice(1)}`);
    expect(getToken()).toBe(PRACTICE_TOKEN);
    expect(useSession.getState().status).toBe("ready");
    adoptTokenFromText(OTHER);
    expect(getToken()).toBe(PRACTICE_TOKEN);
    expect(useSession.getState().status).toBe("ready");
    leavePracticeSession();
    expect(getToken()).toBe(OTHER);
    expect(useSession.getState().status).toBe("ready");
  });

  it("is not a refusal of the real token when it is refused: a 401 in practice mode is the simulation's", () => {
    adopt(`#token=${TOKEN}`);
    enterPracticeSession();
    rejectToken();
    expect(getToken()).toBe(PRACTICE_TOKEN);
    expect(useSession.getState().status).toBe("ready");
    leavePracticeSession();
    expect(getToken()).toBe(TOKEN);
    expect(useSession.getState().status).toBe("ready");
  });

  it("is entered and left once however often it is asked", () => {
    adopt(`#token=${TOKEN}`);
    enterPracticeSession();
    enterPracticeSession();
    leavePracticeSession();
    expect(getToken()).toBe(TOKEN);
    leavePracticeSession();
    expect(getToken()).toBe(TOKEN);
    expect(useSession.getState().status).toBe("ready");
  });

  it("is never what the observable state holds, and persists nothing", () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    adopt(`#token=${TOKEN}`);
    enterPracticeSession();
    expect(Object.keys(useSession.getState())).toEqual(["status"]);
    expect(JSON.stringify(useSession.getState())).not.toContain(TOKEN);
    leavePracticeSession();
    expect(set).not.toHaveBeenCalled();
  });
});
