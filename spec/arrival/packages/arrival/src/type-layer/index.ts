// type-layer — harvested-prelude printer + diagnose lens.
// Plane framing: docs/static-plane.md §THE FOUR READERS 4.1.
//
// Constrained-decode T (getTypeValidCandidates / slot probes) lives on the language
// service (`arrival-lsp`), not here. This barrel is the harvest reader (`printType` /
// `sTagToTsType` / `assemblePreludeFromSignatures`) and the advisory diagnose probe
// (`createDiagnoseLens`). `lower` is exposed so a hand-rolled `declare const` prints
// with the SAME flatten the harvest uses.

export { assembleHarvestedPrelude, assemblePreludeFromSignatures, type HarvestedPrelude } from "./prelude.js";
export { printType, signatureOf, sTagToTsType } from "./schema-to-ts.js";
export { lower, type LoweredStatement } from "./lower.js";
export { createDiagnoseLens, type DiagnoseLens, type RawMappedDiagnostic } from "./diagnose.js";
