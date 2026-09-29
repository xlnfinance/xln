// run-scoped-resources.test.ts — 1d (docs/execution.md §HERMETIC): capability resources keyed by
// RunContext in the run's own `capabilityResources` store, produced on first dispatch of a
// resource-bearing verb via the capability's `["arrival/get-resources"]`, spawned lazily per cell
// on `.get()`, reused across REPL passes that SHARE a RunContext, disposed exactly once at that
// RunContext's end — never per-exec-pass, never ambient-wide. Covers BOTH resource shapes:
//
//   • the CONSTRUCTOR path — `new EnvCapability(name, { resources: {...} })`, a baked verb reading
//     `this.resources.<key>.get()` (a per-run `ResourceCell` record; lazy per-cell acquire).
//   • the DEFINE path — `EnvCapability.define(name, { resources: (config) => Resources })`, a baked
//     verb reading `this.resources` as the WHOLE authored bag (synchronous — the factory is sync).
//
// `.live` (sync spawned handle) is NOT a baked-path read anymore: the eager pre-spawn gate that
// backed it is retired, so baked impls acquire via async `.get()`. `.live` survives on the historical
// `{ fn }` / describe-time channel (`activation.resources` + `ensureSpawned`), covered elsewhere.
//
// `capability.test.ts` / `callctx-activation-dispatch.test.ts` / `capability-define-symbols
// .test.ts` cover the AUTHORING/inference surface; this file is the resource-lifecycle proof.
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../capability.js";
import { symbol } from "../../symbol/index.js";
import * as sz from "../scheme-zod/index.js";
import { port, type Resource } from "../resources.js";
import { execOverFrame } from "../../eval/generator-exec.js";
import { applyCapability, freshEnv } from "../../__tests__/_fresh-env.js";
import { RunContext } from "../../run/RunContext.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";
import type { CallCtx } from "../../run/CallCtx.js";

