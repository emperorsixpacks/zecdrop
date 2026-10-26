// A payslip as a link, and a link as a payslip (openspec REQ-PAY-004).
//
//   <origin>/payslip#payslip=<the payslip's body, base64url, no padding>
//
// The payslip is only after the "#". A browser never sends the fragment of an address to a server, so a link can
// be opened, and a QR code of it scanned, without telling the host what it holds. It is still a bearer document in
// an address: whoever has the link has the payslip, its receiver, its amount and the key to its memo, and can show it
// as their own. The page says so where a link is made and where one is opened, and takes the fragment out of the
// address bar the moment it has read it (PayslipPage.tsx).
//
// Reading a link is as strict as reading a paste: a size cap, the base64url alphabet and nothing else, the one
// canonical spelling of the bytes, valid text, and then readPayslip (the seven fields, hex of the right length, the
// network, the amount). Nothing is kept here, and nothing about what was read is ever put in an error.

import { MAX_PAYSLIP_BODY, payslipBody, readPayslip, type Payslip } from "./payslip-input";

/** The page a link opens. */
export const LINK_PATH = "/payslip";
/** The name of the one thing in the fragment. */
export const LINK_KEY = "payslip";

const PREFIX = `#${LINK_KEY}=`;
/** The longest the base64url of a payslip's body can be: the body is at most what the verifier reads (1 KiB). */
export const MAX_LINK_VALUE = Math.ceil((MAX_PAYSLIP_BODY * 4) / 3);

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The bytes of base64url text, or null if it is not exactly what `toBase64Url` writes for some bytes. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length > MAX_LINK_VALUE || text.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(`${text.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (text.length % 4)) % 4)}`);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // One spelling only: text with stray bits at its end is not a link this page made.
  return toBase64Url(bytes) === text ? bytes : null;
}

/** The link for a payslip, on `base` (an origin, with no path). */
export function payslipLink(payslip: Payslip, base: string): string {
  return `${base.replace(/\/+$/u, "")}${LINK_PATH}${PREFIX}${toBase64Url(new TextEncoder().encode(payslipBody(payslip)))}`;
}

export type LinkRead = { ok: true; payslip: Payslip } | { ok: false };

/** Whether a fragment (`location.hash`) says it is a payslip link, good or not: it is that or nothing of ours. */
export function claimsToBeLink(hash: string): boolean {
  return hash === `#${LINK_KEY}` || hash.startsWith(PREFIX);
}

/** What the fragment of an address (`location.hash`) holds: null when it is not a payslip link at all (no fragment, or
 * another one, such as the skip link's `#main`), the payslip when it is a good one, and `{ ok: false }` for anything
 * that claims to be one and is not. */
export function readPayslipFragment(hash: string): LinkRead | null {
  if (!claimsToBeLink(hash)) return null;
  const bytes = hash.startsWith(PREFIX) ? fromBase64Url(hash.slice(PREFIX.length)) : null;
  if (bytes === null) return { ok: false };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }
  const read = readPayslip(text);
  return read.ok ? { ok: true, payslip: read.payslip } : { ok: false };
}
