// What a person pastes as a payslip, read strictly before anything is sent.
//
// A payslip is one recipient's proof of one payout: a small JSON file that names a transaction, the
// position of one output in it, the receiver, the amount, and the secret (`rseed`) that also opens
// that output's memo (crates/drop-verify/src/payslip.rs, docs/PRIVACY_BOUNDARY.md "Payslips"). The
// verifier refuses any field it does not know, so this reads exactly the seven it does and sends
// exactly those, built afresh in a fixed order: never the pasted text, which may carry other fields
// or a great deal of space.
//
// Nothing here keeps what it reads, and a problem never repeats the text it found: a payslip is a
// bearer document.

import type { ZecNetwork } from "@/lib/config";
import { isMoneyZatoshiString } from "@/lib/zec";

export interface Payslip {
  version: 1;
  network: ZecNetwork;
  /** The batch transaction: 64 lowercase hex characters. */
  txid: string;
  /** Position of the output's action in the transaction's shielded bundle, counting from 0. */
  action: number;
  /** The recipient's Orchard receiver: 43 bytes, 86 lowercase hex characters. */
  receiver: string;
  /** Zatoshi, decimal string. */
  value: string;
  /** The note's secret: 32 bytes, 64 lowercase hex characters. Never shown. */
  rseed: string;
}

export const PAYSLIP_VERSION = 1;

/** The most text that can be a payslip. The offline command reads files up to 4 KiB; a payslip is about 340 bytes. */
export const MAX_PAYSLIP_TEXT = 4096;

/** The hosted verifier reads at most this much body. What is sent is about 330 bytes whatever was pasted. */
export const MAX_PAYSLIP_BODY = 1024;

const U32_MAX = 4_294_967_295;
const HEX_32_BYTES = /^[0-9a-f]{64}$/u;
const HEX_43_BYTES = /^[0-9a-f]{86}$/u;

/** The fields, in the order the verifier writes them. */
const FIELDS: readonly string[] = ["version", "network", "txid", "action", "receiver", "value", "rseed"];

/** Text that marks a Zcash viewing key. The verifier refuses a body that holds one (crates/drop-verifier/src/query.rs);
 * so does this page, before it reads anything else, so a key pasted by mistake goes nowhere. */
const VIEWING_KEY_MARKERS: readonly string[] = ["uview", "uivk", "ufvk", "zxview", "zviews", "zivk"];

export type PayslipProblem =
  | "empty"
  | "too_long"
  | "viewing_key"
  | "not_json"
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "bad_version"
  | "bad_network"
  | "bad_txid"
  | "bad_action"
  | "bad_receiver"
  | "bad_value"
  | "bad_rseed";

/** Plain-language explanation. Never includes the offending text. */
export const PAYSLIP_PROBLEM_TEXT: Record<PayslipProblem, string> = {
  empty: "Paste a payslip first.",
  too_long: "That is too long to be a payslip. A payslip is a few hundred characters.",
  viewing_key: "That looks like a viewing key, not a payslip. Never paste a key on this page.",
  not_json: "That is not a payslip: it is not valid JSON. Paste the whole file.",
  not_an_object: "That is not a payslip. A payslip is one JSON object, from { to }.",
  unknown_field: "The payslip has a field this page does not know. Paste the original file.",
  missing_field: "The payslip is missing a field. Paste the whole file.",
  bad_version: "This page reads version 1 payslips only.",
  bad_network: "The network in the payslip is not testnet or mainnet.",
  bad_txid: "The transaction id in the payslip is not valid.",
  bad_action: "The action number in the payslip is not valid.",
  bad_receiver: "The receiver in the payslip is not valid.",
  bad_value: "The amount in the payslip is not valid.",
  bad_rseed: "The secret in the payslip is not valid.",
};

export type PayslipRead = { ok: true; payslip: Payslip } | { ok: false; problem: PayslipProblem };

const fail = (problem: PayslipProblem): PayslipRead => ({ ok: false, problem });

/** Read and strictly validate pasted text. The first problem found is the one returned. */
export function readPayslip(text: string): PayslipRead {
  if (text.length > MAX_PAYSLIP_TEXT) return fail("too_long");
  const lower = text.toLowerCase();
  if (VIEWING_KEY_MARKERS.some((marker) => lower.includes(marker))) return fail("viewing_key");
  const trimmed = text.trim();
  if (trimmed === "") return fail("empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return fail("not_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("not_an_object");

  // Exactly the seven fields: one more is refused by the verifier, one fewer cannot be a payslip.
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((name) => !FIELDS.includes(name))) return fail("unknown_field");
  if (FIELDS.some((name) => !Object.hasOwn(record, name))) return fail("missing_field");

  const { version, network, txid, action, receiver, value, rseed } = record;
  if (version !== PAYSLIP_VERSION) return fail("bad_version");
  if (network !== "testnet" && network !== "mainnet") return fail("bad_network");
  if (typeof txid !== "string" || !HEX_32_BYTES.test(txid)) return fail("bad_txid");
  if (typeof action !== "number" || !Number.isInteger(action) || action < 0 || action > U32_MAX) return fail("bad_action");
  if (typeof receiver !== "string" || !HEX_43_BYTES.test(receiver)) return fail("bad_receiver");
  if (typeof value !== "string" || !isMoneyZatoshiString(value)) return fail("bad_value");
  if (typeof rseed !== "string" || !HEX_32_BYTES.test(rseed)) return fail("bad_rseed");

  return { ok: true, payslip: { version, network, txid, action, receiver, value, rseed } };
}

/** The body of the request: the payslip, compact, with its fields in the verifier's order. */
export function payslipBody(payslip: Payslip): string {
  const { version, network, txid, action, receiver, value, rseed } = payslip;
  return JSON.stringify({ version, network, txid, action, receiver, value, rseed });
}
