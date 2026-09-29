/**
 * SchemeCharacter — R7RS character type. Carries the `characters` named-character
 * table it is backed by.
 */
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { isSchemeString, type SchemeStringLike } from "../types.js";
import invariant from "tiny-invariant";
import type { SourceLocation } from "../../errors.js";

const characters: Record<string, string> = {
  alarm: "\u0007",
  backspace: "\u0008",
  delete: "\u007F",
  escape: "\u001B",
  newline: "\n",
  null: "\u0000",
  return: "\r",
  space: " ",
  tab: "\t",
  // new symbols from ASCII table in SRFI-175
  dle: "\u0010",
  soh: "\u0001",
  dc1: "\u0011",
  stx: "\u0002",
  dc2: "\u0012",
  etx: "\u0003",
  dc3: "\u0013",
  eot: "\u0004",
  dc4: "\u0014",
  enq: "\u0005",
  nak: "\u0015",
  ack: "\u0006",
  syn: "\u0016",
  bel: "\u0007",
  etb: "\u0017",
  bs: "\u0008",
  can: "\u0018",
  ht: "\u0009",
  em: "\u0019",
  lf: "\u000A",
  sub: "\u001A",
  vt: "\u000B",
  fs: "\u001C",
  ff: "\u000C",
  gs: "\u001D",
  cr: "\u000D",
  rs: "\u001E",
  so: "\u000E",
  us: "\u001F",
  si: "\u000F",
  esc: "\u001B",
  del: "\u007F",
};

export { characters };

export class ACharacter extends AValue {
  static readonly __names__: Record<string, string> = characters;
  static readonly __rev_names__: Record<string, string> = (() => {
    const rev: Record<string, string> = {};
    // First-write-wins: R7RS § 6.6 canonical names (alarm, backspace, delete,
    // escape, newline, null, return, space, tab) are registered FIRST in the
    // `characters` table, before their later SRFI-175 aliases (bel, bs, del,
    // esc, lf, cr, ht). Iterating in source order and skipping codepoints that
    // already have a reverse name keeps the canonical R7RS name as the winner —
    // so `(integer->char 7)` resolves to #\alarm, not #\bel.
    for (const key of Object.keys(characters)) {
      const codepoint = characters[key];
      if (!(codepoint in rev)) {
        rev[codepoint] = key;
      }
    }
    return rev;
  })();
  readonly kind = "character" as const;
  readonly __char__: string;
  readonly __name__?: string;

  constructor(
    char: string | SchemeStringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    location?: SourceLocation,
  ) {
    super(provenance, location);
    let charValue = isSchemeString(char) ? char.valueOf() : char;
    let name: string | undefined;

    if ([...charValue].length > 1) {
      charValue = charValue.toLowerCase();
      // this should never happen - parser doesn't allow undefined named characters
      invariant(ACharacter.__names__[charValue], "Internal: Unknown named character");
      name = charValue;
      charValue = ACharacter.__names__[charValue];
    } else {
      name = ACharacter.__rev_names__[charValue];
    }

    this.__char__ = charValue;
    if (name) {
      this.__name__ = name;
    }
  }

  toUpperCase(): ACharacter {
    return new ACharacter(this.__char__.toUpperCase());
  }

  toLowerCase(): ACharacter {
    return new ACharacter(this.__char__.toLowerCase());
  }

  toString(): string {
    return `#\\${this.__name__ || this.__char__}`;
  }

  valueOf(): string {
    return this.__char__;
  }

  // Print protocol — the RAW char (display form), i.e. `valueOf()`, NOT `toString()`
  // (which is the `#\x` write form).
  ["arrival/print"](): string {
    return this.valueOf();
  }

  serialize(): string {
    return this.__char__;
  }

  ["arrival/toJS"](): string {
    return this.__char__;
  }

  withProvenance(p: ReadonlySet<number>): ACharacter {
    return new ACharacter(this.__char__, p, this.location);
  }

  // Setoid — char ≡ char iff same grapheme. Matches __char__'s value semantics;
  // structuralEqual/equal? consult this first.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ACharacter && this.__char__ === other.__char__;
  }

  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return other instanceof ACharacter && (this.__char__.codePointAt(0) ?? 0) <= (other.__char__.codePointAt(0) ?? 0);
  }

  // Type predicate — `(char? x)` (a `symbol.taglessGuard`) asks the receiver instead of the
  // builtin reaching around with `instanceof ACharacter`. A Character answers #t; others #f.
  ["arrival/tagless-final/char?"](): boolean {
    return true;
  }
}

// SchemeCharacter has no JS-primitive source — it only exists post-parse, so no boxer.
