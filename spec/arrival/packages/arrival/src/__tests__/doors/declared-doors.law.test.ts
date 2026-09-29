// F6 — Doors (docs/test-suite-architecture.md F6, P5 errors-as-doors). DECLARATION-DRIVEN:
// every row below comes from the BASE_PACKS capability declarations themselves — the
// `symbol.notImplemented` doors each pack authors (env/r7rs/host.ts, env/srfi/srfi-stubs.ts,
// env/polyglot/polyglot-stubs.ts, srfi-1's `fold`, …). Nothing here is hand-enumerated, and there is
// no side registry to drift from: the DECLARATIONS are the registry (the AmbientRuntime-
// despecialization ruling that dissolved env/polyglot-rich-errors/registry.ts — teaching
// about well-known-but-absent names is capability DATA resolving through the ordinary
// chain, not a curated table inside the error path).
//
// Two laws, one subject (the declared doors), sharing this file per docs/test-suite-architecture.md's "law
// files … contain ONE law (possibly many rows)" — the one law is "a declared door
// behaves as declared," tested from two angles:
//   1. every declared door FIRES AT APPLY: calling it throws the PurityError teaching
//      door, naming the symbol and carrying a substantive reason (production default
//      env — every pack ships in BASE_PACKS).
//   2. the door-fires-at-APPLY semantic, pinned from the other side: a BARE REFERENCE
//      to a door name RESOLVES (the door is a bound value — `(bound? 'x)`-style probes
//      see it as present); only invocation throws. A door value that throws on USE is
//      more honest than a lookup-time throw: resolution answers "does this name exist
//      here" (yes, as a declared omission), application answers "can it do work" (no —
//      and here is why).
// Plus the completeness floor: no duplicate door declarations across packs, and the
// grids are not silently vacuous (P16 anti-vacuity).
//
// Predecessor files this REPLACES: `registry.law.test.ts` (this file, renamed — was
// registry-table-driven), `polyglot-rich-errors-stubs.test.ts` + the stubbed half of
// `polyglot-rich-errors-typo.test.ts` (retired with the registry). The TYPO-enrichment
// laws live in the sibling `vocabulary-suggestions.law.test.ts` — a different law
// (suggestions derive from the chain's live vocabulary), different subject.

import { describe, expect, it } from "vitest";
import { exec } from "../../eval/generator-exec.js";
import { PurityError } from "../../errors.js";
import { BASE_PACKS } from "../../env/base-packs.js";
import { contractOf } from "../../common/capability-internals.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";

/** Source spelling of a door name that the reader can re-parse as that same name.
 *  Most doors are bare identifiers (`println`, `>>`, `**`); a few are reader-special
 *  (notably `|` — the R7RS bar-quote delimiter, declared as the sugarcoat bitwise-or
 *  door). `ASymbol.toString(true)` is the write-side of that round-trip: bare when legal,
 *  `|…|` (with `\|` / `\\` escapes) when the name would otherwise be misread. */
function identifierSource(name: string): string {
  return new ASymbol(name).toString(true);
}

/** Every `symbol.notImplemented` door declared by a BASE_PACKS capability, as
 *  {name, reason, pack}. Builder-form `symbols`
 *  (a per-activation function) can't be enumerated statically and is skipped — no
 *  base pack uses it; if one ever does, the anti-vacuity floor below still holds for
 *  the static population. */
function declaredDoors(): { name: string; reason: string; pack: string }[] {
  const doors: { name: string; reason: string; pack: string }[] = [];
  for (const cap of BASE_PACKS) {
    const symbols = cap.spec.symbols;
    if (symbols === undefined || typeof symbols === "function") continue;
    for (const [key, rawDef] of Object.entries(symbols)) {
      // Stage A2: `symbol.notImplemented` mints a DoorProcedure directly now — `contractOf`
      // (common/capability.ts) is the shared read-side seam every describe/catalog/harvest
      // reader dispatches through to pull a minted value's CONTRACT (here, `.door`).
      const entity = contractOf(rawDef);
      if (entity !== undefined && entity.kind === "door") {
        doors.push({ name: key, reason: entity.reason, pack: cap.name });
      }
    }
  }
  return doors;
}

