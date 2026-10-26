import { describe, expect, it } from "vitest";

import { explorerAddressUrl, explorerTxUrl, isLinkableAddress } from "./explorer";

const TXID = "ab".repeat(32);
const templates = {
  testnet: "https://test.example/tx/{txid}",
  mainnet: "https://main.example/tx/{txid}?ref=zecdrop",
} as const;

describe("explorerTxUrl", () => {
  it("fills the template for each network", () => {
    expect(explorerTxUrl("testnet", TXID, templates)).toBe(`https://test.example/tx/${TXID}`);
    expect(explorerTxUrl("mainnet", TXID, templates)).toBe(
      `https://main.example/tx/${TXID}?ref=zecdrop`,
    );
  });

  it("uses the configured defaults when no templates are passed", () => {
    expect(explorerTxUrl("testnet", TXID)).toMatch(/^https:\/\/.+/u);
    expect(explorerTxUrl("testnet", TXID)).toContain(TXID);
  });

  it.each([
    "",
    "short",
    "AB".repeat(32), // ids are lowercase on the wire
    `${TXID}0`,
    TXID.slice(1),
    `${TXID.slice(0, 63)}g`,
    `../${TXID.slice(3)}`,
    `${TXID.slice(0, 60)}?x=1`,
    `${TXID.slice(0, 62)}/#`,
  ])("refuses %j, so nothing else can reach the URL", (txid) => {
    expect(() => explorerTxUrl("testnet", txid, templates)).toThrow(/transaction id/);
  });
});

describe("explorerAddressUrl", () => {
  const addresses = {
    testnet: "https://test.example/address/{address}",
    mainnet: "https://main.example/a/{address}?ref=zecdrop",
  } as const;
  const TESTNET_ADDRESS = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD"; // the funding input of the real testnet batch
  const MAINNET_ADDRESS = "t1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy"; // taken from the explorer's own transaction page

  it("fills the template for each network", () => {
    expect(explorerAddressUrl("testnet", TESTNET_ADDRESS, addresses)).toBe(`https://test.example/address/${TESTNET_ADDRESS}`);
    expect(explorerAddressUrl("mainnet", MAINNET_ADDRESS, addresses)).toBe(`https://main.example/a/${MAINNET_ADDRESS}?ref=zecdrop`);
  });

  it("uses the stock explorers' address pages by default, the pattern that was checked", () => {
    expect(explorerAddressUrl("testnet", TESTNET_ADDRESS)).toBe(`https://testnet.zecblock.com/address/${TESTNET_ADDRESS}`);
    expect(explorerAddressUrl("mainnet", MAINNET_ADDRESS)).toBe(`https://mainnet.zcashexplorer.app/address/${MAINNET_ADDRESS}`);
  });

  it.each([
    ["a placeholder with characters base58 does not have", "tFAKEfundingAddressNotARealAddress0000"],
    ["an empty string", ""],
    ["a path", "../x"],
    ["a query", `${TESTNET_ADDRESS}?x=1`],
    ["a fragment", `${TESTNET_ADDRESS}#x`],
    ["a slash", `${TESTNET_ADDRESS}/x`],
    ["whitespace", `${TESTNET_ADDRESS} `],
    ["too short", "t1abc"],
    ["a unified address's bech32 text with a separator", "u1abc.def"],
  ])("gives no link for %s, so nothing else can reach the URL", (_label, address) => {
    expect(isLinkableAddress(address)).toBe(false);
    expect(explorerAddressUrl("testnet", address, addresses)).toBeNull();
  });
});
