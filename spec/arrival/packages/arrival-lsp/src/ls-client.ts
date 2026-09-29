// ls-client — the LIGHT side of the worker protocol (wire types + connect).
//
// Deliberately imports nothing heavy: the main thread loads THIS to talk to a
// worker-hosted service, so it must not drag `typescript` + the bundles into
// the main bundle (that's the worker's chunk). The serve side lives in
// ls-server.ts; `./ls-protocol` barrels both for in-process use and tests.
//
// NB `onmessage` PROPERTY assignment is load-bearing: it AUTO-STARTS a
// MessagePort; addEventListener requires an explicit `port.start()` the
// LsPort seam doesn't carry.

/* eslint-disable unicorn/prefer-add-event-listener */

import type { SchemeLanguageService } from "./service-core.js";

/** The wire-safe creation options (a structurally-cloneable subset). */
export interface SchemeLsWorkerOptions {
  compilerOptions?: Record<string, unknown>;
  host?: { prelude: string; members: readonly string[]; kwargsMembers?: readonly string[] };
  /** The scheme stdlib preamble source (arrival's `BUILTIN_PREAMBLE`) — a plain
   *  string, so it crosses postMessage as-is. Emitted ahead of the program so
   *  its `(define …)` helpers resolve. See `SchemeLanguageServiceOptions`. */
  schemePrelude?: string;
  /** Require-path suffixes whose `(require "…")` result is a kwargs callable. */
  kwargsRequireSuffixes?: readonly string[];
}

export type LsInit = { kind: "init"; options: SchemeLsWorkerOptions };
export type LsCall = { kind: "call"; method: string; args: unknown[] };
/** A require-resolution table push: `(require …)` can't ship a callback over
 *  postMessage, so the connection sends a files snapshot the service resolves
 *  through (replace-wholesale). */
export type LsFiles = { kind: "files"; files: Record<string, string> };
/** The require-TYPE twin of {@link LsFiles}: a precomputed `{ path → TS type }`
 *  snapshot synthesized host-side. */
export type LsRequireTypes = { kind: "requireTypes"; types: Record<string, string> };
/** Open buffer path (project-relative) so relative `(require "config.scm")`
 *  resolves against the editor's directory in a multi-package tree. */
export type LsOpenPath = { kind: "openPath"; path: string | null };
/** Every request payload (sans correlation id) — the one named source of truth
 *  both sides dispatch on. `id` lives only on the wire ({@link LsRequest}): the
 *  caller passes a payload, `call` stamps the id. Modelled id-less so the union
 *  can be widened/narrowed by `kind` without `Omit` collapsing it to the shared
 *  keys (a union `Omit` keeps only common members — it would drop the payloads). */
export type LsMessage = LsInit | LsCall | LsFiles | LsRequireTypes | LsOpenPath;
/** A request as it crosses postMessage: a payload plus its correlation id.
 *  Intersection distributes over the union, so every member keeps its own keys. */
export type LsRequest = LsMessage & { id: number };
export type LsReply =
  | { kind: "reply"; id: number; ok: true; value: unknown }
  | { kind: "reply"; id: number; ok: false; error: string };

/** The port shape both sides need — Worker, SharedWorker.port, and
 *  MessageChannel ports all satisfy it structurally. */
