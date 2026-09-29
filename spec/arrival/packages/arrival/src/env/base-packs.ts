// BASE_PACKS — scheme stdlib as a capability set (the `.scm`-defined half;
// JS-native packs are the JS-implemented half). Each pack's prelude + symbols +
// resolvers become the live scheme surface. docs/environments.md §ASSEMBLY —
// C3 precedence this array's ORDER feeds.
//
// ARRAY POSITION IS C3 PRECEDENCE: this array is the roots list for the C3 merge.
// Cross-capability references are late-bound at CALL time, so prelude evaluation
// order is behaviorally immaterial — but a declared `deps` edge requires the
// dependent AHEAD of its dependency (dependents lead, dependencies trail) or the
// merge has no good head and throws. `scheme/core` is the precedence floor.
//
// Tail block [racket, clojure, lisp, polyglot, srfi1, binding, exceptions, lists]
// resolves that constraint:
//   racket     — deps: clojure/polyglot/equality/numeric/vectors/lists/exceptions
//   clojure    — deps: polyglot/srfi1/equality/numeric/strings/vectors/lists; used by racket
//   lisp       — deps: srfi1/equality/lists; independent of racket/clojure/polyglot branch
//   polyglot   — deps: equality/lists; used by srfi-235, clojure, racket
//   srfi1      — deps: exceptions/lists; used by polyglot/clojure/lisp
//   binding    — multi-return + set! doors; no pack depends on it for FV
//   exceptions — used by srfi-189, srfi-1, racket; leads lists
//   lists      — used by almost everyone: LAST
//
// equality/numeric/strings/vectors/chars are JS-native packs — no roots-order constraint here.
//
// Polyglot family: shared core (`scheme/polyglot`) + three dialect packs
// (clojure/lisp/racket). Core is a deps TARGET of dialects and of srfi-235 —
// hence tail position leading the dialects. Racket deps on clojure (`~>` expands
// to `->`; dict doors call `str`); each dialect header carries the name census.

import type { EnvCapability } from "../common/capability.js";
import core from "./core/core.js";
import polyglotStubs from "./polyglot/polyglot-stubs.js";
import macros from "./macros/macros.js";
import polyglot from "./polyglot/polyglot.js";
import polyglotClojure from "./polyglot/polyglot-clojure.js";
import polyglotLisp from "./polyglot/polyglot-lisp.js";
import polyglotRacket from "./polyglot/polyglot-racket.js";
import sugarcoat from "./sugarcoat/sugarcoat.js";
import { allR7rs } from "./r7rs/index.js";
import { allSrfi } from "./srfi/index.js";

function packNamed<T extends { readonly name: string }>(packs: readonly T[], name: string): T {
  const pack = packs.find((p) => p.name === name);
  if (!pack) throw new TypeError(`base-packs: ${name} is not in the palette`);
  return pack;
}

const binding = packNamed(allR7rs, "scheme/r7rs/binding");
const exceptions = packNamed(allR7rs, "scheme/r7rs/exceptions");
const lists = packNamed(allR7rs, "scheme/lists");
const srfi1 = packNamed(allSrfi, "scheme/srfi-1");

// polyglotStubs is its OWN entry (not a SRFI) — cross-dialect doors with no SRFI/R7RS lineage.
// sugarcoat is its OWN entry — JS-shaped aliases (** % == …) for the sugarcoat surface.
// binding/lists/exceptions/srfi1 pulled out of spreads for C3 tail placement (header).
// sugarcoat deps [numeric, lists]: lists is in the C3 tail, so sugarcoat sits in the tail
// ahead of lists (dependent before dependency). numeric is JS-native (pulled via deps).
const r7rsWithoutRepositioned = allR7rs.filter((pack) => pack !== lists && pack !== exceptions && pack !== binding);
const srfiWithoutRepositioned = allSrfi.filter((pack) => pack !== srfi1);

export const BASE_PACKS: readonly EnvCapability[] = [
  core,
  macros,
  ...r7rsWithoutRepositioned,
  ...srfiWithoutRepositioned,
  polyglotStubs,
  // C3 tail — dependents first, dependencies after (header).
  polyglotRacket,
  polyglotClojure,
  polyglotLisp,
  polyglot,
  sugarcoat,
  srfi1,
  binding,
  exceptions,
  lists,
];
