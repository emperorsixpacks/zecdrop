// The SINGLE source of runtime configuration.
//
// This is the only module in src/ allowed to touch `import.meta` (enforced by
// an ESLint `no-restricted-syntax` rule in eslint.config.js). Everything else
// imports `config` from here, so a value can never be re-declared with a
// different default in another file.

export type ZecNetwork = "testnet" | "mainnet";

/** Where the transaction id goes in an explorer URL template. */
export const TXID_PLACEHOLDER = "{txid}";
/** Where the address goes in an explorer address-page template. */
export const ADDRESS_PLACEHOLDER = "{address}";

export interface AppConfig {
  /** Base URL of the operator/verifier API, no trailing slash. */
  readonly apiBaseUrl: string;
  readonly network: ZecNetwork;
  /** Block-explorer link per network, containing {@link TXID_PLACEHOLDER}. */
  readonly explorerTxUrl: Readonly<Record<ZecNetwork, string>>;
  /** Block-explorer page for a transparent address per network, containing
   * {@link ADDRESS_PLACEHOLDER}. */
  readonly explorerAddressUrl: Readonly<Record<ZecNetwork, string>>;
  /** Where the PUBLIC receipt page is hosted (origin only, no trailing slash),
   * so a share link can point at the verifier instead of the loopback operator.
   * Null when not configured: the link is then shown as a path. */
  readonly publicReceiptBaseUrl: string | null;
  /** True for a build meant to be hosted publicly as the receipt viewer only: the
   * operator pages then explain themselves instead of calling an operator. */
  readonly publicOnly: boolean;
}

const DEFAULT_API_BASE_URL = "/api";
const DEFAULT_NETWORK: ZecNetwork = "testnet";
// Default explorers.
//
// TESTNET is ZecBlock (testnet.zecblock.com). The previous default,
// testnet.zcashexplorer.app, stopped at block 4,331,234 while the chain this
// project is tested on was past 4,478,066, so its page for the first real
// batch (txid 50fb88e0..., mined at 4,478,065) said "Transaction Not Found".
// Checked 2026-10-08 on testnet.zecblock.com, with and without a browser
// User-Agent: /tx/<txid> answers 200 with the title "Zcash Transaction 50fb88e0...
// | ZecBlock" for that batch and 404 "... Not Found" for an unknown txid;
// /address/<address> answers 200 for tmU6c1a... (the batch's funding input) and
// 404 for an address that does not exist; /block/4478065 answers 200. Its detail
// panel is filled in by client-side script, so a plain fetch sees only the
// summary. /transactions/<txid> is NOT its pattern (404). testnet.cipherscan.app
// redirects (301) to it. web/scripts/check-explorer-links.mjs re-checks the
// links of the real sample; run it before submitting.
//
// MAINNET stays on zcashexplorer.app, checked 2026-10-07 and 2026-10-08 with a
// browser User-Agent: /transactions/<txid> returns 200 for the genesis coinbase
// txid (c4eaa588...) and 404 "Transaction Not Found" for an unknown one;
// /address/<address> returns 200 for a real address taken from the explorer's
// own transaction page (t1PEp2GJ...) and 404 for an address that does not exist.
// The site answers 403 to curl's default User-Agent; that is bot filtering and
// does not affect browsers.
//
// Explorers are third parties and can lag or follow a different chain: a "not
// found" there is not proof that a transaction is absent from the chain. The
// receipt page says so next to the real sample.
const DEFAULT_EXPLORER_TX_URL: Readonly<Record<ZecNetwork, string>> = {
  testnet: `https://testnet.zecblock.com/tx/${TXID_PLACEHOLDER}`,
  mainnet: `https://mainnet.zcashexplorer.app/transactions/${TXID_PLACEHOLDER}`,
};

const DEFAULT_EXPLORER_ADDRESS_URL: Readonly<Record<ZecNetwork, string>> = {
  testnet: `https://testnet.zecblock.com/address/${ADDRESS_PLACEHOLDER}`,
  mainnet: `https://mainnet.zcashexplorer.app/address/${ADDRESS_PLACEHOLDER}`,
};

function parseApiBaseUrl(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_API_BASE_URL;
  }
  if (typeof raw !== "string") {
    throw new Error("VITE_API_URL must be a string");
  }
  // Either same-origin absolute path ("/api") or an absolute http(s) URL.
  // "//host" is protocol-relative and would silently send traffic elsewhere.
  const isPath = raw.startsWith("/") && !raw.startsWith("//");
  const isHttpUrl = /^https?:\/\/[^\s/]+/i.test(raw);
  if (!isPath && !isHttpUrl) {
    throw new Error(
      `VITE_API_URL must be an absolute path ("/api") or an http(s) URL, got "${raw}"`,
    );
  }
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed === "" ? DEFAULT_API_BASE_URL : trimmed;
}

