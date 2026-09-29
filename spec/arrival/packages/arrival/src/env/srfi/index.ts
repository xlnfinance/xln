// @inhuman.tools/arrival/srfi — the unified SRFI palette.
//
// Every SRFI we ship as a scheme-bootstrap capability, importable from ONE subpath:
//   import { allSrfi } from "./srfi/index.js";
//   import srfi1 from "./srfi/srfi-1.js";
//
// Each is a module-singleton `EnvCapability` (prelude, baked `symbols`, or both).
// Assemble individually, pick a subset, or assemble the whole set via `allSrfi`.

import srfi1 from "./srfi-1.js";
import srfi2 from "./srfi-2.js";
import srfi8 from "./srfi-8.js";
import srfi13 from "./srfi-13.js";
import srfi26 from "./srfi-26.js";
import srfi28 from "./srfi-28.js";
import srfi43 from "./srfi-43.js";
import srfi128 from "./srfi-128.js";
import srfi95 from "./srfi-95.js";
import srfi151 from "./srfi-151.js";
import srfi189 from "./srfi-189.js";
import srfi235 from "./srfi-235.js";
import srfiStubs from "./srfi-stubs.js";

/** The whole SRFI set — assemble all, or `.filter()` a capability-scoped subset. */
export const allSrfi = [
  srfi1,
  srfi2,
  srfi8,
  srfi13,
  srfi26,
  srfi28,
  srfi43,
  srfi95,
  srfi128,
  srfi151,
  srfi189,
  srfi235,
  srfiStubs,
] as const;
