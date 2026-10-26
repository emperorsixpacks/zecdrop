// Who a payout is for, which decides how much the payout screens show (owner, 2026-10-20: "making the UI easier to
// navigate and less crowded").
//
//   personal       family, friends, a few people: typed in one by one, and nothing that only a payroll or an auditor needs
//   organisation   a team or a community: a spreadsheet first, the fee and batch options, the batches, the auditor's key
//
// It changes what is on the screen, never what is sent, built or proved: both make the same campaign, and anything
// hidden is one switch away.
//
// The choice is a convenience like the theme, so it is kept in localStorage ("zd:audience"), every access wrapped:
// storage can be blocked (private windows, disabled site data) and must never break the page. It is written only when the
// person changes it, so a visit that never does leaves nothing behind.

import { create } from "zustand";

export type Audience = "personal" | "organisation";

export const AUDIENCE_STORAGE_KEY = "zd:audience";

/** What a visitor who has never chosen sees. */
export const DEFAULT_AUDIENCE: Audience = "personal";

function isAudience(value: unknown): value is Audience {
  return value === "personal" || value === "organisation";
}

export function readStoredAudience(): Audience | null {
  try {
    const raw = globalThis.localStorage.getItem(AUDIENCE_STORAGE_KEY);
    return isAudience(raw) ? raw : null;
  } catch {
    return null;
  }
}

function storeAudience(audience: Audience): void {
  try {
    globalThis.localStorage.setItem(AUDIENCE_STORAGE_KEY, audience);
  } catch {
    /* storage unavailable: the choice just won't survive a reload */
  }
}

interface AudienceState {
  audience: Audience;
  /** Choose, and remember the choice on this browser. */
  setAudience: (audience: Audience) => void;
}

export const useAudience = create<AudienceState>()((set) => ({
  audience: readStoredAudience() ?? DEFAULT_AUDIENCE,
  setAudience: (audience) => {
    storeAudience(audience);
    set({ audience });
  },
}));
