# @inhuman.tools/arrival-internals-types-prelude

PRE (`prelude/types.d.ts`) plus per-builtin ambient `declare function` leaves so `arrival-lsp` and `arrival-mercury/typefacts` share one type vocabulary without cycling.

This is the TypeScript type surface for arrival builtins: `sexpr`, `List` / `Tuple`, and every list / string / math op as ambient declares. The interactive LSP and the batch fact extractor both depend down on this leaf; it imports neither.

## Exports

| Subpath           | Surface                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `.`               | Node `getPreludeFiles` — reads the shipped `src/` `.d.ts` files via `node:fs`. Also re-exports `PRELUDE_FILE` / `PROGRAM_FILE`. |
| `./browser`       | `getBundledPreludeFiles` — the same map from a vite-inlined `?raw` glob. No `node:fs`.                                          |
| `./virtual-files` | Path constants (`PRELUDE_FILE`, `PROGRAM_FILE`) for hosts that must not pull `node:fs`.                                         |

## Authoring a builtin leaf

1. Copy `src/prelude/builtins/_TEMPLATE.d.ts` to `<slug>.d.ts` (the slug is the scheme name; operators get a readable slug such as `plus`).
2. `declare function` under the `encodeSchemeIdent` name (`car`, `string$dash$append`, `null$qmark$`, …) into the same ambient global as PRE.
3. Pair it with `<slug>.cases.ts` (`expectTypeOf` positives and `// @ts-expect-error` negatives). The merged cases program in `src/__tests__/builtins.test.ts` is the proof.

## Invariants

- Leaves are pure ambient `.d.ts` — no `import` / `export`.
- PRE alone does not define `car`. That declare lives on the `car` leaf; PRE without it yields “Cannot find name `car`”.

## Out of scope

Language-service, type-emit, and runtime implementations do not belong here.

## License

[MIT](./LICENSE.md).
