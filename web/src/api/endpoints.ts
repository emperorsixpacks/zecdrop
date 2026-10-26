// Every verifier endpoint path, in one place. Paths are relative to
// config.apiBaseUrl (see apiUrl in client.ts), so changing the verifier's
// routes is a one-line edit here.

/** GET: recompute and return the public receipt for a set of transactions. */
export const RECEIPT_ENDPOINT = "/v1/receipt";

/** POST: check one recipient's payslip against the chain. A payslip names its receiver and its
 * amount, so it travels in the body of the request and never in the address. */
export const PAYSLIP_ENDPOINT = "/v1/payslip";
