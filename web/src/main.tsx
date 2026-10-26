// First, so zod is configured before any module builds a schema (see the file).
import "./lib/zod-config";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { adoptTokenFromLocation } from "./api/operator/session";
import App from "./App";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./index.css";
import { initAppearance } from "./lib/appearance";
import { resumePractice } from "./lib/practice-mode";

// Take the operator token out of the URL fragment and the address bar BEFORE
// anything renders or any router reads the location. It is kept in memory only.
adoptTokenFromLocation(window.location, window.history);
// Following a new operator link in an open tab only changes the fragment.
window.addEventListener("hashchange", () => {
  adoptTokenFromLocation(window.location, window.history);
});

// Before first render, so nobody sees the page in a look they did not choose.
initAppearance();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");

const root = createRoot(rootElement);
// A tab that was in practice mode carries on in it, and nothing is drawn until the simulation is there to answer for it.
void resumePractice().then(() => {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