const DOORS = declaredDoors();

// ============================================================================
// 1. Every declared door FIRES AT APPLY with teaching
// ============================================================================
//
// Call shape: `(<id>)` — ZERO arguments, uniformly, for every entry regardless of
// the symbol's real arity. `<id>` is `identifierSource(name)` (bare, or bar-quoted when
// the name is reader-special — see `|` / scheme/sugarcoat). Deliberate: per
// capability.ts's "door" binding (`env.set(verb, () => { throw new PurityError(...) })`),
// the door is a closure that throws UNCONDITIONALLY, before any argument is even looked
// at — JS doesn't enforce arity on a plain function, so calling with 0 args never reaches
// a "wrong number of arguments" problem, and nothing is evaluated before the call
// (calling WITH an unbound-variable argument would evaluate that argument BEFORE the
// door fires, since doors are procedures, not macros).

// INVARIANT (carried from the dissolved polyglot-rich-errors-stubs.test.ts, generalized: every
// declared door — including each well-known cross-dialect stub, e.g. type-of/<>/make-hash/
// make-hasheq/hash-ref/gethash/getf/println/print/loop/nreverse/for-list/for-fold — fires a
// PurityError door whose message names the symbol and carries a substantive reason, because
// the owning pack ships in BASE_PACKS; unlike the old per-name-enumerated test, this is
// declaration-driven so it covers every door without hand-listing names):
// DEAD/NARROWED: the old suite additionally regex-matched each stub's message against "the
// correct bound alternative" by name; this generic harness only asserts shape (names the
// symbol + a substantive "Why:" clause) — the alternative-naming content is pinned at the
// SOURCE (each reason string in env/polyglot/polyglot-stubs.ts) rather than re-asserted here.
// DEAD: "setf/defun fire their door when called with already-bound arguments (limitation:
// unbound-argument calls surface 'Unbound variable' instead, since these are procedures, not
// macros)" — this harness deliberately calls every door with ZERO arguments uniformly to
// sidestep argument-evaluation order entirely, so the already-bound-vs-unbound-argument
// distinction for setf/defun specifically is no longer exercised by any live test.
describe("F6 doors — every DECLARED notImplemented door fires at apply with teaching (declaration-driven)", () => {
  // Anti-vacuity floor (P16/F9): if this ever collapses to 0, `it.each` below
  // silently runs zero tests and the suite stays green while testing nothing.
  it("BASE_PACKS declares at least one door (anti-vacuity floor)", () => {
    expect(DOORS.length).toBeGreaterThan(0);
  });

  /** Shared body: fires `(<id>)` for the door name, confirms a PurityError door, returns the message. */
  async function fireDoor(name: string): Promise<string> {
    const id = identifierSource(name);
    let caught: unknown;
    try {
      await exec(`(${id})`);
    } catch (e) {
      caught = e;
    }
    expect(caught, `expected (${id}) to throw`).toBeDefined();
    const direct = caught instanceof PurityError;
    const viaCause = (caught as { cause?: unknown })?.cause instanceof PurityError;
    const message = (caught as Error)?.message ?? String(caught);
    expect(direct || viaCause, `expected a PurityError door for \`${name}\`, got: ${message}`).toBe(true);
    return message;
  }

  /** (b) carries a substantive reason, not just the bare wall — the structural "Why:"
   *  marker is the door template's own teaching hinge (present iff a `def.reason` was
   *  supplied, which `symbol.notImplemented` always requires). Structural + length
   *  check rather than a byte-match against the declared reason: stays true regardless
   *  of phrasing, still fails loudly if a door's reason ever regresses to empty/near-empty. */
  function expectSubstantiveWhy(message: string): void {
    const whyMatch = message.match(/\bWhy:\s*(.+)$/s);
    expect(whyMatch, `expected a "Why:" reason clause in: ${message}`).not.toBeNull();
    expect(whyMatch![1].trim().length).toBeGreaterThan(15);
  }

  // INVARIANT: every stub symbol doors with "is not available." in the DEFAULT env, because
  // the owning pack ships in BASE_PACKS (pins implementation, not behavior)
  it.each(DOORS.map((d): [string, { name: string; reason: string; pack: string }] => [`${d.name} (${d.pack})`, d]))(
    "(%s) doors: names the symbol + carries a substantive teaching reason",
    async (_label, door) => {
      const message = await fireDoor(door.name);
      // (a) names the symbol — capability.ts's door template is `${def.name} is not
      // available.\n  Why: ${def.reason}`, so the canonical name always leads the message.
      expect(message).toContain(door.name);
      expectSubstantiveWhy(message);
    },
  );

  // DoorCause (docs/design-history/symbol-define-static-program-validation.md §3.3) — the causal-
  // chain UX's first link, wired through EVERY declared door: `common/capability.ts`'s door
  // bind arm derives `cause = { owner: <this capability's name>, needs: [] }` for a
  // `notImplemented` door (which never sets one itself), so the thrown message now leads
  // with `name @ capability` — never a raw hash (§3.1's display discipline) — for the whole
  // production population, not just a hand-picked few.
  it.each(DOORS.map((d): [string, { name: string; reason: string; pack: string }] => [`${d.name} (${d.pack})`, d]))(
    "(%s) doors: the message names `name @ owning-capability`",
    async (_label, door) => {
      const message = await fireDoor(door.name);
      expect(message).toContain(`${door.name} @ ${door.pack}`);
    },
  );
});