describe("Stage 2 — per-RunContext capability resources", () => {
  describe("constructor path (`new EnvCapability`)", () => {
    function spyCapability() {
      const counts = { acquired: 0, disposed: 0 };
      const resource: Resource<{ tag: string }> = {
        kind: "test/run-scoped-spy",
        async acquire() {
          counts.acquired += 1;
          return port({ tag: "live" }, () => {
            counts.disposed += 1;
          });
        },
      };
      const capability = new EnvCapability("test/run-scoped-ctor", {
        resources: { port: resource },
        symbols: {
          "spy/touch": symbol.rosetta`spy/touch: read the spy port's tag`(
            { input: [], output: [sz.string] },
            // 1d: baked verbs read run resources via async `.get()` (lazy per-cell spawn) — the
            // pre-spawn gate that made a sync `.live` read possible is gone. `.live` survives only
            // on the forbidden `{ fn }` / describe-time channel (`activation.resources`), not here.
            async function (this: CallCtx): Promise<string> {
              const res = this.resources as { port: { get(): Promise<{ tag: string }> } } | undefined;
              if (res === undefined) return "NO-RESOURCE";
              return (await res.port.get()).tag;
            },
          ),
        },
      });
      return { capability, counts };
    }

    it("(a) a resource with an observable [Symbol.asyncDispose] is disposed exactly once at run-end", async () => {
      const { capability, counts } = spyCapability();
      const env = await freshEnv();
      await applyCapability(env, [capability]);
      const runCtx = new RunContext({});

      const [out] = await execOverFrame("(spy/touch)", { env, runCtx });
      expect(out).toBe("live");
      expect(counts.acquired).toBe(1);
      expect(counts.disposed).toBe(0); // still live — the RunContext hasn't ended yet

      await disposeRunContext(runCtx);
      expect(counts.disposed).toBe(1);

      await disposeRunContext(runCtx); // idempotent — a second call never double-disposes
      expect(counts.disposed).toBe(1);
    });

    it("(b) spawned once and REUSED across passes sharing one RunContext; FRESH across different RunContexts", async () => {
      const { capability, counts } = spyCapability();
      const env = await freshEnv();
      await applyCapability(env, [capability]);

      const sessionRunCtx = new RunContext({});
      await execOverFrame("(spy/touch)", { env, runCtx: sessionRunCtx }); // pass 1
      await execOverFrame("(spy/touch)", { env, runCtx: sessionRunCtx }); // pass 2 — REPL continuity
      expect(counts.acquired).toBe(1);

      const otherRunCtx = new RunContext({});
      await execOverFrame("(spy/touch)", { env, runCtx: otherRunCtx });
      expect(counts.acquired).toBe(2);

      await disposeRunContext(sessionRunCtx);
      await disposeRunContext(otherRunCtx);
      expect(counts.disposed).toBe(2);
    });

    it("(c) a resource-less capability's verb never touches any resource gate", async () => {
      const capability = new EnvCapability("test/run-scoped-none", {
        symbols: {
          "plain/touch": symbol.rosetta`plain/touch: no resources declared — the ungated fast path`(
            { input: [], output: [sz.string] },
            function (this: CallCtx): string {
              const res = this.resources as Record<string, unknown> | undefined;
              // No `resources` declared ⇒ the fast (ungated) path: whatever `this.resources` is,
              // it carries no keys — never a per-RunContext bag this capability never asked for.
              return `plain:${Object.keys(res ?? {}).length}`;
            },
          ),
        },
      });
      const env = await freshEnv();
      await applyCapability(env, [capability]);

      const [out] = await execOverFrame("(plain/touch)", { env });
      expect(out).toBe("plain:0");
    });
  });

  describe("define path (`EnvCapability.define`)", () => {
    interface Cache {
      readonly get: (k: string) => string | undefined;
      readonly set: (k: string, v: string) => void;
      [Symbol.asyncDispose]?: () => Promise<void>;
    }

    function spyDefined() {
      const counts = { spawned: 0, disposed: 0 };
      const capability = EnvCapability.define("test/run-scoped-define", {
        resources: (): Cache => {
          counts.spawned += 1;
          const store = new Map<string, string>();
          return {
            get: (k) => store.get(k),
            set: (k, v) => void store.set(k, v),
            [Symbol.asyncDispose]: async () => {
              counts.disposed += 1;
            },
          };
        },
        symbols: (symbol, sz) => ({
          "cache/put": symbol.rosetta`cache/put: write a key into this run's cache`(
            { input: [sz.string, sz.string], output: [sz.string] },
            function (key: string, value: string) {
              this.resources.set(key, value);
              return value;
            },
          ),
          "cache/get": symbol.rosetta`cache/get: read a key back — MISS if never written under this run`(
            { input: [sz.string], output: [sz.string] },
            function (key: string) {
              return this.resources.get(key) ?? "MISS";
            },
          ),
        }),
      });
      return { capability, counts };
    }

    it("(a) the produced bag's [Symbol.asyncDispose] fires exactly once at RunContext end", async () => {
      const { capability, counts } = spyDefined();
      const env = await freshEnv();
      await applyCapability(env, [capability]);
      const runCtx = new RunContext({});

      const [out] = await execOverFrame('(cache/put "k" "v")', { env, runCtx });
      expect(out).toBe("v");
      expect(counts.spawned).toBe(1);
      expect(counts.disposed).toBe(0);

      await disposeRunContext(runCtx);
      expect(counts.disposed).toBe(1);
      await disposeRunContext(runCtx);
      expect(counts.disposed).toBe(1);
    });

    it("(b) the cache PERSISTS across passes sharing a RunContext; a different RunContext starts EMPTY", async () => {
      const { capability, counts } = spyDefined();
      const env = await freshEnv();
      await applyCapability(env, [capability]);

      const sessionRunCtx = new RunContext({});
      await execOverFrame('(cache/put "k1" "v1")', { env, runCtx: sessionRunCtx }); // pass 1: write
      const [stillThere] = await execOverFrame('(cache/get "k1")', { env, runCtx: sessionRunCtx }); // pass 2: read, no write
      expect(stillThere).toBe("v1");
      expect(counts.spawned).toBe(1);

      const otherRunCtx = new RunContext({});
      const [fresh] = await execOverFrame('(cache/get "k1")', { env, runCtx: otherRunCtx });
      expect(fresh).toBe("MISS");
      expect(counts.spawned).toBe(2);

      await disposeRunContext(sessionRunCtx);
      await disposeRunContext(otherRunCtx);
    });
  });
});
