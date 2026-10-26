import { describe, expect, it } from "vitest";

import { config, loadConfig } from "./config";

describe("loadConfig", () => {
  it("defaults to /api, testnet and the stock explorers when nothing is set", () => {
    const defaults = {
      apiBaseUrl: "/api",
      network: "testnet",
      explorerTxUrl: {
        testnet: "https://testnet.zecblock.com/tx/{txid}",
        mainnet: "https://mainnet.zcashexplorer.app/transactions/{txid}",
      },
      explorerAddressUrl: {
        testnet: "https://testnet.zecblock.com/address/{address}",
        mainnet: "https://mainnet.zcashexplorer.app/address/{address}",
      },
      publicReceiptBaseUrl: null,
      publicOnly: false,
    };
    expect(loadConfig({})).toEqual(defaults);
    expect(
      loadConfig({
        VITE_API_URL: "",
        VITE_ZEC_NETWORK: "",
        VITE_EXPLORER_TESTNET_TX_URL: "",
        VITE_EXPLORER_MAINNET_TX_URL: "",
        VITE_EXPLORER_TESTNET_ADDRESS_URL: "",
        VITE_EXPLORER_MAINNET_ADDRESS_URL: "",
      }),
    ).toEqual(defaults);
  });

  it("accepts an absolute path or an http(s) URL and strips trailing slashes", () => {
    expect(loadConfig({ VITE_API_URL: "/v1/" }).apiBaseUrl).toBe("/v1");
    expect(loadConfig({ VITE_API_URL: "https://verify.example.org/api//" }).apiBaseUrl).toBe(
      "https://verify.example.org/api",
    );
    expect(loadConfig({ VITE_API_URL: "http://127.0.0.1:8787" }).apiBaseUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("rejects relative, protocol-relative and non-http API URLs", () => {
    for (const bad of ["api", "//evil.example/api", "ftp://x/api", "javascript:alert(1)"]) {
      expect(() => loadConfig({ VITE_API_URL: bad })).toThrow(/VITE_API_URL/);
    }
  });

  it("accepts exactly testnet and mainnet", () => {
    expect(loadConfig({ VITE_ZEC_NETWORK: "testnet" }).network).toBe("testnet");
    expect(loadConfig({ VITE_ZEC_NETWORK: "mainnet" }).network).toBe("mainnet");
  });

  it("fails loudly on any other network value instead of guessing", () => {
    for (const bad of ["Mainnet", "main", "regtest", " mainnet"]) {
      expect(() => loadConfig({ VITE_ZEC_NETWORK: bad })).toThrow(/VITE_ZEC_NETWORK/);
    }
  });
});

describe("explorer templates", () => {
  const TESTNET = "VITE_EXPLORER_TESTNET_TX_URL";
  const MAINNET = "VITE_EXPLORER_MAINNET_TX_URL";

  it("can be overridden per network", () => {
    const cfg = loadConfig({
      [TESTNET]: "https://explorer.example/test/tx/{txid}",
      [MAINNET]: "https://explorer.example/main/tx/{txid}?x=1",
    });
    expect(cfg.explorerTxUrl.testnet).toBe("https://explorer.example/test/tx/{txid}");
    expect(cfg.explorerTxUrl.mainnet).toBe("https://explorer.example/main/tx/{txid}?x=1");
  });

  it.each([
    ["plain http", "http://explorer.example/tx/{txid}"],
    ["no placeholder", "https://explorer.example/tx/"],
    ["two placeholders", "https://explorer.example/{txid}/{txid}"],
    ["a protocol-relative URL", "//explorer.example/tx/{txid}"],
    ["a javascript: URL", "javascript:alert('{txid}')"],
    ["whitespace", "https://explorer.example/tx/ {txid}"],
    ["a relative path", "/tx/{txid}"],
    ["no host", "https:///{txid}"],
  ])("rejects %s", (_label, value) => {
    expect(() => loadConfig({ [TESTNET]: value })).toThrow(/VITE_EXPLORER_TESTNET_TX_URL/);
    expect(() => loadConfig({ [MAINNET]: value })).toThrow(/VITE_EXPLORER_MAINNET_TX_URL/);
  });

  it("rejects a non-string value", () => {
    expect(() => loadConfig({ [TESTNET]: 5 })).toThrow(/must be a string/);
  });
});

describe("explorer address templates", () => {
  const TESTNET = "VITE_EXPLORER_TESTNET_ADDRESS_URL";
  const MAINNET = "VITE_EXPLORER_MAINNET_ADDRESS_URL";

  it("can be overridden per network", () => {
    const cfg = loadConfig({
      [TESTNET]: "https://explorer.example/test/a/{address}",
      [MAINNET]: "https://explorer.example/main/a/{address}?x=1",
    });
    expect(cfg.explorerAddressUrl.testnet).toBe("https://explorer.example/test/a/{address}");
    expect(cfg.explorerAddressUrl.mainnet).toBe("https://explorer.example/main/a/{address}?x=1");
  });

  it.each([
    ["plain http", "http://explorer.example/a/{address}"],
    ["no placeholder", "https://explorer.example/a/"],
    ["two placeholders", "https://explorer.example/{address}/{address}"],
    ["the transaction placeholder instead", "https://explorer.example/a/{txid}"],
    ["a javascript: URL", "javascript:alert('{address}')"],
    ["whitespace", "https://explorer.example/a/ {address}"],
    ["a relative path", "/a/{address}"],
  ])("rejects %s", (_label, value) => {
    expect(() => loadConfig({ [TESTNET]: value })).toThrow(/VITE_EXPLORER_TESTNET_ADDRESS_URL.*\{address\}/);
    expect(() => loadConfig({ [MAINNET]: value })).toThrow(/VITE_EXPLORER_MAINNET_ADDRESS_URL/);
  });

  it("the transaction templates still need the transaction placeholder, not the address one", () => {
    expect(() => loadConfig({ VITE_EXPLORER_TESTNET_TX_URL: "https://explorer.example/t/{address}" })).toThrow(/\{txid\}/);
  });
});

describe("public receipt base URL", () => {
  const KEY = "VITE_PUBLIC_RECEIPT_BASE_URL";

  it("is null unless configured", () => {
    expect(loadConfig({}).publicReceiptBaseUrl).toBeNull();
    expect(loadConfig({ [KEY]: "" }).publicReceiptBaseUrl).toBeNull();
  });

  it.each([
    ["https://verify.example.org", "https://verify.example.org"],
    ["https://verify.example.org/", "https://verify.example.org"],
    ["https://verify.example.org:8443//", "https://verify.example.org:8443"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
  ])("accepts %s", (value, expected) => {
    expect(loadConfig({ [KEY]: value }).publicReceiptBaseUrl).toBe(expected);
  });

  it.each([
    "http://verify.example.org",
    "https://verify.example.org/path",
    "https://verify.example.org?x=1",
    "https://verify.example.org#frag",
    "//verify.example.org",
    "verify.example.org",
    "javascript:alert(1)",
    "https://",
    "https://a b",
  ])("rejects %s", (value) => {
    expect(() => loadConfig({ [KEY]: value })).toThrow(/VITE_PUBLIC_RECEIPT_BASE_URL/);
  });

  it("rejects a non-string", () => {
    expect(() => loadConfig({ [KEY]: 5 })).toThrow(/must be a string/);
  });
});

describe("config singleton", () => {
  it("is frozen and holds validated values", () => {
    // Not asserting the defaults: a developer's local .env may legitimately
    // override them, and that must not break the suite.
    expect(Object.isFrozen(config)).toBe(true);
    expect(["testnet", "mainnet"]).toContain(config.network);
    expect(config.apiBaseUrl).toMatch(/^(\/|https?:\/\/)/);
    expect(config.apiBaseUrl.endsWith("/")).toBe(false);
    for (const template of Object.values(config.explorerTxUrl)) {
      expect(template).toContain("{txid}");
    }
    for (const template of Object.values(config.explorerAddressUrl)) {
      expect(template).toContain("{address}");
    }
  });
});

describe("public-only builds", () => {
  const KEY = "VITE_PUBLIC_ONLY";

  it("are off unless asked for", () => {
    expect(loadConfig({}).publicOnly).toBe(false);
    expect(loadConfig({ [KEY]: "" }).publicOnly).toBe(false);
    expect(loadConfig({ [KEY]: "false" }).publicOnly).toBe(false);
  });

  it("are on only for exactly 'true'", () => {
    expect(loadConfig({ [KEY]: "true" }).publicOnly).toBe(true);
  });

  it.each(["TRUE", "1", "yes", "on", true, 1])("refuse %j loudly, so a typo cannot leave operator screens on a hosted page", (value) => {
    expect(() => loadConfig({ [KEY]: value })).toThrow(/VITE_PUBLIC_ONLY/);
  });
});
