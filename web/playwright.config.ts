import { defineConfig } from "@playwright/test";

const PORT = 4173;
const HOSTED_PORT = 4174;
const STUB_PORT = 4175;
const STUB = `http://127.0.0.1:${String(STUB_PORT)}`;
// The same variables a real public build is made with.
const HOSTED_ENV = `VITE_API_URL=${STUB} VITE_ZEC_NETWORK=testnet VITE_PUBLIC_ONLY=true`;

// Real-browser checks that jsdom cannot do: layout at phone width, computed
// colour contrast in both themes, keyboard focus, and the whole operator flow
// against the real operator binary. They run against the production build,
// which is what visitors get.
//
//   npm run e2e        builds the page, then runs everything
//
// Three projects:
//
//   public    the public pages (home, receipt, privacy) served by `vite preview`
//   hosted    a production build made the way a public deployment is made (VITE_PUBLIC_ONLY,
//             a verifier address), served WITH the headers and rewrites of the vercel.json that
//             scripts/hosted-config.mjs generates for it, against a stub verifier. It checks
//             that the Content-Security-Policy breaks nothing and that the operator pages
//             explain themselves. Nothing is deployed and no hosting API is called.
//   operator  the operator pages, served by the REAL operator binary on the mock
//             chain (../target/debug/drop-operator), started and stopped by
//             e2e/operator/global-setup.ts. It builds nothing: it needs the
//             binary (cargo build -p drop-operator) and web/dist (npm run build).
export default defineConfig({
  fullyParallel: true,
  reporter: "list",
  // Counting numbers and wipes are motion; the checks look at the settled page.
  use: { reducedMotion: "reduce" },
  globalSetup: "./e2e/operator/global-setup.ts",
  projects: [
    {
      name: "public",
      testDir: "e2e",
      testIgnore: ["operator/**", "hosted/**"],
      use: { browserName: "chromium", baseURL: `http://127.0.0.1:${String(PORT)}` },
    },
    {
      name: "hosted",
      testDir: "e2e/hosted",
      use: { browserName: "chromium", baseURL: `http://127.0.0.1:${String(HOSTED_PORT)}` },
    },
    {
      name: "operator",
      testDir: "e2e/operator",
      // Several of these walk a whole wizard or five pages and run axe on each.
      timeout: 90_000,
      use: { browserName: "chromium" },
    },
  ],
  webServer: [
    {
      command: `npm run preview -- --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(PORT)}`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    {
      command: "node e2e/hosted/stub-verifier.mjs",
      url: `${STUB}/v1/health`,
      env: { STUB_PORT: String(STUB_PORT), STUB_ALLOWED_ORIGIN: `http://127.0.0.1:${String(HOSTED_PORT)}` },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // Build the page as a public deployment is built, write its hosting config, serve it with that config.
      command:
        `${HOSTED_ENV} npx vite build --outDir dist-hosted --emptyOutDir && ` +
        `VITE_API_URL=${STUB} node scripts/hosted-config.mjs --dist dist-hosted && ` +
        `node scripts/serve-hosted.mjs --dir dist-hosted --port ${String(HOSTED_PORT)}`,
      url: `http://127.0.0.1:${String(HOSTED_PORT)}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
