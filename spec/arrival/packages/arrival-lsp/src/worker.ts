// worker — the Scheme language service as a (Shared)Worker entry.
//
// Side-effectful module: importing it inside a worker attaches the server to
// the worker's ports. Works as BOTH kinds:
//   • SharedWorker — every connecting tab gets a served port; same-options
//     connections share one service instance (cross-tab sharing, the point);
//   • dedicated Worker — the global scope itself is the port (the fallback
//     for browsers without module SharedWorkers).
//
// The service is the self-contained browser build (bundled prelude + stripped
// TS libs) — the worker needs no network and no fs.
//
// NB the `onconnect`/`onmessage` PROPERTY assignments are load-bearing:
// assigning `onmessage` auto-starts a MessagePort, while addEventListener
// requires an explicit `port.start()` — the unicorn/prefer-add-event-listener
// autofix silently breaks message flow here (rule off below).

/* eslint-disable unicorn/prefer-add-event-listener */

import { type LsPort } from "./ls-client.js";
import { serveSchemeLs } from "./ls-server.js";

interface SharedScopeLike {
  onconnect: ((ev: { ports: readonly LsPort[] }) => void) | null;
}

const scope = globalThis as unknown as Partial<SharedScopeLike> & Partial<LsPort>;
if ("onconnect" in scope) {
  // SharedWorker: serve each connecting port.
  (scope as SharedScopeLike).onconnect = (ev) => {
    const port = ev.ports[0];
    if (port !== undefined) serveSchemeLs(port);
  };
} else if (typeof scope.postMessage === "function") {
  // Dedicated worker: the global scope is the port.
  serveSchemeLs(scope as LsPort);
}
