// _symbols-harvest — shared test helper: pull the `AEntity` CONTRACT view off every entry
// of a capability's `spec.symbols` record, for the harvest/contract-precision/emit test
// suites that used to do `pack.spec.symbols as Record<string, AEntity>` (a blind, unchecked
// cast) and then read `.kind`/`.in`/`.out`/`.emit`/`.narrows`/`.type` straight off each
// entry.
//
// Stage A2 (2026-07-22): the symbol.* factories mint the runtime A-value directly now
// (`ANativeProcedure`/`ARosettaProcedure`/`DoorProcedure`/`AKernelKeyword`/a boxed
// `AmbientValue` leaf) — the record entry IS the bound value, not a plain `{kind, ...}`
// record describing one. The blind cast above still TYPE-CHECKS (it's a cast through
// `unknown`), but every read past it is now WRONG at runtime (`.kind` reads the value's
// OWN scheme/callable kind — `"procedure"`/`"keyword"` — never the contract's `"native"`/
// `"rosetta"`/…). `harvestContracts` is the fix: the SAME `contractOf` read-side seam
// `common/capability.ts`'s bind loop and `eval/exec-phases.ts`'s describe/catalog roster
// already dispatch through, applied once over a whole `symbols` record.
//
// An entry with NO contract to show (`symbol.alias`'s unresolved marker, the historical
// `{ fn }` arm, `symbol.value`'s raw boxed data) is silently OMITTED from the returned
// record — exactly like `eval/exec-phases.ts`'s `rosterEntries` already treats those.
import type { SymbolDeclaration } from "../common/capability.js";
import { contractOf } from "../common/capability-internals.js";
import type { AEntity } from "../common/symbols/_bake.js";

export function harvestContracts(symbols: Record<string, SymbolDeclaration> | unknown): Record<string, AEntity> {
  const out: Record<string, AEntity> = {};
  if (typeof symbols !== "object" || symbols === null) return out;
  for (const [name, def] of Object.entries(symbols as Record<string, SymbolDeclaration>)) {
    const entity = contractOf(def);
    if (entity !== undefined) out[name] = entity;
  }
  return out;
}
