// ls-server — the HEAVY side of the worker protocol (hosts the real service).
//
// Lives apart from ls-client so the main thread never imports the service
// (typescript + the bundles belong to the worker's chunk).
//
// Sharing model: services are memoized by options-profile, so every
// connection (every tab of a SharedWorker, every editor in a tab) with the
// same options shares ONE instance — one prelude compilation, one document
// registry, one warm cache. The service's methods are synchronous and
// self-contained per call (each loads its own source first), so interleaved
// requests from multiple ports are safe by construction.
//
// NB `onmessage` PROPERTY assignment is load-bearing (auto-starts
// MessagePorts; addEventListener would need `port.start()`).

/* eslint-disable unicorn/prefer-add-event-listener */

import { createBrowserSchemeLanguageService } from "./browser.js";
import { LS_METHODS, type LsPort, type LsReply, type LsRequest, type SchemeLsWorkerOptions } from "./ls-client.js";
import { lookupProjectFile, lookupProjectRequireType } from "./require-path.js";
import type { SchemeLanguageService, SchemeLanguageServiceOptions } from "./service-core.js";

type MethodName = (typeof LS_METHODS)[number];
/** Wire method name → a real service method, proven for the type-checker. `.some`
 *  with `===` compares each literal against the string with no cast (unlike
 *  `LS_METHODS.includes`, whose param is the literal union and rejects a `string`). */
const isMethodName = (m: string): m is MethodName => LS_METHODS.some((x) => x === m);

/** `(require …)` resolution over the wire: a CALLBACK can't cross postMessage,
 *  so each CONNECTION pushes its project-files table ({kind:"files"}) and the
 *  shared service resolves through this swap slot. Sound because the worker
 *  dispatches messages one at a time and the service's methods are fully
 *  synchronous — the slot is set for exactly one call's duration. */
let activeFiles: Readonly<Record<string, string>> | null = null;
/** Open buffer path (project-relative) for relative require resolution. */
let activeOpenPath: string | null = null;
const resolveThroughActiveFiles = (path: string): string | null =>
  lookupProjectFile(activeFiles, path, {
    fromFile: activeOpenPath,
    log: true,
    logLabel: "scheme-ls-require",
  });

/** The require-TYPE twin of `activeFiles`: a precomputed `{ path → TS type }`
 *  map pushed by the connection ({kind:"requireTypes"}). Read through the same
 *  one-call-at-a-time swap slot — a `resolveRequireType` callback can't cross
 *  postMessage, so the type is synthesized host-side and the result shipped. */
let activeRequireTypes: Readonly<Record<string, string>> | null = null;
const resolveThroughActiveRequireTypes = (path: string): string | null =>
  lookupProjectRequireType(activeRequireTypes, path, {
    fromFile: activeOpenPath,
    log: false, // files resolver already logs misses; avoid double spam
    logLabel: "scheme-ls-require-type",
  });

/** Service per options-profile — THE sharing point. */
const sharedServices = new Map<string, SchemeLanguageService>();
/** Test seam: identity of the memo slot, not wall-clock. */
export function peekSharedService(options: SchemeLsWorkerOptions): SchemeLanguageService | undefined {
  return sharedServices.get(JSON.stringify(options));
}
function serviceFor(options: SchemeLsWorkerOptions): SchemeLanguageService {
  const key = JSON.stringify(options);
  let svc = sharedServices.get(key);
  if (svc === undefined) {
    svc = createBrowserSchemeLanguageService({
      ...options,
      // Only `compilerOptions` genuinely diverges: the wire weakens it to a
      // cloneable `Record<string, unknown>`, the service wants `ts.CompilerOptions`.
      // Cast THAT field alone (tied to the service's own field type, so it tracks a
      // future change) — `host`/`schemePrelude` stay checked, so a drift between the
      // wire and service shapes is a compile error, not a silently-blinded blanket cast.
      compilerOptions: options.compilerOptions as SchemeLanguageServiceOptions["compilerOptions"],
      resolveModule: resolveThroughActiveFiles,
      resolveRequireType: resolveThroughActiveRequireTypes,
    });
    sharedServices.set(key, svc);
    // Warm the first compilation off ANY caller's request path.
    const warm = svc;
    setTimeout(() => {
      try {
        warm.getSemanticDiagnostics(";");
      } catch {
        // warm-up only — a failure surfaces on a real call
      }
    }, 0);
  }
  return svc;
}

/** Host the language service on a port. One call per connection. */
export function serveSchemeLs(port: LsPort): void {
  let service: SchemeLanguageService | null = null;
  let files: Readonly<Record<string, string>> | null = null;
  let requireTypes: Readonly<Record<string, string>> | null = null;
  let openPath: string | null = null;
  port.onmessage = (ev) => {
    const msg = ev.data as LsRequest;
    try {
      if (msg.kind === "init") {
        service = serviceFor(msg.options);
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (msg.kind === "files") {
        // The connection's require-resolution table (replace-wholesale; the
        // host pushes a fresh snapshot whenever the project changes).
        files = msg.files;
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (msg.kind === "requireTypes") {
        // The connection's require-TYPE table (replace-wholesale; pushed fresh
        // whenever the project's data files change).
        requireTypes = msg.types;
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (msg.kind === "openPath") {
        openPath = msg.path;
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (service === null) throw new Error("scheme-ls: call before init");
      if (!isMethodName(msg.method)) throw new Error(`scheme-ls: unknown method ${msg.method}`);
      activeFiles = files;
      activeRequireTypes = requireTypes;
      activeOpenPath = openPath;
      let value: unknown;
      try {
        // The dynamic dispatch: `service[name]` is a union of the LS_METHODS
        // signatures, not callable under one arg list — the callable cast is the
        // unavoidable boundary (the NAME is already proven by `isMethodName`).
        value = (service[msg.method] as (...a: unknown[]) => unknown)(...msg.args);
      } finally {
        activeFiles = null;
        activeRequireTypes = null;
        activeOpenPath = null;
      }
      port.postMessage({ kind: "reply", id: msg.id, ok: true, value } satisfies LsReply);
    } catch (error) {
      port.postMessage({
        kind: "reply",
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies LsReply);
    }
  };
}
