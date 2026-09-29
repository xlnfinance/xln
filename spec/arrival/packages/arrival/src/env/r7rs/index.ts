// @inhuman.tools/arrival/r7rs — the R7RS-small derived-syntax palette.
//
// The portable Scheme control forms arrival supports as macros, expanded from
// the small special-form core, split per R7RS section into one module-singleton
// `EnvCapability` each (mirroring env/srfi/). Importable from ONE subpath:
//   import { allR7rs } from "./r7rs/index.js";
//   import binding from "./r7rs/binding.js";
//
// Assembly is order-independent (docs/environments.md §ASSEMBLY: every form is a
// `define-macro`, expanded at CALL time against the fully-assembled userEnv, so
// cross-part references like guard→cond/raise resolve regardless of pack order).
// cond/case/when/unless are NOT here — they are evaluator SPECIAL FORMS
// (evalCond/evalCase/evalWhen/evalUnless), so guard's expansion to `(cond …)`
// needs no pack dependency.
//
// R7RS omissions are per-pack doors, not a central manifest (§DEGRADATION: a
// permanent-omission `notImplemented` door lives INSIDE the pack owning that part
// of the spec). Where each lives: the value-mutators with their type packs
// (r7rs/strings, r7rs/vectors, r7rs/lists, r7rs/bytevectors); the §6.10/§4.2.5/
// §4.2.6 control + dynamics + laziness omissions in `control.ts`; the §6.13/§6.14
// host-interface omissions in `host.ts`; §6.12 eval/environment reification in
// `eval.ts`; library/inclusion/feature-expand doors co-located on `syntax.ts`.

import syntax from "./syntax.js";
import binding from "./binding.js";
import exceptions from "./exceptions.js";
import lists from "./lists.js";
import control from "./control.js";
import host from "./host.js";
import r7rsEval from "./eval.js";

export const allR7rs = [syntax, binding, exceptions, lists, control, host, r7rsEval] as const;
