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

// jsdom has <dialog> but not its modal methods. Opening one only sets `open`; closing
// removes it and says so, as a browser does.
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
