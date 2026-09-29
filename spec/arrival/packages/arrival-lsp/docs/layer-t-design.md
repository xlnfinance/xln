# Layer T — type-narrowed candidate masking

Layer T narrows a scope-valid (Σ) completion mask by TypeScript type validity, so the
surviving set at an argument slot is Σ∩T: a candidate must be both bound-in-scope and
type-valid for that argument to remain a completion.

The check is a batched conditional-type probe: emit a sentinel form at the cursor, find
the enclosing call (callee + argument index) via the AST, ask the checker in one pass
whether each candidate's type satisfies the argument's declared type. It is conservative —
it drops only candidates it can prove ill-typed; anything unresolved (locals, untyped
values) stays in the mask.

## Where the design lives

- `src/typed-scanner.ts` — `narrowByType` wraps a structural `Scanner` so `validSymbols()`
  returns the Σ∩T set, memoized per argument slot (one type round-trip per slot, not per
  candidate).
- `src/service-core.ts` — `getTypeValidCandidates` is the call site that runs the
  sentinel-emit-and-probe against the language service.
- `src/__tests__/language-service.test.ts` — tests tagged `KNOWN GAP` mark where the mask
  is intentionally incomplete.

Open gaps are marked in-code as `KNOWN GAP`; grep the package for that tag rather than
reading a status list here.
