import { PROJECT_REPO_URL } from "./project";

/** A public testnet faucet that pays a transparent address, such as a payout's funding address (REQ-RUN-003): free test coins,
 * no wallet needed. Testnet only. */
export const TESTNET_FAUCET_URL = "https://faucet.testnet.valargroup.dev";

/** When the faucet cannot pay (it paid no one from 2026-10-23), the project pays a testnet payout's funding address from its
 * own test wallet: this opens a new GitHub issue on ZecDrop's repository that already holds the address and the amount asked
 * for. Nothing is sent until the person submits it. Both are public on the chain anyway; the issue puts the person's GitHub
 * name beside them (docs/PRIVACY_BOUNDARY.md). Testnet only. */
export function testCoinsRequestUrl(address: string, amountTaz: string): string {
  const body = [
    "The testnet faucet could not pay my payout's funding address. Please send it test coins.",
    "",
    `Funding address (testnet): ${address}`,
    `Amount it asks for: ${amountTaz} TAZ`,
  ].join("\n");
  const query = new URLSearchParams({ title: "Test coins for my payout", body });
  return `${PROJECT_REPO_URL}/issues/new?${query.toString()}`;
}
