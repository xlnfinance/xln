// @inhuman.tools/arrival/srfi/srfi-stubs — the TEACHING-STUB pack.
//
// A DOORS-ONLY capability, sibling in spirit to `r7rs/host.ts`. These are the
// symbols an LLM agent PREDICTABLY reaches for (having seen the string / list /
// dict surface) that arrival deliberately does NOT implement. A bare "Unbound
// variable" is a dead-end wall; each door here (errors-as-doors) NAMES the fact,
// the REASON, and the EXACT alternative bound in this environment — turning the
// wall into a route back to the real dataflow.
//
// Families (family 2 — R7RS §6.13.1 file openers + CL with-open-file — live beside
// their family packs: R7RS verbs in r7rs/host.ts, CL-ism in polyglot-stubs.ts):
//   1. SRFI-69/125 hash tables → dicts are native & immutable ({…} / (dict …)).
//   3. SRFI-27 random → ambient non-determinism has no place in a pure sandbox.
//   4. SRFI-14 char-sets → the string library takes a char or one-arg predicate.
//   5. SRFI-19 time/date → the clock is ambient; timestamps arrive in tool results.
//   (6. SRFI-13 pure gaps — owned by scheme/srfi-13 doors, not this junk drawer.)
//   7. SRFI-113 sets (list->set, set-contains?) → no set type exists to redirect to.
//   8. string ports (call-with-input-string, SRFI-6) → omitted, same as host.ts's ports.
//
// SCOPE / COMPROMISES (honest deltas):
//   • Registered — this pack IS assembled by default: `srfi/index.ts` folds it into
//     `allSrfi`, which `base-packs.ts` assembles into `BASE_PACKS`. Every env that
//     inherits `sandboxedEnv` doors these symbols; there is no pack-less production
//     configuration left to pin as a counter-case (see `srfi-stubs.test.ts`).
//   • `char-set:whitespace` / `:alphabetic` / `:numeric` are SRFI VARIABLES, not
//     procedures. `symbol.notImplemented` only bakes a callable door, so they are
//     bound as throwing procedures: a model that CALLS one gets the teaching door;
//     a bare reference resolves to the throwing closure without firing. Acceptable
//     — the reach we care about is the call site. (`parseNameDoc` splits on the
//     first COLON-SPACE (": "), not the first colon — necessary because these
//     colon-named doors would otherwise truncate to `char-set`; `def.name`
//     reports the full `char-set:whitespace`.)
//
// No symbol here is stubbed by `r7rs/host.ts`: host.ts doors the R7RS §6.13/§6.14
// host interface (port primitives, the §6.13.1 file openers, system verbs); this
// pack doors only SRFI-numbered omissions — so the two add, never double-bind.

import { EnvCapability } from "../../common/capability.js";

// ── 1. SRFI-69 / SRFI-125 hash tables ────────────────────────────────────────
// The true alternative is the native `dict`: an immutable open-key map. Build with
// the `{:key value …}` literal or `(dict :key value …)`; read with `(:key d)` or
// `(@ d :key)`; enumerate keys with `(@keys d)`. There is no mutation — model any
// accumulation as a FRESH dict rebuilt from tool results.
const HASH_TABLE_REASON =
  "hash tables are not implemented — dicts are native and immutable here: build with {:key value ...} or (dict :key value ...), read with (:key d) or (@ d :key), enumerate keys with (@keys d); for iteration fold over (@keys d), and rebuild a fresh dict instead of mutating one in place";

// ── 3. SRFI-27 random ─────────────────────────────────────────────────────────
// Mirrors host.ts's SYSTEM_REASON tone: ambient non-determinism has no lineage root.
const RANDOM_REASON =
  "randomness is omitted from arrival by design — non-deterministic ambient state has no construction-site to root a value's lineage at, and a pure sandbox stays reproducible; pass any needed choice or seed in explicitly, or draw it from a tool result";

// ── 4. SRFI-14 char-sets ──────────────────────────────────────────────────────
const CHAR_SET_REASON = String.raw`char-sets are not implemented — the string library here takes a char or a one-arg predicate instead, e.g. (string-index s char-numeric?) or (string-trim s #\space)`;

// ── 5. SRFI-19 time / date ────────────────────────────────────────────────────
// Ambient-clock door (host.ts tone) + the format/parse redirect for the pure verbs.
const TIME_DATE_REASON =
  "the date/time library is omitted from arrival by design — the clock is ambient and non-deterministic, with no construction-site to root a value's lineage at; timestamps arrive in tool results, so compare and format them as plain strings or numbers";

// (6. SRFI-13 string-filter — moved into scheme/srfi-13 pack doors; pack owns the index.)

// ── 7. SRFI-113 sets ──────────────────────────────────────────────────────────
// Verified: no set type is bound anywhere in this env (grepped values/ + env/{srfi,r7rs,
// core}) — dicts and lists are the only collection types. There is genuinely no set
// equivalent to redirect to, so — unlike family 6 — this door does NOT claim one.
const SET_REASON =
  "sets are not implemented (SRFI-113) — this sandbox has no set type, only lists and dicts, so there is no direct equivalent to redirect to; if de-duplication or membership alone covers what you needed a set for, (delete-duplicates xs) and (member x xs) are bound (SRFI-1 / R7RS), but they operate on lists, not sets";

