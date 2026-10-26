// A small message that says a thing happened ("Receipt link copied"), for a moment.
// Visual only: whatever caused it already says it to assistive technology (the copy
// button has its own status line), so the toast is hidden from it rather than said twice.

import { create } from "zustand";

interface ToastState {
  /** Changes with every message, so the same words twice in a row still show again. */
  id: number;
  text: string | null;
  show: (text: string) => void;
  clear: (id: number) => void;
}

export const TOAST_MS = 1_800;

export const useToast = create<ToastState>()((set, get) => ({
  id: 0,
  text: null,
  show: (text) => {
    const id = get().id + 1;
    set({ id, text });
    setTimeout(() => {
      get().clear(id);
    }, TOAST_MS);
  },
  clear: (id) => {
    if (get().id === id) set({ text: null });
  },
}));

export function toast(text: string): void {
  useToast.getState().show(text);
}
