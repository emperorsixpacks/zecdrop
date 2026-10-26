// Import from component tests (which run under jsdom) to get jest-dom
// matchers and automatic cleanup between tests. Not a global setup file:
// the pure-logic suites run in plain node and should not pay for it.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// The whole app renders in these tests, and a full test run has many files at
// once on one machine. The default one second for findBy*/waitFor made a test
// fail now and then for being slow, not for being wrong. A real failure still
// fails, a few seconds later.
configure({ asyncUtilTimeout: 4_000 });
