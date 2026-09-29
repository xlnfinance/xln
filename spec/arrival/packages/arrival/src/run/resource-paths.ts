/**
 * resource-paths — named domain lanes for temporal zoning of domain immutability.
 *
 * A resource path is a segment tuple (e.g. `["db","projects",id]`). Overlap is
 * segment-wise prefix either direction — not string-join.
 *
 * Temporal immutability (product law): a new query genesis is illegal only when
 * an effect intervenes *between* two overlapping queries on a shared domain
 * (Q → E → Q door). Bare E→Q is legal. The run log is an ordered event journal
 * of Q and E batches; door scan is intervening-E (see `findInterveningDoor`).
 * Holding prior query results is fine; outer-world sync is not promised.
 *
 * Design: docs/working-proposals/cqs-reactivity/
 * Suite:  docs/working-proposals/cqs-reactivity/test-suite-design/SUITE.md
 * Law:    docs/working-proposals/cqs-reactivity/test-suite-design/law-identity/
 *
 * THIS MODULE is the resourcePaths CHANNEL — run log + door error + CQS apply.
 * The channel-neutral pure algebra (`ResourcePath`, `pathsOverlap`,
 * `serializeResourcePath`, …) lives in `./path-algebra.js`. Path producers live
 * on CrossingContract (rosetta only); the chokepoint is the membrane apply.
 *
 * Channel model: unlike cache/effects/reads (opt-in undefined), ordinary
 * RunContext mints always carry a fresh MemoryResourcePathLog so CQS is on by
 * default for live runs; CONSTANT_CTX leaves the facility off.
 *
 * Segment types: prefer type-level (`ResourcePath = readonly string[]`). Runtime
 * non-string segment checks are opt-in via `strictCQSstrings` (default false).
 * Top-level producer return shape (must be an array of paths) is always checked.
 *
 * Door: intervening-E via `findInterveningDoor`; record hybrid Q≺E after pass
 * (REWORK-PLAN). Classic priorE∩thisQ alone is not the product door.
 */

import { ArrivalError, type ErrorClass } from "../errors.js";
import { pathsOverlap, serializeResourcePath, type ResourcePath } from "./path-algebra.js";

/**
 * One journal entry on a resource-path log. Total order across Q and E is
 * what intervening-door needs; flat effectPaths is derived for compat.
 */
export type ResourcePathEvent =
  | { readonly kind: "Q"; readonly paths: readonly ResourcePath[] }
  | { readonly kind: "E"; readonly paths: readonly ResourcePath[] };

/**
 * Decoded-arg path producer (contract field). Invoked after decode, before impl.
 * Return type pins string segments at the type level; authors name decoded slots
 * with concrete param types. Sole home.
 */

export type ResourcePathFn = (...decodedArgs: any[]) => readonly ResourcePath[];

/**
 * Intervening-door witness: prior Q_a, then later prior E that operationally
 * touches thisQ (pathsOverlap(E, thisQ)), both before the current query.
 */
export type InterveningDoorWitness = {
  readonly priorQuery?: ResourcePath;
  readonly priorEffect: ResourcePath;
  readonly thisQuery: ResourcePath;
};

/**
 * Temporal immutability door algebra (REWORK-PLAN).
 *
 * Door iff ∃ thisQ ∈ thisQPaths, ∃ prior Q_a overlapping thisQ, and ∃ prior E
 * after that Q_a with pathsOverlap(E, thisQ). Operational E-touch is E∩thisQ
 * only (formal E∩Q_a ∨ E∩thisQ deferred).
 *
 * Chronological scan of prior events only — does not record.
 */
