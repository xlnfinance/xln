// capability — TYPE-LEVEL PROOF that SymbolDeclaration (the raw authoring-time union a
// capability author writes in `symbols: {}`) is its own stable, importable export, distinct
// from `common/symbol.js`'s `AEntity` (the CONTRACT-data union — riding `.contract`/`.door`
// on a minted value now, no longer a record that travels in `SymbolDeclaration` on its own).
//
// STAGE A2 PIN (2026-07-22): the symbol.* factories mint the runtime A-VALUE directly —
// `native`/`sequence`/`tagless`/`tagless-guard` → `ANativeProcedure`, `rosetta` →
// `ARosettaProcedure`, `door`/`notImplemented` → `DoorProcedure`, `keyword` →
// `AKernelKeyword`, `value` → a boxed `AmbientValue` leaf. `AEntity`'s OTHER members
// (`NativeSymbolDef`, `RosettaSymbolDef`, …) are CONTRACT shapes only now — they no longer
// travel in `SymbolDeclaration` directly, only nested under a minted value's `.contract`/
// `.door`. `symbol.define`/`symbol.defineSyntax`/`symbol.macro` are the surviving two-phase/
// already-Macro-carrying declarative record kinds — unaffected by this stage, still bare
// `AEntity` members that bind directly. The assertions below pin BOTH halves of the split.
//
// COLLAPSE PIN (Stage-6, 2026-07-22): the bare-`Fn` and untagged `{ value }` arms are
// RETIRED — a data constant authors as `symbol.value` (mints a boxed `AmbientValue` now). The
// negative assertions below keep the retirement from silently regressing.
//
// STAGE C CUT 4 PIN (2026-07-23, docs/plans/stage-c-corpse-deletion.md): the forbidden `{ fn }`
// record arm is ALSO dropped from the union — `lower()`, its sole BINDER, is retired. Phase B
// (§"bans live at the TYPE level") went further: `isSymbolSpec` and the bare-fn refusal error (both deleted)
// (the runtime refusal check that used to guard `env/vocabulary.ts`'s bind loop against this
// shape) are DELETED — compat theater for a shape this very type-level pin already rejects.
// An untyped author reaching for `{ fn }` now gets a TS error at the keyboard, never a runtime
// door; this test is that error's proof.
import { describe, expectTypeOf, test } from "vitest";
import type { SymbolDeclaration } from "../capability.js";
import type { DefineSymbolDef, DefineSyntaxSymbolDef, MacroSymbolDef } from "../symbols/_bake.js";
import type { NativeSymbolDef } from "../../values/primitives/ANativeProcedure.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { AKernelKeyword } from "../../values/AKernelKeyword.js";

describe("SymbolDeclaration — the raw authoring-time union, post Stage-A2 mint", () => {
  test("the minted A-value classes (native/sequence/tagless/tagless-guard/rosetta/door/keyword) are assignable", () => {
    expectTypeOf<ANativeProcedure>().toExtend<SymbolDeclaration>();
    expectTypeOf<ARosettaProcedure>().toExtend<SymbolDeclaration>();
    expectTypeOf<DoorProcedure>().toExtend<SymbolDeclaration>();
    expectTypeOf<AKernelKeyword>().toExtend<SymbolDeclaration>();
  });

  test("define / defineSyntax / macro stay assignable (the surviving declarative record kinds)", () => {
    expectTypeOf<DefineSymbolDef>().toExtend<SymbolDeclaration>();
    expectTypeOf<DefineSyntaxSymbolDef>().toExtend<SymbolDeclaration>();
    expectTypeOf<MacroSymbolDef>().toExtend<SymbolDeclaration>();
  });

  test("a bare NativeSymbolDef contract shape is NOT assignable (rides `.contract` on the minted value instead)", () => {
    expectTypeOf<NativeSymbolDef>().not.toExtend<SymbolDeclaration>();
  });

  test("a bare value-binding object is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<{ value: unknown }>().not.toExtend<SymbolDeclaration>();
  });

  test("a bare function is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<(...args: unknown[]) => unknown>().not.toExtend<SymbolDeclaration>();
  });

  // INVARIANT (Stage C Cut 4 retirement pin, Phase B RETROACTIVE): the forbidden `{ fn }` record
  // is NO LONGER assignable — `lower()` (its sole binder) is retired, and there is no runtime
  // refusal check left either (`isSymbolSpec` and the bare-fn refusal error (both deleted) are deleted,
  // docs/plans/stage-c-corpse-deletion.md §"bans live at the TYPE level") — this compile-time
  // rejection IS the whole contract now.
  test("an explicit { fn } record is NOT assignable to SymbolDeclaration (retired arm)", () => {
    expectTypeOf<{ fn: (...args: unknown[]) => unknown }>().not.toExtend<SymbolDeclaration>();
  });
});
