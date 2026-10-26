// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCampaign } from "@/api/operator/schemas";
import { CSV, fixtureJson } from "@/test/operator-fixtures";

import { useWizardDraft } from "./draft";

const SENTINEL_CSV = CSV["valid.csv"] ?? "";
const SENTINELS = ["u1sentineladdressaaaaaaaaaaaaaaaaaaaa", "memo-sentinel-one", "4.125", "zs1sentineladdressdddddddddddddddddddd"];

beforeEach(() => {
  useWizardDraft.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the draft store", () => {
  it("starts with the documented defaults: standard fee, 50 per batch, nothing entered", () => {
    expect(useWizardDraft.getState()).toMatchObject({
      name: "",
      feePolicy: "zip317_text",
      maxOutputsPerBatch: 50,
      csvText: "",
      csvFileName: null,
      created: null,
    });
  });

  it("holds what is typed", () => {
    const s = useWizardDraft.getState();
    s.setName("Spring drop");
    s.setFeePolicy("zebra_main");
    s.setMaxOutputsPerBatch(20);
    s.setCsv(SENTINEL_CSV, "recipients.csv");
    expect(useWizardDraft.getState()).toMatchObject({
      name: "Spring drop",
      feePolicy: "zebra_main",
      maxOutputsPerBatch: 20,
      csvText: SENTINEL_CSV,
      csvFileName: "recipients.csv",
    });
  });

  // covers: REQ-PRIV-002
  it("forgets the recipients the moment the campaign is created", () => {
    useWizardDraft.getState().setCsv(SENTINEL_CSV, "recipients.csv");
    const campaign = parseCampaign(fixtureJson("create-valid.json"));
    useWizardDraft.getState().campaignCreated(campaign);

    const state = useWizardDraft.getState();
    expect(state.csvText).toBe("");
    expect(state.csvFileName).toBeNull();
    expect(state.created).toEqual(campaign);
    const dump = JSON.stringify(state, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    for (const sentinel of SENTINELS) expect(dump).not.toContain(sentinel);
  });

  // covers: REQ-IMP-002
  it("forgets the list built in the page the moment the campaign is created, and starts it again empty", () => {
    const s = useWizardDraft.getState();
    s.updatePerson(useWizardDraft.getState().people[0]?.key ?? "", { address: SENTINELS[0], amount: "4.125", memo: SENTINELS[1] });
    s.addPerson();
    s.setAmountMode("lucky");
    expect(useWizardDraft.getState().splitTotal).toBe("4.125");
    s.campaignCreated(parseCampaign(fixtureJson("create-valid.json")));

    const state = useWizardDraft.getState();
    expect(state.people).toHaveLength(1);
    expect(state.people[0]).toMatchObject({ address: "", amount: "", memo: "" });
    expect(state.amountMode).toBe("each");
    expect(state.splitTotal).toBe("");
    const dump = JSON.stringify(state, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    for (const sentinel of SENTINELS) expect(dump).not.toContain(sentinel);
  });

  it("keeps at least one person, and splits again whenever the people or the total change", () => {
    const s = useWizardDraft.getState();
    s.setAmountMode("even");
    s.setSplitTotal("0.03");
    expect(useWizardDraft.getState().people.map((p) => p.amount)).toEqual(["0.03"]);
    s.addPerson();
    s.addPerson();
    expect(useWizardDraft.getState().people.map((p) => p.amount)).toEqual(["0.01", "0.01", "0.01"]);
    s.removePerson(useWizardDraft.getState().people[0]?.key ?? "");
    expect(useWizardDraft.getState().people.map((p) => p.amount)).toEqual(["0.015", "0.015"]);
    for (const person of useWizardDraft.getState().people) s.removePerson(person.key);
    expect(useWizardDraft.getState().people).toHaveLength(1);
  });

  it("reset clears everything, including the created campaign", () => {
    const s = useWizardDraft.getState();
    s.setName("x");
    s.setCsv(SENTINEL_CSV);
    s.campaignCreated(parseCampaign(fixtureJson("create-valid.json")));
    useWizardDraft.getState().reset();
    expect(useWizardDraft.getState()).toMatchObject({ name: "", csvText: "", created: null, maxOutputsPerBatch: 50 });
  });
});

// covers: REQ-PRIV-002
describe("nothing is ever persisted", () => {
  it("a whole lifecycle with a sentinel CSV touches no browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    // jsdom has no IndexedDB; give it one that records any use.
    const open = vi.fn();
    vi.stubGlobal("indexedDB", { open });
    const cookie = vi.spyOn(document, "cookie", "set");

    const s = useWizardDraft.getState();
    s.setName("Sentinel campaign");
    s.updatePerson(useWizardDraft.getState().people[0]?.key ?? "", { address: SENTINELS[0], amount: "1", memo: SENTINELS[1] });
    s.addPerson();
    s.setAmountMode("lucky");
    s.setSplitTotal("4.125");
    s.shuffle();
    s.setCsv(SENTINEL_CSV, "recipients.csv");
    s.setFeePolicy("zebra_main");
    s.setMaxOutputsPerBatch(3);
    s.campaignCreated(parseCampaign(fixtureJson("create-valid.json")));
    s.reset();
    await Promise.resolve();

    expect(setItem).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    for (const store of [localStorage, sessionStorage]) {
      expect(store.length).toBe(0);
      for (const sentinel of SENTINELS) expect(JSON.stringify({ ...store })).not.toContain(sentinel);
    }
    expect(document.cookie).toBe("");
  });

  it("the store module does not use any persistence API", async () => {
    const source = (await import("./draft.ts?raw")).default;
    for (const forbidden of ["persist", "localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
      // The words may appear in the explanatory comment; the code must not call them.
      const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});
