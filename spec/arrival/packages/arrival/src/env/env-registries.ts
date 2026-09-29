// env-registries — side-table ABOUT rosettas registered on an env, kept OUT of the
// scope-node (`AmbientRuntime`): not lexical scope (bindings + parent + lookup), but
// run-scoped metadata external tools harvest. Env-keyed preserves per-env locality.
//
// WHY env-KEYED (WeakMap<AmbientRuntime, …>), not one flat global:
//   • rosetta-types are read PER-ENV — a sibling env's entries must not leak in
//   • WeakMap ⇒ entry GCs with its env — no lifetime coupling
//
// Accessor gets-or-creates the per-env container; empty map from a read is inert and
// GC-eligible.
//
// Holds ONLY TS-signature strings for the type-lens harvest. Currently never
// populated — no live writer fills the map; every env's map reads empty.
// `rosettaTypesOf` remains the harvest surface.

import type { AmbientRuntime } from "./AmbientRuntime.js";

const rosettaTypesByEnv = new WeakMap<AmbientRuntime, Map<string, string>>();

/** This env's rosetta TS-signature registry — single source for type-lens harvest
 *  (`[...rosettaTypesOf(env)]`). Per-env, not chained. */
export function rosettaTypesOf(env: AmbientRuntime): Map<string, string> {
  let m = rosettaTypesByEnv.get(env);
  if (m === undefined) {
    m = new Map();
    rosettaTypesByEnv.set(env, m);
  }
  return m;
}
