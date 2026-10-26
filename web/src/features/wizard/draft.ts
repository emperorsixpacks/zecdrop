// The new-campaign wizard's in-progress state.
//
// PRIVACY RULE: this store is MEMORY ONLY. There is no `persist`, no
// localStorage, no sessionStorage, no IndexedDB, no cookie. The recipient CSV
// goes to the local operator once, when the campaign is created, and is
// cleared from here at that moment. What stays afterwards is the operator's own
// view of the campaign, which carries counts, batch totals and the commitment
// but no address, amount or memo.
//
// The list a person builds in the page instead of a file (`people`, REQ-IMP-002) is recipient data in the same way:
// memory only, and gone with the CSV when the campaign is created.
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
import { browserRandom } from "@/lib/random";
import { formatZec } from "@/lib/zec";

import { applySplit, blankPerson, listTotal, type AmountMode, type Person } from "./people";

interface DraftState {
  name: string;
  feePolicy: FeePolicyName;
  maxOutputsPerBatch: number;
  /** The recipients as CSV text. Cleared the moment the campaign is created. */
  csvText: string;
  /** Shown in the UI instead of the content, e.g. "payroll.csv". */
  csvFileName: string | null;
  /** The list built in the page, one person at a time; used when there is no CSV. Cleared with the CSV. */
  people: Person[];
  /** How its amounts are set. */
  amountMode: AmountMode;
  /** The total a split shares out, as typed. */
  splitTotal: string;
  /** The campaign the operator created: public figures only. */
  created: OperatorCampaign | null;
  /** The rows of the list, for the Check stage's lens only; null once released. */
  list: LensRow[] | null;

  setName: (name: string) => void;
  setFeePolicy: (policy: FeePolicyName) => void;
  setMaxOutputsPerBatch: (size: number) => void;
  setCsv: (text: string, fileName?: string | null) => void;
  /** Replace the whole list (the example people), with amounts as given. */
  setPeople: (people: Person[]) => void;
  updatePerson: (key: string, change: Partial<Omit<Person, "key">>) => void;
  /** Add an empty person at the end; returns their key. */
  addPerson: () => string;
  removePerson: (key: string) => void;
  setAmountMode: (mode: AmountMode) => void;
  setSplitTotal: (text: string) => void;
  /** Draw the lucky split again. */
  shuffle: () => void;
  /** The operator accepted the campaign: remember it, forget the CSV. The rows, if given, stay for the Check stage. */
  campaignCreated: (campaign: OperatorCampaign, list?: LensRow[] | null) => void;
  /** The Check stage is over: drop the rows. */
  releaseList: () => void;
  /** Start over. The created campaign stays in the operator; only this draft goes. */
  reset: () => void;
}

type Fields = Pick<
  DraftState,
  "name" | "feePolicy" | "maxOutputsPerBatch" | "csvText" | "csvFileName" | "people" | "amountMode" | "splitTotal" | "created" | "list"
>;

/** The list part of the draft as it starts: one person, nobody filled in, amounts typed one by one. */
const freshList = (): Pick<Fields, "people" | "amountMode" | "splitTotal"> => ({ people: [blankPerson()], amountMode: "each", splitTotal: "" });

const initial = (): Fields => ({
  name: "",
  feePolicy: DEFAULT_FEE_POLICY,
  maxOutputsPerBatch: DEFAULT_BATCH_SIZE,
  csvText: "",
  csvFileName: null,
  ...freshList(),
  created: null,
  list: null,
});

export const useWizardDraft = create<DraftState>()((set, get) => ({
  ...initial(),
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
  setPeople: (people) => {
    set({ people: people.length > 0 ? people : [blankPerson()], amountMode: "each", splitTotal: "" });
  },
  updatePerson: (key, change) => {
    set({ people: get().people.map((person) => (person.key === key ? { ...person, ...change } : person)) });
  },
  addPerson: () => {
    const added = blankPerson();
    const { amountMode, splitTotal } = get();
    set({ people: applySplit([...get().people, added], amountMode, splitTotal, browserRandom) });
    return added.key;
  },
  removePerson: (key) => {
    const left = get().people.filter((person) => person.key !== key);
    const { amountMode, splitTotal } = get();
    set({ people: left.length > 0 ? applySplit(left, amountMode, splitTotal, browserRandom) : [blankPerson()] });
  },
  setAmountMode: (amountMode) => {
    const { people, amountMode: was } = get();
    // From typed amounts to a split: the total to share starts as what they add up to.
    const typed = listTotal(people).total;
    const splitTotal = was === "each" && amountMode !== "each" && get().splitTotal.trim() === "" && typed > 0n ? formatZec(typed) : get().splitTotal;
    set({ amountMode, splitTotal, people: applySplit(people, amountMode, splitTotal, browserRandom) });
  },
  setSplitTotal: (splitTotal) => {
    const { people, amountMode } = get();
    set({ splitTotal, people: applySplit(people, amountMode, splitTotal, browserRandom) });
  },
  shuffle: () => {
    const { people, amountMode, splitTotal } = get();
    set({ people: applySplit(people, amountMode, splitTotal, browserRandom) });
  },
  campaignCreated: (created, list = null) => {
    set({ created, csvText: "", csvFileName: null, ...freshList(), list });
  },
  releaseList: () => {
    set({ list: null });
  },
  reset: () => {
    set(initial());
  },
}));
