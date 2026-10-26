import { describe, expect, it } from "vitest";

import { parseCampaignList } from "@/api/operator/schemas";
import { fixtureJson } from "@/test/operator-fixtures";

import { sortCampaigns } from "./sort";

describe("sortCampaigns", () => {
  const list = parseCampaignList(fixtureJson("campaigns-list.json"));

  it("puts the newest first", () => {
    const sorted = sortCampaigns(list);
    const times = sorted.map((c) => c.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("is stable whatever order the operator answered in", () => {
    const reversed = [...list].reverse();
    expect(sortCampaigns(reversed).map((c) => c.id)).toEqual(sortCampaigns(list).map((c) => c.id));
  });

  it("does not change the list it was given", () => {
    const before = list.map((c) => c.id);
    sortCampaigns(list);
    expect(list.map((c) => c.id)).toEqual(before);
  });
});
