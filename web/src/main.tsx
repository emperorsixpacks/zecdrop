// First, so zod is configured before any module builds a schema (see the file).
import "./lib/zod-config";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { adoptTokenFromLocation } from "./api/operator/session";
import App from "./App";
import "./index.css";
import { applyTheme, resolveInitialTheme } from "./lib/theme";

// Take the operator token out of the URL fragment and the address bar BEFORE
// anything renders or any router reads the location. It is kept in memory only.
adoptTokenFromLocation(window.location, window.history);
// Following a new operator link in an open tab only changes the fragment.
window.addEventListener("hashchange", () => {
  adoptTokenFromLocation(window.location, window.history);
});

// Before first render, so a light-theme user does not see a dark flash.
applyTheme(resolveInitialTheme());

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