function parseNetwork(raw: unknown): ZecNetwork {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_NETWORK;
  }
  // Fail loudly: silently falling back to testnet (or mainnet) on a typo
  // would show the operator the wrong network while they handle real funds.
  if (raw === "testnet" || raw === "mainnet") {
    return raw;
  }
  const got = typeof raw === "string" ? `"${raw}"` : typeof raw;
  throw new Error(`VITE_ZEC_NETWORK must be "testnet" or "mainnet", got ${got}`);
}

/** An explorer template must be an https URL with the txid placeholder exactly
 * once, so a typo cannot produce links that go somewhere unintended. */
function parseExplorerTemplate(
  name: string,
  raw: unknown,
  fallback: string,
  placeholder: string = TXID_PLACEHOLDER,
): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") throw new Error(`${name} must be a string`);
  const placeholders = raw.split(placeholder).length - 1;
  if (!/^https:\/\/[^\s/]+\S*$/u.test(raw) || placeholders !== 1) {
    throw new Error(
      `${name} must be an https URL containing ${placeholder} exactly once`,
    );
  }
  return raw;
}

function parsePublicReceiptBaseUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("VITE_PUBLIC_RECEIPT_BASE_URL must be a string");
  // An origin: https, or http for localhost development. No path, query or fragment.
  const ok = /^https:\/\/[^\s/?#]+$/u.test(raw.replace(/\/+$/u, "")) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(raw.replace(/\/+$/u, ""));
  if (!ok) {
    throw new Error("VITE_PUBLIC_RECEIPT_BASE_URL must be an https origin (or http://localhost), with no path");
  }
  return raw.replace(/\/+$/u, "");
}

function parsePublicOnly(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Fail loudly: a typo must not quietly leave a hosted page showing operator screens.
  throw new Error('VITE_PUBLIC_ONLY must be "true" or "false"');
}

/** Pure so it can be unit-tested without Vite. */
export function loadConfig(env: Record<string, unknown>): AppConfig {
  return {
    apiBaseUrl: parseApiBaseUrl(env["VITE_API_URL"]),
    network: parseNetwork(env["VITE_ZEC_NETWORK"]),
    explorerTxUrl: {
      testnet: parseExplorerTemplate(
        "VITE_EXPLORER_TESTNET_TX_URL",
        env["VITE_EXPLORER_TESTNET_TX_URL"],
        DEFAULT_EXPLORER_TX_URL.testnet,
      ),
      mainnet: parseExplorerTemplate(
        "VITE_EXPLORER_MAINNET_TX_URL",
        env["VITE_EXPLORER_MAINNET_TX_URL"],
        DEFAULT_EXPLORER_TX_URL.mainnet,
      ),
    },
    explorerAddressUrl: {
      testnet: parseExplorerTemplate(
        "VITE_EXPLORER_TESTNET_ADDRESS_URL",
        env["VITE_EXPLORER_TESTNET_ADDRESS_URL"],
        DEFAULT_EXPLORER_ADDRESS_URL.testnet,
        ADDRESS_PLACEHOLDER,
      ),
      mainnet: parseExplorerTemplate(
        "VITE_EXPLORER_MAINNET_ADDRESS_URL",
        env["VITE_EXPLORER_MAINNET_ADDRESS_URL"],
        DEFAULT_EXPLORER_ADDRESS_URL.mainnet,
        ADDRESS_PLACEHOLDER,
      ),
    },
    publicReceiptBaseUrl: parsePublicReceiptBaseUrl(env["VITE_PUBLIC_RECEIPT_BASE_URL"]),
    publicOnly: parsePublicOnly(env["VITE_PUBLIC_ONLY"]),
  };
}

export const config: AppConfig = Object.freeze(
  loadConfig({
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_ZEC_NETWORK: import.meta.env.VITE_ZEC_NETWORK,
    VITE_EXPLORER_TESTNET_TX_URL: import.meta.env.VITE_EXPLORER_TESTNET_TX_URL,
    VITE_EXPLORER_MAINNET_TX_URL: import.meta.env.VITE_EXPLORER_MAINNET_TX_URL,
    VITE_EXPLORER_TESTNET_ADDRESS_URL: import.meta.env.VITE_EXPLORER_TESTNET_ADDRESS_URL,
    VITE_EXPLORER_MAINNET_ADDRESS_URL: import.meta.env.VITE_EXPLORER_MAINNET_ADDRESS_URL,
    VITE_PUBLIC_RECEIPT_BASE_URL: import.meta.env.VITE_PUBLIC_RECEIPT_BASE_URL,
    VITE_PUBLIC_ONLY: import.meta.env.VITE_PUBLIC_ONLY,
  }),
);
