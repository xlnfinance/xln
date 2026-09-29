import { AValue, EMPTY_PROVENANCE } from "./AValue.js";

/**
 * Boxed boolean. Lineage: the representation-blind `arrival/tagless-final/equals` is a
 * Fantasy Land Setoid (fantasyland/fantasy-land); the shared schemeTrue/
 * schemeFalse singletons on the empty-provenance fast path are the flyweight
 * pattern.
 */
export class ABool extends AValue {
  // "boolean" (not "bool") — matches error phrasing ("expected a boolean") and ValueKind.
  readonly kind = "boolean" as const;

  constructor(
    public readonly value: boolean,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  toString(): string {
    return this.value ? "#t" : "#f";
  }

  ["arrival/print"](): string {
    return this.toString();
  }
  valueOf(): boolean {
    return this.value;
  }
  ["arrival/toJS"](): boolean {
    return this.value;
  }
  withProvenance(p: ReadonlySet<number>): ABool {
    return new ABool(this.value, p);
  }

  // Fantasy Land Setoid: REPRESENTATION-BLIND — a boxed SchemeBool equals another SchemeBool of the
  // same value AND the same value UNBOXED (a plain JS boolean). Booleans carry no grade, so identity
  // is the truth value alone; the chain plane boxes inconsistently, so equal? meets boxed vs plain.
  // `this.value === other` matches a plain-boolean `other` and rejects non-booleans (1, "true").
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return this.value === (other instanceof ABool ? other.value : other);
  }
}

export const schemeTrue = new ABool(true);
export const schemeFalse = new ABool(false);

// ============================================================================
// INTEROP BOUNDARY: ABool's prototype is narrow today, but `schemeTrue`/`schemeFalse` are
// heavily reused singletons — any future helper grafted onto the prototype would reach every
// Boolean-valued response from the inference plane. The FAMILY RULE in interop-access.ts
// (`instanceof AValue` covers the whole value hierarchy in one check; no per-class stamp)
// keeps the inherited surface blocked.
// ============================================================================
