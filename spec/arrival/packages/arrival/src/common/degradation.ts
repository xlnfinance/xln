// degradation.ts — door-set degradation: IMPLEMENTATION and domain types. Model (absent
// OPTIONAL enabling config narrows a capability's affected symbols to a cause-carrying DOOR-SET
// instead of silent withholding) is docs/environments.md §DEGRADATION. Auto-door mint is
// unconditional — there is no `"forbid"` vs `"doors"` mode switch.
//
// Two failure classes are DELIBERATELY untouched — present-but-invalid config (schema.parse's
// own job, unconditional) and pack apply errors (a defect, never a door) STAY throw paths.
//
// The degradable-set check is STRUCTURAL (`instanceof z.ZodOptional | z.ZodDefault`) — NOT
// zod's own `.isOptional()`, which a schema built from `z.custom()` with no predicate answers
// `true` for regardless of whether `.optional()` was ever called (zod no-op-validator quirk:
// `z.object({ infer: z.custom<T>() }).parse({})` succeeds). The structural check keeps a
// genuinely-required-but-permissive key OUT of the degradable set — required config always
// stays fail-closed.
//
// Vocabulary-facing surface: `DegradedCapability`/`DegradedNeed` are the shape
// `env/vocabulary.ts` folds (structurally, uninterpreted) into `Vocabulary.degraded` —
// defined HERE so env-agnostic layers stay decoupled from the vocabulary build.
//
// DEPARTURE D2 (`Contract.requiresConfig` in `./symbols/_bake.js`): "required config always
// stays fail-closed" is about a key with NO `.optional()`/`.default()` wrapper — that stays a
// `schema.parse` throw. D2 is the ADDITIONAL, per-VERB case: a key a capability author wraps
// `.optional()` (so `schema.parse` succeeds absent) but names in some verb's `requiresConfig`
// — the bind loop reads `requiresConfig` UNCONDITIONALLY and
// auto-mints the SAME `DoorCause` shape via `DegradationInfo.door` below. The two views agree
// by construction: a `requiresConfig`-named key is, by D2's authoring rule, always
// `.optional()`/`.default()`-wrapped, so it is exactly the set `missingOptionalKeys` already
// reports — this module needs no new optionality check, only an unconditional CALLER of
// `.door()`.

import { z } from "zod";
import type { DoorCause, DoorSymbolDef } from "./symbols/_bake.js";

/** One missing input a degraded door needs to become callable — the `configuration` kind is
 *  the shipped case (`DoorCause["needs"]`'s element shape, from `_bake.ts`); `dependency`/
 *  `resource` kinds stay deferred pending an unrooted-capability policy. */
export type DegradedNeed = DoorCause["needs"][number];

/** A capability-level entry on `Vocabulary.degraded` — an enumerable list a host/discovery
 *  reader inspects instead of inferring degradation from a throw or by probing symbols one
 *  by one. */
export interface DegradedCapability {
  readonly capability: string;
  readonly needs: readonly DegradedNeed[];
}

/** Declared-optional (`z.ZodOptional`/`z.ZodDefault` wrapper) keys of `shape` absent from
 *  `provided` (missing, or explicitly `undefined`). A key without one of those wrappers is
 *  NEVER reported here regardless of what its underlying validator accepts — see the file
 *  header's `z.custom()` note. `shape` is `CapabilitySpec.configuration` itself (the
 *  pre-`z.object()` `{key: ZodType}` record); `provided` is the raw config bag, un-parsed
 *  (parsing may reject for a DIFFERENT reason — present-but-invalid — orthogonal to this scan). */
export function missingOptionalKeys(
  shape: Record<string, z.ZodTypeAny> | undefined,
  provided: Record<string, unknown> | undefined,
): string[] {
  if (shape === undefined) return [];
  const bag = provided ?? {};
  const missing: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    if (bag[key] !== undefined) continue; // present — satisfied, regardless of optionality
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) missing.push(key);
  }
  return missing;
}

/** The degradation view every `Activation` carries — a thin, owner-scoped `.door(...)`
 *  minter. Its ONE in-repo caller is the `requiresConfig` auto-door in the bind loop
 *  (a verb's config gate is declared as `Contract.requiresConfig`). */
export interface DegradationInfo {
  /** Mint a `DoorSymbolDef` causally attributing `name` to THIS capability + `needs` (the
   *  causal chain end-to-end: reference → door → owner → missing key). Called by the
   *  `requiresConfig` auto-door; a pure value constructor, defined unconditionally. */
  door(name: string, needs: readonly string[], reason: string): DoorSymbolDef;
}

/** Build the `DegradationInfo` a capability's `Activation` carries — `owner` is the
 *  capability's own name (the `DoorCause.owner` every minted door stamps). */
export function buildDegradationInfo(owner: string): DegradationInfo {
  return {
    door: (name, needs, reason) => ({
      kind: "door",
      name,
      reason,
      cause: { owner, needs: needs.map((key) => ({ kind: "configuration" as const, key })) },
    }),
  };
}

/** Scan a capability's own (already-computed) `symbolsRec` for degradation-minted doors —
 *  entries whose `cause.owner === capabilityName` and `cause.needs` is non-empty (a
 *  `notImplemented`-authored door with no cause, or one whose cause belongs to a DIFFERENT
 *  owner — a dep's door surfacing through re-export — is not THIS capability's degradation).
 *  Dedupes needs by `key` (a capability may mint several doors sharing the same missing key,
 *  e.g. `require`/`require/extension` both citing `fs`). Returns `undefined` when nothing
 *  degraded rather than an empty array, so `Vocabulary.degraded` never carries a needs-less
 *  entry. */
export function collectDegraded(
  capabilityName: string,
  symbolsRec: Record<string, DoorSymbolDef | unknown>,
): DegradedCapability | undefined {
  const seen = new Set<string>();
  const needs: DegradedNeed[] = [];
  for (const def of Object.values(symbolsRec)) {
    if (typeof def !== "object" || def === null || !("kind" in def) || (def as { kind: unknown }).kind !== "door")
      continue;
    const cause = (def as DoorSymbolDef).cause;
    if (cause?.owner !== capabilityName || cause.needs.length === 0) continue;
    for (const need of cause.needs) {
      const dedupeKey = `${need.kind}:${need.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      needs.push(need);
    }
  }
  return needs.length === 0 ? undefined : { capability: capabilityName, needs };
}
