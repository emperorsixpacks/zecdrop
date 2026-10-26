// The new-campaign wizard's in-progress state.
//
// PRIVACY RULE: this store is MEMORY ONLY. There is no `persist`, no
// localStorage, no sessionStorage, no IndexedDB, no cookie. The recipient CSV
// goes to the local operator once, when the campaign is created, and is
// cleared from here at that moment. What stays afterwards is the operator's own
// view of the campaign, which carries counts, batch totals and the commitment
// but no address, amount or memo.
//
// draft.test.ts plants a sentinel CSV, drives the whole lifecycle, and fails if
// any browser storage is touched or the text survives creation.

import { create } from "zustand";

import type { OperatorCampaign } from "@/api/operator/schemas";
import { DEFAULT_BATCH_SIZE, DEFAULT_FEE_POLICY, type FeePolicyName } from "@/lib/fees";

interface DraftState {
  name: string;
  feePolicy: FeePolicyName;
  maxOutputsPerBatch: number;
  /** The recipients as CSV text. Cleared the moment the campaign is created. */
  csvText: string;
  /** Shown in the UI instead of the content, e.g. "payroll.csv". */
  csvFileName: string | null;
  /** The campaign the operator created: public figures only. */
  created: OperatorCampaign | null;

  setName: (name: string) => void;
  setFeePolicy: (policy: FeePolicyName) => void;
  setMaxOutputsPerBatch: (size: number) => void;
  setCsv: (text: string, fileName?: string | null) => void;
  /** The operator accepted the campaign: remember it, forget the recipients. */
  campaignCreated: (campaign: OperatorCampaign) => void;
  /** Start over. The created campaign stays in the operator; only this draft goes. */
  reset: () => void;
}

const initial = {
  name: "",
  feePolicy: DEFAULT_FEE_POLICY,
  maxOutputsPerBatch: DEFAULT_BATCH_SIZE,
  csvText: "",
  csvFileName: null,
  created: null,
} satisfies Pick<DraftState, "name" | "feePolicy" | "maxOutputsPerBatch" | "csvText" | "csvFileName" | "created">;

export const useWizardDraft = create<DraftState>()((set) => ({
  ...initial,
  setName: (name) => {
    set({ name });
  },
  setFeePolicy: (feePolicy) => {
    set({ feePolicy });
  },
  setMaxOutputsPerBatch: (maxOutputsPerBatch) => {
    set({ maxOutputsPerBatch });
  },
  setCsv: (csvText, csvFileName = null) => {
    set({ csvText, csvFileName });
  },
  campaignCreated: (created) => {
    set({ created, csvText: "", csvFileName: null });
  },
  reset: () => {
    set({ ...initial });
  },
}));
