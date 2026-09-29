/**
 * Shared TEST-ONLY helpers for the static-lineage / provenance suites
 * (golden-prov-*, lineage-*, coercion-soundness).
 *
 * `provOf` is production — exported from `../provenance/lineage`. This file
 * holds only the test-fixture helpers: stamped-value constructors (`sStr`/`sNum`)
 * and the run-a-program-collect-provenance drivers (`runRaw`/`run`).
 *
 * `runRaw` forces the eager provenance oracle ON for the run and save/restores
 * the ambient value so nested or interleaved use is safe.
 */
import * as z from "../common/scheme-zod/index.js";
import type { EnvWithInternals, ResolvingAmbient, AmbientRuntime } from "../env/AmbientRuntime.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { execStateOverFrame } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import type { AString } from "../values/primitives/AString.js";
import type { AValue } from "../values/primitives/AValue.js";
import { jsToScheme } from "../membrane/rosetta.js";
import { provOf } from "../provenance/lineage.js";
import { isEagerProvenanceOracleEnabled, setEagerProvenanceOracleEnabled } from "../values/op-helpers.js";
import type { SchemeValue } from "../values/types.js";

/** Stamp a single source-id onto a string input (the per-element id carrier). Codec
 *  encode + withProvenance, not a direct AString construction. */
export const sStr = (s: string, p: number): AString => z.string.encode(s).withProvenance(new Set([p]));

/** Stamp a single source-id onto a number input (the scalar arithmetic carrier). Codec
 *  encode canonicalizes to AInexact — matches fromJs's old default for a bare JS number. */
export const sNum = (n: number, p: number): AValue => z.number.encode(n).withProvenance(new Set([p]));

/** A per-env setup applied before the bindings are written — e.g. wiring a test-local
 *  `EnvCapability` (`symbol.rosetta` verbs) via `cap.lower({}).apply(env, undefined as
 *  never)`, which is async, hence the `Promise<void>` arm (widened from the historical
 *  older sync-only registration shape). */
export type EnvSetup = (env: AmbientRuntime) => void | Promise<void>;

let seq = 0;

/**
 * Run `src` in a fresh inherited sandbox env and return the RAW (still-boxed) result
 * value. Each call gets a uniquely-named child env; `binds` are boxed through
 * `jsToScheme` (the same membrane `env.set` applies internally; already-boxed AValue
 * inputs short-circuit to identity) and written with `env.set`. `setup` (if given) runs
 * against the env first — used to register rosetta sources.
 *
 * COMPLEX tier (`execState`, not `exec`) — this whole file exists to read
 * provenance/box discipline off the result (`provOf`, `deepIds`, `collapseProvenance`),
 * a boxed-state concern (RULINGS.md R1), not the SIMPLE tier's plain-JS exit.
 *
 * Q20b: production default is OFF; every caller of this helper is an eager-oracle
 * GOLDEN (golden-prov-*, lineage-*, conservation.law.test.ts) that needs REAL
 * accumulation to freeze anything meaningful. Forces the oracle ON for exactly this
 * run's extent, save/restoring the ambient value (not a hardcoded default) so nested
 * or interleaved use is safe.
 */
export async function runRaw(
  src: string,
  binds: Record<string, unknown> = {},
  setup?: EnvSetup,
): Promise<SchemeValue | undefined> {
  const env = inferenceEnv.child(`lin-test-${seq++}`) as EnvWithInternals<ResolvingAmbient>;
  await setup?.(env);
  for (const [k, v] of Object.entries(binds)) env.bind(k, jsToScheme(CONSTANT_CTX, v));
  const savedOracle = isEagerProvenanceOracleEnabled();
  setEagerProvenanceOracleEnabled(true);
  try {
    const [r] = (await execStateOverFrame(src, { env })).values;
    return r;
  } finally {
    setEagerProvenanceOracleEnabled(savedOracle);
  }
}

export const run = async (src: string, binds: Record<string, unknown> = {}, setup?: EnvSetup): Promise<number[]> =>
  provOf(await runRaw(src, binds, setup));