// ============================================================================
// 2. The door-fires-at-APPLY semantic (the `(bound? 'stub-name)` ruling, pinned)
// ============================================================================
describe("F6 doors — a door RESOLVES at lookup and fires only at apply", () => {
  it("a bare reference to a door name resolves to a value — no unbound throw, no door fire", async () => {
    // Three doors from three different packs (cross-dialect / R7RS host / the srfi-1
    // fold gap) — the semantic is capability.ts's ONE door binding, not per-pack.
    // Probe shape: `(begin <name> #t)` — evaluates the bare reference (resolution
    // would throw here if the door fired at lookup) WITHOUT returning the door
    // closure through exec's toJS exit membrane (a door binds as a raw JS closure,
    // which the Scheme→JS exit rightly refuses to export as a program result).
    for (const name of ["println", "open-input-file", "fold"]) {
      // exec returns the program's values-list — `#t` seals to `[true]`.
      await expect(exec(`(begin ${name} #t)`), `expected bare \`${name}\` to resolve`).resolves.toEqual([true]);
    }
  });

  it("the same names throw the teaching door when APPLIED", async () => {
    for (const name of ["println", "open-input-file", "fold"]) {
      await expect(exec(`(${name})`)).rejects.toThrow(/is not available/);
    }
  });

  it("the moved/new entries still teach: srfi-1's `fold` names both bound alternatives", async () => {
    // `fold` was the registry's one famous-but-absent row; it is a DECLARED door now
    // (env/srfi/srfi-1.ts) — the EXACT name teaches at apply, where the old table only
    // ever enriched a near-typo of it.
    await expect(exec("(fold + 0 (list 1 2 3))")).rejects.toThrow(/use reduce .*or fold-right/);
  });
});

// ============================================================================
// 3. Completeness drift alarms (P16's sanctioned pins)
// ============================================================================
describe("F6 doors — declaration completeness drift alarms", () => {
  it("no duplicate door declarations across packs (a name doors in exactly one pack)", () => {
    const seen = new Map<string, string>();
    for (const door of DOORS) {
      const prior = seen.get(door.name);
      expect(prior, `door \`${door.name}\` declared by both \`${prior}\` and \`${door.pack}\``).toBeUndefined();
      seen.set(door.name, door.pack);
    }
  });

  it("every door carries a non-empty declared reason (the redirect doors exist to give)", () => {
    for (const door of DOORS) {
      expect(door.reason.trim().length, `\`${door.name}\` (${door.pack}) has no substantive reason`).toBeGreaterThan(
        15,
      );
    }
  });
});