// ── 8. String ports (call-with-input-string) ─────────────────────────────────
// Not a design-omission family of its own — it's the same §6.13 port omission
// r7rs/host.ts already doors (open-input-string / open-output-string throw IO_REASON
// there); call-with-input-string would just wrap a port constructor that doesn't
// exist, so it gets the identical redirect: operate on the string directly.
const STRING_PORT_REASON =
  "call-with-input-string is not implemented — string ports are omitted from arrival by design (R7RS §6.13.2 / SRFI-6), the same omission r7rs/host.ts's open-input-string door names; the string you would read through the port IS the value you already have, so operate on it directly with string-ref / string->list / string-split / string-index instead of reading it back through a port";

export default EnvCapability.define("scheme/srfi-stubs", {
  symbols: (symbol) => ({
    // 1. SRFI-69 / SRFI-125 hash tables
    "make-hash-table": symbol.notImplemented`make-hash-table: ${HASH_TABLE_REASON}`,
    "hash-table?": symbol.notImplemented`hash-table?: ${HASH_TABLE_REASON}`,
    "hash-table-ref": symbol.notImplemented`hash-table-ref: ${HASH_TABLE_REASON}`,
    "hash-table-ref/default": symbol.notImplemented`hash-table-ref/default: ${HASH_TABLE_REASON}`,
    "hash-table-set!": symbol.notImplemented`hash-table-set!: ${HASH_TABLE_REASON}`,
    "hash-table-delete!": symbol.notImplemented`hash-table-delete!: ${HASH_TABLE_REASON}`,
    "hash-table-update!": symbol.notImplemented`hash-table-update!: ${HASH_TABLE_REASON}`,
    "hash-table->alist": symbol.notImplemented`hash-table->alist: ${HASH_TABLE_REASON}`,
    "alist->hash-table": symbol.notImplemented`alist->hash-table: ${HASH_TABLE_REASON}`,
    "hash-table-keys": symbol.notImplemented`hash-table-keys: ${HASH_TABLE_REASON}`,
    "hash-table-values": symbol.notImplemented`hash-table-values: ${HASH_TABLE_REASON}`,
    "hash-table-walk": symbol.notImplemented`hash-table-walk: ${HASH_TABLE_REASON}`,
    "hash-table-fold": symbol.notImplemented`hash-table-fold: ${HASH_TABLE_REASON}`,
    "hash-table-count": symbol.notImplemented`hash-table-count: ${HASH_TABLE_REASON}`,
    "hash-table-exists?": symbol.notImplemented`hash-table-exists?: ${HASH_TABLE_REASON}`,
    "hash-table-contains?": symbol.notImplemented`hash-table-contains?: ${HASH_TABLE_REASON}`,

    // (2. File ports — moved: R7RS §6.13.1 openers → r7rs/host.ts, with-open-file → polyglot-stubs.ts)

    // 3. SRFI-27 random
    "random-integer": symbol.notImplemented`random-integer: ${RANDOM_REASON}`,
    "random-real": symbol.notImplemented`random-real: ${RANDOM_REASON}`,
    "random-source-make-integers": symbol.notImplemented`random-source-make-integers: ${RANDOM_REASON}`,

    // 4. SRFI-14 char-sets (the `char-set:*` entries are VARIABLES — see COMPROMISES)
    "char-set": symbol.notImplemented`char-set: ${CHAR_SET_REASON}`,
    "char-set?": symbol.notImplemented`char-set?: ${CHAR_SET_REASON}`,
    "char-set-contains?": symbol.notImplemented`char-set-contains?: ${CHAR_SET_REASON}`,
    "string->char-set": symbol.notImplemented`string->char-set: ${CHAR_SET_REASON}`,
    "char-set:whitespace": symbol.notImplemented`char-set:whitespace: ${CHAR_SET_REASON}`,
    "char-set:alphabetic": symbol.notImplemented`char-set:alphabetic: ${CHAR_SET_REASON}`,
    "char-set:numeric": symbol.notImplemented`char-set:numeric: ${CHAR_SET_REASON}`,

    // 5. SRFI-19 time / date
    "current-date": symbol.notImplemented`current-date: ${TIME_DATE_REASON}`,
    "current-time": symbol.notImplemented`current-time: ${TIME_DATE_REASON}`,
    "date->string": symbol.notImplemented`date->string: ${TIME_DATE_REASON}`,
    "string->date": symbol.notImplemented`string->date: ${TIME_DATE_REASON}`,
    "time-utc->date": symbol.notImplemented`time-utc->date: ${TIME_DATE_REASON}`,
    "current-julian-day": symbol.notImplemented`current-julian-day: ${TIME_DATE_REASON}`,

    // (6. SRFI-13 string-filter — scheme/srfi-13 owns the door now)

    // 7. SRFI-113 sets (no set type — no redirect claimed)
    "list->set": symbol.notImplemented`list->set: ${SET_REASON}`,
    "set-contains?": symbol.notImplemented`set-contains?: ${SET_REASON}`,

    // 8. String ports (mirrors host.ts's port omission)
    "call-with-input-string": symbol.notImplemented`call-with-input-string: ${STRING_PORT_REASON}`,
  }),
});
