// ─────────────────────────────────────────────────────────────────────────────
// `number->string`, `string->number` — R7RS conversion family.
//
// Scheme semantics:
//   (number->string n [radix]) → the decimal (or radix-) string of n
//   (string->number s [radix]) → the parsed number, or #f when unparseable
//
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   arrival runtime (R7RS core) — these are interpreter builtins
//   the JS-projection stdlib does not list yet; the lens reaches them through
//   LENS_EXTRA_MEMBERS (service-core.ts), which lowers their call heads to
//   `__arr[…]` via the hostMembers seam.
//
// `string->number` is honestly `number | boolean`: R7RS returns #f on a parse
// failure, and arithmetic on the unchecked result SHOULD bite — that is a
// latent bug, not lens noise.
// ─────────────────────────────────────────────────────────────────────────────

declare function number$dash$$greater$string(n: number, radix?: number): string;
declare function string$dash$$greater$number(s: string, radix?: number): number | boolean;
