// completions-narrowing — the PHASE-B GATE, pinned as assertions.
//
// Premise under test (overnight plan, Phase B): "narrowing comes from the LSP's
// native getCompletionsAtPosition, one general mechanism … retiring the per-shape
// __ok probe." The spike below GATES that premise against the real
// createSchemeLanguageService, and the result is a PARTIAL FALSIFICATION pinned
// here so it can't silently regress:
//
//   • getCompletionsAtPosition NARROWS at a STRING-INTERIOR value slot (inside an
//     open quote): tsc returns the string-literal UNION members and nothing else
//     from the slot's domain — the honest, general signal we wanted. ✓ (a)(b)
//   • It does NOT narrow a BOUND-SYMBOL argument slot (an unquoted atom): tsc
//     returns the whole lexical scope there (identifier completions are not
//     assignability-filtered). ✗ (a'')
//   • It returns EMPTY at the arrival `:keyword` kwarg-VALUE surface. ✗ (c)
//   • It does NOT narrow CALLABLE / operator position, nor the ARGUMENT-OF-`car`
//     case __ok was built for (return-type assignability is invisible to
//     completions). ✗ (d)
//
// Why this matters: the SHIPPING typed sampler emits enum values as BOUND SYMBOLS
// (`celsius`), and __ok narrows SYMBOLS by assignability. Completions narrow a
// DIFFERENT representation (string-interior literals) and cannot reproduce __ok's
// symbol/return-type narrowing. So __ok is NOT replaceable by completions on the
// bound-symbol path; a completions lens is an additive, string-literal-slot win.
//
// These assertions characterise tsc's behaviour through the scheme lens; they are
// the evidence behind the "keep __ok" call. Model-free (no GGUF, no tsgo wasm).

import { describe, expect, it } from "vitest";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

// A get_weather function with an ENUM slot (unit), a finite-domain location slot
// (city), and a free-form slot (note) — the three param kinds, exactly as the
// bfcl prelude emits them: each enum/location value-symbol declared on ArrShape,
// the param typed to the value-literal union.
const WEATHER_HOST = assembleHostPrelude(
  [
    ["get_weather", "(city: T_city, unit: T_unit, note: string): SStr"],
    ["celsius", ": T_unit"],
    ["fahrenheit", ": T_unit"],
    ["New_York_NY", ": T_city"],
    ["Paris", ": T_city"],
  ],
  {
    preamble: `type T_unit = "celsius" | "fahrenheit";\ntype T_city = "New York, NY" | "Paris";`,
  },
);

// An array-of-enum function — the (list "…") element case.
const DIET_HOST = assembleHostPrelude(
  [
    ["set_diet", "(preferences: T_pref[]): SStr"],
    ["vegan", ": T_pref"],
    ["vegetarian", ": T_pref"],
    ["pescatarian", ": T_pref"],
  ],
  { preamble: `type T_pref = "vegan" | "vegetarian" | "pescatarian";` },
);

/** The completion labels at a cursor, as a name set. */
function names(host: ReturnType<typeof assembleHostPrelude>, scheme: string, offset: number): Set<string> {
  const ls = createSchemeLanguageService({ host });
  return new Set(ls.getCompletionsAtPosition(scheme, offset).map((e) => e.name));
}

// The "noise floor": general callable builtins that are in scope EVERYWHERE.
// Their presence means the slot did NOT narrow (the full roster came through).
const NOISE = ["length", "car", "not", "filter", "string-append"];
function hasNoiseFloor(s: Set<string>): boolean {
  return NOISE.some((n) => s.has(n));
}