export interface LsPort {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** The service's async twin: same methods, promise-returning — structurally a
 *  `SchemeIdeBackend` for the CodeMirror extensions. Plus the transport-level
 *  `setProjectFiles`: `(require …)` resolution can't ship a callback over
 *  postMessage, so the host pushes a files snapshot instead (re-push whenever
 *  the project changes; replace-wholesale). */
export type AsyncSchemeLanguageService = {
  [M in keyof SchemeLanguageService]: (
    ...args: Parameters<SchemeLanguageService[M]>
  ) => Promise<Awaited<ReturnType<SchemeLanguageService[M]>>>;
} & {
  setProjectFiles(files: Record<string, string>): Promise<void>;
  /** The require-TYPE twin of `setProjectFiles`: a precomputed `{ path → TS type
   *  string }` map (synthesized host-side from the runtime loader registry via
   *  `resolveRequireType`). Like the resolver, a `resolveRequireType` callback
   *  can't cross postMessage, so the host pushes the resolved snapshot instead —
   *  re-push on project change, replace-wholesale. */
  setRequireTypes(types: Record<string, string>): Promise<void>;
  /** Project-relative path of the open buffer (relative require resolution). */
  setOpenPath(path: string | null): Promise<void>;
};

export const LS_METHODS = [
  "getSemanticDiagnostics",
  "getQuickInfoAtPosition",
  "getCompletionsAtPosition",
  "getCompletionContext",
  "getDefinitionAtPosition",
  "getSemanticClassifications",
  "getTypeValidCandidates",
  "getSlotIsArray",
  "getSlotAcceptsBareWord",
  "getSlotElementType",
  "getHeadReturnsArray",
  "getSlotIsStringTyped",
  "getTypelevelProgram",
  "getTypelevelModules",
] as const;

/** Connect to a served port. Resolves once the server acknowledges the init —
 *  i.e. the worker module actually loaded and built a service — or rejects on
 *  `timeoutMs` (a worker that failed to load never replies; a fallback ladder
 *  needs a bounded wait, not a hang). */
export function connectSchemeLs(
  port: LsPort,
  options: SchemeLsWorkerOptions,
  timeoutMs = 15_000,
): Promise<AsyncSchemeLanguageService> {
  return new Promise((resolve, reject) => {
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    port.onmessage = (ev) => {
      const msg = ev.data as LsReply;
      const entry = pending.get(msg.id);
      if (entry === undefined) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(new Error(msg.error));
    };
    // The wire reply is genuinely `unknown`, so the promise resolves `unknown`
    // (its resolver drops straight into the `pending` slot, no variance cast) and
    // the ONE honest assertion — "the caller knows the reply shape this method
    // yields" — lives here, at the boundary, rather than repeated at each call site.
    const call = <R = unknown>(message: LsMessage): Promise<R> =>
      new Promise<unknown>((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        port.postMessage({ ...message, id } satisfies LsRequest);
      }) as Promise<R>;

    // One typed RPC binder. The single remaining cast is unavoidable: TS cannot
    // verify a freshly-built arrow against an indexed-by-generic type
    // (`AsyncSchemeLanguageService[M]` collapses to an intersection of every
    // member), so the binding is asserted once, here. `method: M` keeps the name
    // honest (a typo is a compile error), and the `client` annotation below forces
    // every method present and correctly named — no blanket `as` over a spread.
    const rpc = <M extends keyof SchemeLanguageService>(method: M): AsyncSchemeLanguageService[M] =>
      ((...args: unknown[]) => call({ kind: "call", method, args })) as AsyncSchemeLanguageService[M];

    const timer = setTimeout(() => reject(new Error("scheme-ls: worker init timed out")), timeoutMs);
    void (async () => {
      try {
        await call({ kind: "init", options });
        clearTimeout(timer);
        resolve({
          getSemanticDiagnostics: rpc("getSemanticDiagnostics"),
          getQuickInfoAtPosition: rpc("getQuickInfoAtPosition"),
          getCompletionsAtPosition: rpc("getCompletionsAtPosition"),
          getCompletionContext: rpc("getCompletionContext"),
          getDefinitionAtPosition: rpc("getDefinitionAtPosition"),
          getSemanticClassifications: rpc("getSemanticClassifications"),
          getTypeValidCandidates: rpc("getTypeValidCandidates"),
          getSlotIsArray: rpc("getSlotIsArray"),
          getSlotAcceptsBareWord: rpc("getSlotAcceptsBareWord"),
          getSlotElementType: rpc("getSlotElementType"),
          getHeadReturnsArray: rpc("getHeadReturnsArray"),
          getSlotIsStringTyped: rpc("getSlotIsStringTyped"),
          getTypelevelProgram: rpc("getTypelevelProgram"),
          getTypelevelModules: rpc("getTypelevelModules"),
          setProjectFiles: (files: Record<string, string>) => call<void>({ kind: "files", files }),
          setRequireTypes: (types: Record<string, string>) => call<void>({ kind: "requireTypes", types }),
          setOpenPath: (path: string | null) => call<void>({ kind: "openPath", path }),
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}
