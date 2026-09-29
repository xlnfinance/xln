// Pure Scheme↔sugarcoat syntax lens — the readable "sugarcoat" view over canonical
// `.scm` source and the fold back to Scheme. This subpath carries ONLY the
// reader + renderer: `sugarcoat-render` imports `@inhuman.tools/arrival-syntax` for
// `parseSexprs`, `sugarcoat-read` imports only `sugarcoat-render`, so neither pulls
// a line of the eval engine.
//
// Import from here when you want the lens WITHOUT the runtime — e.g. an editor
// UI that renders/edits the sugarcoat view. The barrel `.` export drags the whole
// inference substrate; this one is the few-KB syntax pair on its own.
export { schemeToSugarcoat, type SugarcoatOpts } from "./sugarcoat-render.js";
// Scheme-parse primitives for source-to-source consumers (e.g. arrival-chain-view
// projecting scheme → JS/Python). Pure analysis — stays inside the runtime-free lens.
export { parseSexprs, printScheme, type Node } from "./sugarcoat-render.js";
// Loading the reader registers it with schemeToSugarcoat (dual-path re-entry for
// already-sweet buffers). Keep this import after the render exports so the hook
// installs for every facade consumer.
export { sugarcoatToScheme, readSugarcoat } from "./sugarcoat-read.js";
// Sugarcoat↔Scheme span alignment — pairs the spans both transforms already stamp
// (lockstep walk over the structurally-equal trees). Coordinate substrate for
// IDE features in the sugarcoat view; same runtime-free closure.
export { alignSugarcoatScheme, type SugarcoatAlignment, type SugarcoatSpanPair } from "./sugarcoat-align.js";
// Parameter inlay hints — pure analysis over the Scheme parse (imports only
// `sugarcoat-render`, so it stays inside this runtime-free lens closure).
export { paramHints, paramHintsSugarcoat, type ParamHint } from "./param-hints.js";
