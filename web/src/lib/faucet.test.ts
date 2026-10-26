import { describe, expect, it } from "vitest";

import { TESTNET_FAUCET_URL, testCoinsRequestUrl } from "./faucet";
import { PROJECT_REPO_URL } from "./project";

describe("asking for test coins", () => {
  // covers: REQ-RUN-003
  it("opens a new issue on ZecDrop's repository that already holds the funding address and the amount, and nothing else", () => {
    const url = new URL(testCoinsRequestUrl("tmVE1vd2bmTJQKpD8XmiXiRpvrFsoyKiB6n", "0.00545"));
    expect(`${url.origin}${url.pathname}`).toBe(`${PROJECT_REPO_URL}/issues/new`);
    expect([...url.searchParams.keys()]).toEqual(["title", "body"]);
    expect(url.searchParams.get("title")).toBe("Test coins for my payout");
    expect(url.searchParams.get("body")).toBe(
      [
        "The testnet faucet could not pay my payout's funding address. Please send it test coins.",
        "",
        "Funding address (testnet): tmVE1vd2bmTJQKpD8XmiXiRpvrFsoyKiB6n",
        "Amount it asks for: 0.00545 TAZ",
      ].join("\n"),
    );
  });

  it("goes to GitHub and to the faucet over https", () => {
    expect(PROJECT_REPO_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/zecdrop$/u);
    expect(TESTNET_FAUCET_URL).toMatch(/^https:\/\//u);
  });
});
