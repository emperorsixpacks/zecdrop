// Watch every way a page can reach outside itself or leave something behind, so a test can say that a flow did neither.
//
//   network   fetch, XMLHttpRequest, navigator.sendBeacon, WebSocket, EventSource: each one is replaced by something that
//             records the call and refuses it, so nothing is ever sent from a test.
//   storage   every write, removal and clear on localStorage and sessionStorage, with the key and the value (a test may
//             look for what must not be in them).
//   cookies   every assignment to document.cookie.
//   databases every attempt to open an IndexedDB database.
//   console   every line the page logs.
//
// Call it first in a test and `restore()` (or `vi.unstubAllGlobals()` plus `restore()`) at the end.

import { vi } from "vitest";

export interface StorageWrite {
  area: "local" | "session" | "other";
  op: "setItem" | "removeItem" | "clear";
  key: string;
  value: string;
}

export interface Leaks {
  network: string[];
  storage: StorageWrite[];
  cookies: string[];
  databases: string[];
  console: string[];
  restore: () => void;
}

export function watchLeaks(): Leaks {
  const network: string[] = [];
  const storage: StorageWrite[] = [];
  const cookies: string[] = [];
  const databases: string[] = [];
  const logged: string[] = [];
  const undo: (() => void)[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      network.push("fetch");
      return Promise.reject(new TypeError("the network is off in this test"));
    }),
  );
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      constructor() {
        network.push("XMLHttpRequest");
      }
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor() {
        network.push("WebSocket");
      }
    },
  );
  vi.stubGlobal(
    "EventSource",
    class {
      constructor() {
        network.push("EventSource");
      }
    },
  );
  vi.stubGlobal("indexedDB", {
    open: () => {
      databases.push("open");
      throw new Error("no database in this test");
    },
  });
  Object.defineProperty(globalThis.navigator, "sendBeacon", {
    configurable: true,
    value: () => {
      network.push("sendBeacon");
      return false;
    },
  });
  undo.push(() => {
    Reflect.deleteProperty(globalThis.navigator, "sendBeacon");
  });

  // The prototype is patched rather than spied on, so that localStorage and sessionStorage are both watched and both keep working.
  const storagePrototype = Storage.prototype as unknown as Record<string, (this: Storage, ...args: string[]) => unknown>;
  for (const op of ["setItem", "removeItem", "clear"] as const) {
    const original = storagePrototype[op];
    if (original === undefined) continue;
    storagePrototype[op] = function (this: Storage, ...args: string[]) {
      const area = this === globalThis.localStorage ? "local" : this === globalThis.sessionStorage ? "session" : "other";
      storage.push({ area, op, key: args[0] ?? "", value: args[1] ?? "" });
      return Reflect.apply(original, this, args);
    };
    undo.push(() => {
      storagePrototype[op] = original;
    });
  }

  Object.defineProperty(globalThis.document, "cookie", {
    configurable: true,
    get: () => "",
    set: (value: string) => {
      cookies.push(value);
    },
  });
  undo.push(() => {
    Reflect.deleteProperty(globalThis.document, "cookie");
  });

  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    undo.push(() => {
      spy.mockRestore();
    });
  }

  return {
    network,
    storage,
    cookies,
    databases,
    console: logged,
    restore: () => {
      for (const step of undo.splice(0)) step();
      vi.unstubAllGlobals();
    },
  };
}
