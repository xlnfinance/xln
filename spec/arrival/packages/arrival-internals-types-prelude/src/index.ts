// arrival-internals-types-prelude — the TypeScript type vocabulary for arrival
// builtins.
//
// The `.d.ts` surface (PRE `prelude/types.d.ts` + every `prelude/builtins/<slug>.d.ts`
// leaf) that teaches tsc what arrival's runtime builtins mean as TS types —
// `sexpr`, `List`/`Tuple`, and every list / string / math op (ambient declares).
// Two consumers stand on this vocabulary: the interactive LSP (`arrival-lsp`) and
// the batch fact extractor (`arrival-mercury/typefacts`). It was extracted from
// `arrival-lsp` to break the `arrival-lsp` <-> `arrival-mercury` package cycle:
// both now depend DOWN on this leaf, which imports neither.
//
// This entry is the Node/disk loader (`getPreludeFiles`, reads the `.d.ts` from
// the shipped `src/`). The `./browser` entry mounts the SAME vocabulary via a
// vite-inlined `?raw` glob; the `./virtual-files` entry is the dep-free file-name
// constants for hosts that must not pull `node:fs`.
export { getPreludeFiles, PRELUDE_FILE, PROGRAM_FILE } from "./prelude.js";
