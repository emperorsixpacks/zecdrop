// How the operator specs find the real operator that global-setup started.
// global-setup sets these in the environment; worker processes inherit them.

export interface Seeded {
  /** Created and left unfunded. */
  awaiting: string;
  /** Funded, not started. */
  funded: string;
  /** Started and run to the end. */
  settled: string;
}

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set: the operator specs need e2e/operator/global-setup.ts to have run`);
  }
  return value;
}

/** `http://127.0.0.1:<port>` of the operator, which also serves web/dist. */
export const operatorOrigin = (): string => need("ZECDROP_E2E_ORIGIN");

/** The operator's bearer token for this run. Never written to a report. */
export const operatorToken = (): string => need("ZECDROP_E2E_TOKEN");

export const seeded = (): Seeded => JSON.parse(need("ZECDROP_E2E_SEEDED")) as Seeded;

/** A URL on the operator. With `token`, it carries the token in the fragment
 * the way the link printed in the terminal does. */
export function operatorUrl(path: string, options: { token?: string | boolean } = {}): string {
  const base = `${operatorOrigin()}${path}`;
  if (options.token === undefined || options.token === false) return base;
  const token = options.token === true ? operatorToken() : options.token;
  return `${base}#token=${token}`;
}
