// The new-campaign wizard's in-progress state.
//
// PRIVACY RULE: this store is MEMORY ONLY. There is no `persist`, no
// localStorage, no sessionStorage, no IndexedDB, no cookie. The recipient CSV
// goes to the local operator once, when the campaign is created, and is
// cleared from here at that moment. What stays afterwards is the operator's own
// view of the campaign, which carries counts, batch totals and the commitment
// but no address, amount or memo.
//
// One thing outlives the CSV for a short while: the parsed rows, held in `list`
// so the Check stage can show the real list through the redaction lens. They are
// released when the person leaves the Check stage (continues, or starts over), when
// the Send stage or the campaign page opens, and by `reset`. They are never read
// by anything but that lens, and never written anywhere.
//
// draft.test.ts plants a sentinel CSV, drives the whole lifecycle, and fails if
// any browser storage is touched or the text survives creation.

import { create } from "zustand";

import type { OperatorCampaign } from "@/api/operator/schemas";
import type { LensRow } from "@/components/lens/Lens";
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
  /** The rows of the list, for the Check stage's lens only; null once released. */
  list: LensRow[] | null;

  setName: (name: string) => void;
  setFeePolicy: (policy: FeePolicyName) => void;
  setMaxOutputsPerBatch: (size: number) => void;
  setCsv: (text: string, fileName?: string | null) => void;
  /** The operator accepted the campaign: remember it, forget the CSV. The rows, if given, stay for the Check stage. */
  campaignCreated: (campaign: OperatorCampaign, list?: LensRow[] | null) => void;
  /** The Check stage is over: drop the rows. */
  releaseList: () => void;
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
  list: null,
} satisfies Pick<DraftState, "name" | "feePolicy" | "maxOutputsPerBatch" | "csvText" | "csvFileName" | "created" | "list">;

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
  campaignCreated: (created, list = null) => {
    set({ created, csvText: "", csvFileName: null, list });
  },
  releaseList: () => {
    set({ list: null });
  },
  reset: () => {
    set({ ...initial });
  },
}));
