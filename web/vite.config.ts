import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The demo receipt and the contract tests read files that live next to web/,
// not inside it. Vite refuses to serve files outside the project unless they
// are listed, so list exactly those directories and nothing wider.
const fsAllow = [
  here("."),
  here("../fixtures/contract"), // golden receipt: demo page + contract test
  here("../fixtures/testnet-ironwood-batch"), // the first real testnet batch: the "real-smoke" sample
  here("../fixtures/testnet-ironwood-batch-8"), // the 8-output real testnet batch: the "real" sample receipt
  // The Rust sources whose user-facing strings the tests compare against.
  // Only while testing; the dev server has no reason to serve them.
  ...(process.env["VITEST"] ? [here("../crates/drop-core/src"), here("../crates/drop-operator/src"), here("../crates/drop-zcash/src"), here("../docs")] : []),
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": here("./src"),
    },
  },
  server: { fs: { allow: fsAllow } },
  test: {
    // Pure-logic suites (money, crypto, schema) run in plain node. Component
    // suites opt in per file with a `// @vitest-environment jsdom` docblock.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
  },
});
