// Import this FIRST (main.tsx does), before any module that builds a schema.
//
// zod compiles object parsers with `new Function` when it can, and finds out
// whether it can by trying. The operator serves this app with a strict
// Content-Security-Policy (`default-src 'self'`, so no eval): the browser blocks
// the probe and reports a violation in the console on every page load, even
// though zod catches the error and carries on. Turning the compiler off up front
// skips the probe. Parsing is the same, only not pre-compiled, which these small
// payloads do not need.
//
// It must run before the first schema is created: zod reads the setting when a
// schema is constructed.

import { z } from "zod";

z.config({ jitless: true });
