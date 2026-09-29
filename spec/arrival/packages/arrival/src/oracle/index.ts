// oracle — local assembly point for the constraint-kernel oracle.
//
// Face of the constraint-kernel oracle (static plane: docs/static-plane.md §THE FOUR
// READERS 4.2). Assembles the Layer-S structural reader (scanner.ts) behind the contract
// interfaces (contract.ts). Package consumers take `scan`/`ScanResult`/`makeOracle` +
// contract types from `/lsp-internals` (`src/lsp-internals/index.ts`); this file remains
// the module-local assembly.
//
// Σ and T attach behind the same surface; without an env the scanner degrades them
// gracefully per the contract (validSymbols/expectedType → null, produces → true).

import { structuralScanner, makeSigmaScanner } from "./scanner.js";
import { makeOracleEnv } from "./env.js";
import type { OracleScanner } from "./contract.js";
import type { OracleEnvΣ } from "./sigma.js";
import type { AmbientRuntime } from "../env/AmbientRuntime.js";

/**
 * The assembled oracle. Given an `env` (a live {@link AmbientRuntime} or pre-built
 * {@link OracleEnvΣ}) it is Σ-LIVE: `validSymbols()` returns the position-filtered bound
 * set. Given nothing, it's the Layer-S structural scanner — Σ/T degrade to null/true per
 * the contract. T lands behind the same surface as `makeOracle()` with no argument.
 */
export function makeOracle(env?: AmbientRuntime | OracleEnvΣ): OracleScanner {
  if (!env) return structuralScanner;
  const oracleEnv: OracleEnvΣ = isOracleEnv(env) ? env : makeOracleEnv(env);
  return makeSigmaScanner(oracleEnv);
}

/** Discriminate a pre-built {@link OracleEnvΣ} from a raw {@link AmbientRuntime} (which has no
 *  `boundSymbols`/`isCallable` methods). */
function isOracleEnv(env: AmbientRuntime | OracleEnvΣ): env is OracleEnvΣ {
  return typeof (env as OracleEnvΣ).boundSymbols === "function" && typeof (env as OracleEnvΣ).isCallable === "function";
}