describe("getCompletionsAtPosition narrowing — the Phase-B gate (pinned)", () => {
  // ── The scheme-level API ALWAYS merges the full roster (service-core merges
  //    builtinCompletions unconditionally) — so its own answer never narrows. ──
  it("(merge) the scheme-level completion list is the full roster at EVERY slot — the merge masks narrowing", () => {
    const interiorEnum = names(WEATHER_HOST, `(get_weather New_York_NY "`, `(get_weather New_York_NY "`.length);
    // The enum members ARE present (the underlying tsc narrowing surfaces them)…
    expect(interiorEnum.has("celsius")).toBe(true);
    expect(interiorEnum.has("fahrenheit")).toBe(true);
    // …but so is the entire builtin roster — the merge defeats narrowing at the
    // scheme level. A completions LENS must read the raw narrowing signal, not this.
    expect(hasNoiseFloor(interiorEnum)).toBe(true);
  });

  // ── (a) STRING-INTERIOR enum: the enum members are offered (the raw tsc
  //    narrowing surfaces, even through the merge). The honest signal exists. ──
  it("(a) string-interior enum value slot surfaces exactly the enum members", () => {
    const s = names(WEATHER_HOST, `(get_weather New_York_NY "`, `(get_weather New_York_NY "`.length);
    expect(s.has("celsius")).toBe(true);
    expect(s.has("fahrenheit")).toBe(true);
    // The city members (the OTHER union) are NOT offered at the unit slot — tsc
    // resolved the slot correctly to T_unit.
    expect(s.has("New York, NY")).toBe(false);
  });

  // ── (b) LIST-ELEMENT string-interior (array-of-enum): the element union is
  //    offered. ──
  it("(b) list-element string-interior surfaces the array's element-enum members", () => {
    const s = names(DIET_HOST, `(set_diet (list "`, `(set_diet (list "`.length);
    expect(s.has("vegan")).toBe(true);
    expect(s.has("vegetarian")).toBe(true);
    expect(s.has("pescatarian")).toBe(true);
  });

  // ── (a'') BOUND-SYMBOL slot (no quote): tsc does NOT narrow identifier
  //    completions by assignability — the whole scope comes through. The
  //    SHIPPING typed path uses THIS representation (the model names `celsius`),
  //    so completions cannot replace __ok here. ──
  it("(a'') bound-symbol argument slot does NOT narrow — the noise floor is present", () => {
    const s = names(WEATHER_HOST, `(get_weather New_York_NY `, `(get_weather New_York_NY `.length);
    expect(hasNoiseFloor(s)).toBe(true); // length/car/not/filter all in scope ⇒ no narrowing
  });

  // ── (c) KWARG-VALUE slot (arrival `:keyword`): completions are EMPTY at the
  //    keyword value position — the emitter doesn't lower `(fn :unit …)` as a
  //    typed positional call. Empty ⇒ keep-all by the lens contract (never a
  //    wrong restriction), but NOT a narrowing win. ──
  it("(c) kwarg-value slot returns no slot-domain narrowing (keyword surface ⇒ keep-all)", () => {
    const s = names(WEATHER_HOST, `(get_weather :unit "`, `(get_weather :unit "`.length);
    // The enum members are NOT surfaced as a narrowed set here (the keyword
    // surface gives tsc no positional-arg context). Either empty-of-enum or the
    // merged roster — in both cases narrowing did not happen.
    const enumNarrowed = s.has("celsius") && s.has("fahrenheit") && !hasNoiseFloor(s);
    expect(enumNarrowed).toBe(false);
  });

  // ── (d) CALLABLE / operator position: no narrowing to callables (length/car
  //    stay). ──
  it("(d) operator/callable position does NOT narrow to callables — full roster", () => {
    const s = names(WEATHER_HOST, `(get_weather New_York_NY celsius (`, `(get_weather New_York_NY celsius (`.length);
    expect(hasNoiseFloor(s)).toBe(true); // length/car/not all offered at the head slot
  });

  // ── (d) the ARGUMENT-OF-`car` case __ok WAS built for: __ok narrows the arg
  //    by RETURN type (a list-producer survives, a scalar-producer is dropped);
  //    completions are blind to this — the full scope is offered. This is the
  //    crux of "__ok stays for callables". ──
  it("(d) argument-of-car: __ok narrows by return-type; completions do NOT", () => {
    const ls = createSchemeLanguageService({ host: WEATHER_HOST });
    // __ok DROPS a scalar where a list is wanted (the documented capability):
    const okValid = new Set(ls.getTypeValidCandidates("(car )", "(car ".length, ["list", "celsius"]));
    expect(okValid.has("list")).toBe(true); // list-producer fits car's arg
    expect(okValid.has("celsius")).toBe(false); // a scalar value does NOT fit
    // completions at the same arg slot offer EVERYTHING (no return-type filter):
    const comp = names(WEATHER_HOST, `(car `, `(car `.length);
    expect(hasNoiseFloor(comp)).toBe(true);
  });
});
