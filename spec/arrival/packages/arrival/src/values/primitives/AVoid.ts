/**
 * Void — the unspecified-value singleton. The result of expressions whose value
 * R7RS leaves *unspecified*: `(if #f #f)`, a not-taken `when`/`unless`, and the
 * side-effecting procedures (`set!`, `for-each`, `display`, …).
 *
 * Distinct from `nil` (`'()` — the empty LIST) and from `#f`: "computed no useful
 * value" is neither "the empty list" nor "false". One identity-compared singleton,
 * mirroring {@link EOF} — never raw JS `undefined` or `nil` standing in for it.
 *
 * Membrane (Rosetta concept-translation): JS `undefined` (no value) ↔ void; JS
 * `null` (explicit null) ↔ nil. The two host bottoms map to the two Scheme
 * absences.
 *
 * Mode: void EXISTS in both modes — the loose default treats it as an ordinary
 * (truthy) value; strict mode (the R7RS portability control) is where reliance on
 * our non-standard surface for it — the readable `#void` literal — is rejected. The
 * value class itself is mode-agnostic; the divergence lives at the reader.
 */
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";

export class AVoid extends AValue {
  readonly kind = "void" as const;

  constructor(provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
  }

  /** Non-readable external representation, mirroring `#<eof>`. The readable `#void`
   *  is a loose-mode reader tolerance, not a round-trip form — unspecified is not
   *  meant to round-trip. */
  toString(): string {
    return "#<void>";
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  /** Outbound translation: void → JS `undefined` (inverse of the `undefined` boxer). */
  ["arrival/toJS"](): undefined {
    return undefined;
  }

  withProvenance(p: ReadonlySet<number>): AVoid {
    return new AVoid(p);
  }

  // Setoid (Fantasy Land) — every void is equal (identity singleton; provenance
  // clones included), matching eq?'s instanceof check.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AVoid;
  }
}

/** The one unspecified value — identity-compared; returned for every "no useful
 *  value" site. */
export const theVoid = new AVoid();
