import { afterEach, describe, expect, it, vi } from "vitest";

// The operator's Content-Security-Policy forbids eval. zod probes for it with
// `new Function` unless told not to, and the browser reports every probe as a
// violation. This builds the app's schemas in a fresh module registry with
// `Function` rigged to count constructions.

const RealFunction = globalThis.Function;

/** Count `new Function(...)` / `Function(...)` calls while `run` builds schemas and parses. */
async function functionCallsDuring(run: () => Promise<void>): Promise<number> {
  let calls = 0;
  const counting = new Proxy(RealFunction, {
    construct(target, args, newTarget) {
      calls += 1;
      return Reflect.construct(target, args, newTarget) as object;
    },
    apply(target, thisArg, args) {
      calls += 1;
      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });
  globalThis.Function = counting;
  try {
    await run();
  } finally {
    globalThis.Function = RealFunction;
  }
  return calls;
}

afterEach(() => {
  globalThis.Function = RealFunction;
  vi.resetModules();
});

// zod and its settings are shared by every test in this file, so the order matters:
// the control runs first, before anything has configured zod.
describe("zod and the Content-Security-Policy", () => {
  it("(control, must stay first) does construct one without the configuration, so the count in the next test means something", async () => {
    vi.resetModules();
    const calls = await functionCallsDuring(async () => {
      const { parseHealth, parseStartResponse } = await import("@/api/operator/schemas");
      parseHealth({ ok: true, network: "testnet", mock: true });
      parseStartResponse({ started: true, run: { state: "running" } });
    });
    expect(calls).toBeGreaterThan(0);
  }, 30_000);

  it("builds and runs the operator schemas without ever constructing a Function, once configured", async () => {
    vi.resetModules();
    const calls = await functionCallsDuring(async () => {
      await import("./zod-config");
      const { parseHealth, parseStartResponse } = await import("@/api/operator/schemas");
      expect(parseHealth({ ok: true, network: "testnet", mock: true }).mock).toBe(true);
      expect(parseStartResponse({ started: true, run: { state: "running" } }).started).toBe(true);
    });
    expect(calls).toBe(0);
  }, 30_000);

  it("main.tsx imports the configuration before anything else", async () => {
    const main = (await import("../main.tsx?raw")).default;
    const imports = [...main.matchAll(/^import\s+(?:[^"']*from\s+)?["']([^"']+)["']/gmu)].map((m) => m[1]);
    expect(imports[0]).toBe("./lib/zod-config");
  });
});
