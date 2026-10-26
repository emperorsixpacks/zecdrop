// Re-checks, against the live explorers, the links the real sample receipts
// produce. Not run in CI (it needs the network, and third-party sites change);
// run it before submitting:
//
//   node scripts/check-explorer-links.mjs            fetch and print each link's HTTP status
//   node scripts/check-explorer-links.mjs --dry-run  print the links only, no network
//
// What it checks, for BOTH real samples (fixtures/testnet-ironwood-batch-8, the
// 8-output batch behind ?demo=real, and fixtures/testnet-ironwood-batch, the
// first batch behind ?demo=real-smoke): each batch's transaction page and the
// funding address page, on the default TESTNET explorer in src/lib/config.ts
// (read from that file, so it cannot drift from what the page links to), plus
// the explorer's pages for an unknown transaction and an unknown address, which
// must NOT be 200 (otherwise "200" would prove nothing). Exit status is 1 if a
// link that should exist does not answer 200, or one that should not exist does.
//
// Caveat: an explorer may fill its detail panels with client-side script, so a
// plain fetch confirms the page exists, not what it will show.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB = process.cwd();
const FIXTURES = resolve(WEB, "../fixtures/testnet-ironwood-batch");
const CONFIG = readFileSync(resolve(WEB, "src/lib/config.ts"), "utf8");
const DRY_RUN = process.argv.includes("--dry-run");

/** The default testnet template out of config.ts, e.g. https://x/tx/{txid}. */
function template(constName, placeholder) {
  const block = CONFIG.slice(CONFIG.indexOf(`const ${constName}`));
  const match = new RegExp(`testnet:\\s*\`(https://[^\`]*?)\\$\\{${placeholder}_PLACEHOLDER\\}([^\`]*)\``, "u").exec(block);
  if (!match) throw new Error(`could not find the testnet template in ${constName} (src/lib/config.ts)`);
  const marker = placeholder === "TXID" ? "{txid}" : "{address}";
  return `${match[1]}${marker}${match[2]}`;
}

const txTemplate = template("DEFAULT_EXPLORER_TX_URL", "TXID");
const addressTemplate = template("DEFAULT_EXPLORER_ADDRESS_URL", "ADDRESS");

// The real samples: each folder holds one <txid>/receipt.json, the folder named by the txid.
const SAMPLE_FOLDERS = ["testnet-ironwood-batch-8", "testnet-ironwood-batch"];
const samples = SAMPLE_FOLDERS.map((folder) => {
  const root = resolve(WEB, "..", "fixtures", folder);
  const [dir] = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/u.test(e.name));
  if (!dir) throw new Error(`no <txid>/ folder in ${root}`);
  const receipt = JSON.parse(readFileSync(join(root, dir.name, "receipt.json"), "utf8"));
  return { folder, receipt };
});

/** [what, url, should exist], each link once even if two samples share it. */
const seen = new Set();
const links = [];
const add = (what, url, shouldExist) => {
  if (seen.has(url)) return;
  seen.add(url);
  links.push([what, url, shouldExist]);
};
for (const { folder, receipt } of samples) {
  for (const batch of receipt.batches) {
    if (batch.txid) add(`transaction (${folder})`, txTemplate.replace("{txid}", batch.txid), true);
  }
  if (receipt.funding_address) add(`funding address (${folder})`, addressTemplate.replace("{address}", receipt.funding_address), true);
  else console.error(`note: ${folder} has no funding_address, so no address link is checked for it`);
}
add("unknown transaction (control)", txTemplate.replace("{txid}", "0".repeat(64)), false);
add("unknown address (control)", addressTemplate.replace("{address}", "tmNotARealAddressxxxxxxxxxxxxxxxxxx"), false);

if (DRY_RUN) {
  for (const [what, url] of links) console.log(`${what}\t${url}`);
  process.exit(0);
}

// A browser User-Agent: some explorers refuse the default one of a script.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let failed = false;
for (const [what, url, shouldExist] of links) {
  let status;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
    status = response.status;
  } catch (error) {
    status = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const good = shouldExist ? status === 200 : status !== 200;
  if (!good) failed = true;
  console.log(`${String(status).padEnd(5)} ${good ? "ok  " : "FAIL"} ${what}: ${url}`);
}
if (failed) {
  console.error("\nAt least one link did not behave as expected. Fix the default templates in src/lib/config.ts or choose another explorer.");
  process.exit(1);
}
