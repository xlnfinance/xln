/**
 * Surviving phase products of `exec` as first-class values. Path-agnostic
 * pieces the vocabulary path (generator-exec.ts) composes:
 *
 *   (1) parse             → {@link ParsedProgram}
 *   (2.5, optional)       → {@link validateAgainstResolution} (pure function
 *                           over the parsed program + a sealed
 *                           CompiledResolutionChain)
 */

import type { CompiledResolutionChain } from "./CompiledResolutionChain.js";
import type { DegradedCapability } from "../common/degradation.js";
import { validateProgram, type Diagnostic } from "../static-validation/validate-program.js";
import { vocabularyFromChain } from "../static-validation/vocabulary.js";
import type { SchemeValue } from "../values/types.js";
import { parse as readerParse } from "../reader/parse.js";
import type { LexicalScope } from "./LexicalScope.js";

// ── Phase 1 — ParsedProgram ─────────────────────────────────────────────────

/** Phase 1 — pure reader output + late-stamped analysis slots. */
export interface ParsedProgram {
  /** Location-bearing top-level forms (APair LOCATION spans survive). */
  readonly forms: readonly SchemeValue[];
  readonly source?: string;
  /** Which READER mode produced it — identity fact of the program, stamped at
   *  parse. (RUN-time strict mode stays ExecOptions.strict → runCtx.) */
  readonly strict: boolean;
  /** Stamped by a validate pass (phase 2.5), not by parse — validation needs
   *  the sealed chain's vocabulary. Optional + append-only. */
  readonly diagnostics?: readonly Diagnostic[];
  /** RESERVED for provenance track's program-identity work. */
  readonly programHash?: string;
}

/** Phase 1, callable: parse `code` into a ParsedProgram. A pre-parsed
 *  SchemeValue wraps as a one-form program. `source` stamps every produced
 *  location, as with `parse`. */
export async function parseProgram(
  code: string | SchemeValue,
  opts: { strict?: boolean; source?: string } = {},
): Promise<ParsedProgram> {
  const strict = opts.strict ?? false;
  if (typeof code !== "string") return { forms: [code], strict };
  const forms = await readerParse(code, opts.source, strict);
  return { forms, source: code, strict };
}

// ── Phase 2.5 — pure pass over (program, sealed chain) ──────────────────────

/** Static validation's work over a sealed CompiledResolutionChain + degraded
 *  list. generator-exec.ts's execState (chain sealed from Vocabulary.map via
 *  sealedVocabularyChain) delegates here. */
export function validateAgainstResolution(
  program: ParsedProgram,
  chain: CompiledResolutionChain,
  degraded: readonly DegradedCapability[],
  scope?: LexicalScope,
): readonly Diagnostic[] {
  const scopeEnv = scope?.env;
  const vocabulary = vocabularyFromChain(chain, {
    scopeNames: scopeEnv?.allBoundNames(),
    scopeLookup: scopeEnv === undefined ? undefined : (name) => scopeEnv.get(name, { throwError: false }),
    degraded,
  });
  return validateProgram(program.forms, vocabulary);
}