export function findInterveningDoor(
  log: Pick<ResourcePathLog, "events">,
  thisQPaths: readonly ResourcePath[],
): InterveningDoorWitness | undefined {
  const events = log.events;
  for (const thisQ of thisQPaths) {
    let seenOverlappingPriorQ = false;
    let priorQuery: ResourcePath | undefined;
    for (const event of events) {
      if (event.kind === "Q") {
        for (const p of event.paths) {
          if (pathsOverlap(p, thisQ)) {
            seenOverlappingPriorQ = true;
            priorQuery = p;
            break;
          }
        }
      } else if (event.kind === "E" && seenOverlappingPriorQ) {
        for (const priorEffect of event.paths) {
          if (pathsOverlap(priorEffect, thisQ)) {
            return { priorQuery, priorEffect, thisQuery: thisQ };
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Per-run ordered Q/E journal. Record only AFTER check passes (R-O2 / R-HYBRID-ORDER).
 * `effectPaths` is the flat E-path view (compat); `events` is the total order.
 */
export interface ResourcePathLog {
  /**
   * Ordered journal of query and effect batches this run (live view — do not mutate).
   */
  readonly events: readonly ResourcePathEvent[];
  /**
   * Prior effect paths this run (flat, chronological — derived from E events;
   * same honesty as MemoryEffectLog.entries; do not mutate).
   */
  readonly effectPaths: readonly ResourcePath[];
  /** Append effect paths that passed the CQS check (pre-impl). Empty paths ignored. */
  recordEffects(paths: readonly ResourcePath[]): void;
  /** Append query paths that passed the CQS check (pre-impl). Empty paths ignored. */
  recordQueries(paths: readonly ResourcePath[]): void;
}

/**
 * Default in-memory log — one instance per run. Copies path arrays on record.
 * No dedup: repeated writes grow O(events); check is O(|log|×|Q|×depth).
 */
export class MemoryResourcePathLog implements ResourcePathLog {
  private readonly _events: ResourcePathEvent[] = [];
  private readonly _effects: ResourcePath[] = [];

  get events(): readonly ResourcePathEvent[] {
    return this._events;
  }

  get effectPaths(): readonly ResourcePath[] {
    return this._effects;
  }

  recordQueries(paths: readonly ResourcePath[]): void {
    const frozen = freezeNonEmptyPaths(paths);
    if (frozen.length === 0) return;
    this._events.push(Object.freeze({ kind: "Q" as const, paths: frozen }));
  }

  recordEffects(paths: readonly ResourcePath[]): void {
    const frozen = freezeNonEmptyPaths(paths);
    if (frozen.length === 0) return;
    this._events.push(Object.freeze({ kind: "E" as const, paths: frozen }));
    for (const path of frozen) {
      this._effects.push(path);
    }
  }
}

function freezeNonEmptyPaths(paths: readonly ResourcePath[]): readonly ResourcePath[] {
  const out: ResourcePath[] = [];
  for (const path of paths) {
    if (path.length > 0) out.push(Object.freeze([...path]));
  }
  return out.length === 0 ? out : Object.freeze(out);
}

/**
 * Door: intervening effect between overlapping prior query and this query
 * (temporal immutability / inter-query coherence). Thrown before impl; doored
 * impl must not run. Category remains domain-immutability.
 */
export class ResourcePathConflictError extends ArrivalError {
  public readonly name = "ResourcePathConflictError";
  readonly "arrival/error-category": ErrorClass = "domain-immutability";

  constructor(
    /** Offending symbol (the query penetration). */
    public readonly verbName: string,
    /** One prior effect path that operationally touches thisQuery after a prior Q. */
    public readonly priorEffect: ResourcePath,
    /** One query path from this penetration that overlaps. */
    public readonly thisQuery: ResourcePath,
    /** Optional prior query path that established the domain (intervening-door witness). */
    public readonly priorQuery?: ResourcePath,
    /** True when the doored penetration itself also declares effects (hybrid verb). */
    public readonly hybrid: boolean = false,
  ) {
    // eslint-disable-next-line unicorn/no-negated-condition -- mention the prior query only when one exists
    const priorQPart = priorQuery !== undefined ? ` after prior query ${serializeResourcePath(priorQuery)}` : "";
    // A hybrid's Q≺E record makes any repeat on the same domain self-door — the
    // generic "hold prior results" advice misreads an upsert's intent, so teach
    // the hybrid rule explicitly (N-HYBRID-TWICE).
    const advice = hybrid
      ? `this verb also declares effects (hybrid) and a hybrid touches its domain once per run — ` +
        `reuse the first call's return, or defer the repeat to the next run`
      : `hold prior results instead of re-querying`;
    super(
      `${verbName}: intervening effect path ${serializeResourcePath(priorEffect)} between queries ` +
        `on ${serializeResourcePath(thisQuery)}${priorQPart} in this run — a new query genesis ` +
        `on a domain after an intervening effect is illegal ` +
        `(temporal immutability / inter-query coherence; ${advice})`,
    );
  }
}

/** Bake-time: path producers only on rosetta. */
export class ResourcePathDeclarationError extends ArrivalError {
  public readonly name = "ResourcePathDeclarationError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    public readonly op: string,
    public readonly kind: string,
  ) {
    super(
      `${op}: queries?/effects? path producers are rosetta-only — ${kind} cannot declare resource paths ` +
        `(domain lanes are a membrane crossing concern)`,
    );
  }
}

/**
 * Runtime bake door for contour factories (native / sequence / define).
 * Type-level excess-property checks refuse path producers on ContourContract;
 * this catches untyped / `as any` authors.
 */
export function assertNoResourcePathProducers(
  name: string,
  kind: string,
  contract: { queries?: unknown; effects?: unknown },
): void {
  if (contract.queries !== undefined || contract.effects !== undefined) {
    throw new ResourcePathDeclarationError(name, kind);
  }
}

/**
 * Bake-time: a queries-declaring contract must be serializable on BOTH vectors
 * (ruling 2026-08-13). `queries: (...args) => StringTuple[]` exists precisely to
 * force resource naming into serializable, accessible form — an external resource
 * is pointed at by id / well-known name. An unkeyable slot (z.dynamic / z.lambda /
 * z.schemeValue) is not a resource pointer. Mirror of the view-shape gate (if the
 * verb also declares `cacheClass: "view"`, the same slots are the cache key).
 */
export class ResourcePathShapeError extends ArrivalError {
  public readonly name = "ResourcePathShapeError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    public readonly op: string,
    public readonly side: "input" | "output",
    public readonly slotName: string,
  ) {
    super(
      `${op}: a queries-declaring contract must serialize on both vectors, but its ${side} vector ` +
        `carries a z.${slotName} slot — a resource is pointed at by a serializable id / well-known ` +
        `name, and the path-Q value cache keys on decoded args; narrow the slot to a data codec ` +
        `(or drop queries)`,
    );
  }
}

/**
 * Bake-time contradictions on the provenance × path pairing (rulings 2026-08-13).
 * The axes are orthogonal interpreters, but two shapes are incoherent:
 *   - "sink-queries": under gather a sink's impl is SKIPPED — a declared Q would
 *     journal a read and arm a subscription for a body that never ran.
 *     sink+effects stays legal (a sink IS an effect).
 *   - "effects-only-return": the E+Q mixing exists to make upsert-with-return
 *     possible — the RETURN of an effectful verb is licensed by its Q half.
 *     Effects-only with a real return mints world data it never declared reading.
 */
export class ResourcePathRoleConflictError extends ArrivalError {
  public readonly name = "ResourcePathRoleConflictError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    public readonly op: string,
    public readonly kind: "sink-queries" | "effects-only-return" = "sink-queries",
  ) {
    super(
      kind === "sink-queries"
        ? `${op}: a sink cannot declare queries — under gather a sink's impl is skipped, so its Q ` +
            `would journal a read and arm a live subscription for a body that never ran; drop queries, ` +
            `or drop provenance: "sink" if this verb genuinely reads`
        : `${op}: an effects-only contract cannot carry a real return — the return of an effectful ` +
            `verb is licensed by its query half (upsert-with-return is the hybrid shape); declare the ` +
            `query path this return reads, or make the output void`,
    );
  }
}

/**
 * Path producer threw or returned a bad shape.
 * Category is type-mismatch — the producer's output violated the path contract.
 */
export class ResourcePathProducerError extends ArrivalError {
  public readonly name = "ResourcePathProducerError";
  readonly "arrival/error-category": ErrorClass = "type-mismatch";

  constructor(
    public readonly verbName: string,
    public readonly axis: "queries" | "effects",
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(`${verbName}: ${axis} path producer ${reason}`, [], cause instanceof Error ? cause : undefined);
  }
}

/**
 * Call producer, then normalize return to a list of paths.
 * Always: top-level must be an array; each element must be an array (path).
 * Under strictCQSstrings: every segment must be a string.
 */
function producePaths(
  verbName: string,
  axis: "queries" | "effects",
  fn: ResourcePathFn,
  decodedArgs: readonly unknown[],
  strictCQSstrings: boolean,
): readonly ResourcePath[] {
  let raw: unknown;
  try {
    raw = fn(...decodedArgs);
  } catch (error) {
    const detail = error instanceof Error ? `threw: ${error.message}` : `threw: ${String(error)}`;
    throw new ResourcePathProducerError(verbName, axis, detail, error);
  }
  if (!Array.isArray(raw)) {
    throw new ResourcePathProducerError(
      verbName,
      axis,
      `must return an array of paths (got ${raw === null ? "null" : typeof raw})`,
    );
  }
  const out: ResourcePath[] = [];

  for (let pi = 0; pi < raw.length; pi++) {
    const path = raw[pi];
    if (!Array.isArray(path)) {
      throw new ResourcePathProducerError(
        verbName,
        axis,
        `path at index ${pi} must be a segment array (got ${path === null ? "null" : typeof path}) — ` +
          `return e.g. [["db","projects",id]], not a flat path`,
      );
    }
    if (strictCQSstrings) {
      for (let si = 0; si < path.length; si++) {
        if (typeof path[si] !== "string") {
          throw new ResourcePathProducerError(
            verbName,
            axis,
            `non-string segment at path[${pi}][${si}] (got ${typeof path[si]}) — ` +
              `caught by strictCQSstrings (segments must be strings)`,
          );
        }
      }
    }
    // Frozen COPY (N-PATHS-PRODUCER-ALIASING): a producer returning a cached/shared
    // array later mutated must not corrupt the journal or effect-log resourcePaths stamps.
    out.push(Object.freeze([...path]) as ResourcePath);
  }
  return Object.freeze(out);
}

/**
 * Run the CQS order for one penetration (R-O2 / R-HYBRID-ORDER / temporal law):
 *   path fns → intervening-door vs prior log only → record Q then E → (caller runs impl)
 *
 * When `log` is undefined, path fns still run if provided (for observability) but
 * check/record are no-ops (facility off — CONSTANT_CTX).
 *
 * `strictCQSstrings` (default false): runtime assert every path segment is a string.
 * Prefer type-level `ResourcePath`; this flag is for non-prod harness stress only.
 * Top-level producer shape (array of arrays) is always enforced.
 *
 * Door is intervening-E (`findInterveningDoor`), not classic priorE∩thisQ alone.
 * Self-door: check prior log only; record after pass (hybrid Q≺E).
 */
export function applyResourcePathCqs(opts: {
  verbName: string;
  decodedArgs: readonly unknown[];
  queries?: ResourcePathFn;
  effects?: ResourcePathFn;
  log: ResourcePathLog | undefined;
  strictCQSstrings?: boolean;
}): { queries: readonly ResourcePath[]; effects: readonly ResourcePath[] } {
  const strict = opts.strictCQSstrings === true;
  const Q = opts.queries ? producePaths(opts.verbName, "queries", opts.queries, opts.decodedArgs, strict) : [];
  const E = opts.effects ? producePaths(opts.verbName, "effects", opts.effects, opts.decodedArgs, strict) : [];
  const log = opts.log;
  if (log === undefined) {
    return { queries: Q, effects: E };
  }

  // DOOR — prior log only (self-door: current Q/E not yet recorded)
  if (Q.length > 0) {
    const witness = findInterveningDoor(log, Q);
    if (witness !== undefined) {
      throw new ResourcePathConflictError(
        opts.verbName,
        witness.priorEffect,
        witness.thisQuery,
        witness.priorQuery,
        E.length > 0, // hybrid penetration → door teaches the once-per-run rule
      );
    }
  }

  // RECORD — after pass; hybrid Q≺E (R-HYBRID-ORDER)
  if (Q.length > 0) {
    log.recordQueries(Q);
  }
  if (E.length > 0) {
    log.recordEffects(E);
  }
  return { queries: Q, effects: E };
}
