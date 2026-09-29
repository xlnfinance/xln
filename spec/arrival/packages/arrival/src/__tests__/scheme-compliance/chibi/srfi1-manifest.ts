// Chibi harness v2 — srfi1-manifest.ts: the SRFI-1 corpus's own top-level shape is
// `(define-library (srfi 1 test) (export run-tests) (import …) (begin (define (run-tests)
// BODY…)))` — ONE top-level form, not the flat `test-begin`/`test`/`test-end` sequence
// manifest.ts's classifier expects at the top level (r7rs-tests.scm has no such wrapper).
// `extractSrfi1Body` unwraps it down to BODY — the flat, corpus-ordered sequence of
// `test-begin`/`test`/`let`-block/`test-end` forms — using the SAME structural splitter
// manifest.ts already uses everywhere (`splitTopLevelForms`, re-run over each wrapper
// layer's own inner text, exactly `blockMembers`'s own re-slicing idiom) plus reader-based
// head-symbol identification (`headSymbolName`) to find each wrapper layer's one relevant
// child — never a text/content match. Once BODY is extracted as a `RawForm[]`,
// `buildManifestFromForms` classifies it exactly like a genuine top level (a `let` block
// with nested tests, `test`/`test-error`/`test-values`/`test-assert` heads — all already
// handled generically; nothing SRFI-1-specific reaches manifest.ts).
import fs from "fs";
import path from "path";
import { parse as readerParse } from "../../../reader/parse.js";
import { buildManifestFromForms, headSymbolName, splitTopLevelForms, type Manifest, type RawForm } from "./manifest.js";

export const SRFI1_TEST_PATH = path.resolve(import.meta.dirname, "../../../../vendor/chibi-scheme/lib/srfi/1/test.sld");

/** Re-split `raw`'s own inner content (stripping its outer bracket pair) into child
 *  `RawForm`s, correcting each child's `line` to be ABSOLUTE (relative to the ORIGINAL
 *  corpus text `raw` itself was sliced from — `splitTopLevelForms` numbers lines relative
 *  to whatever text it's handed, so a line computed against a sub-slice starts back at 1
 *  unless corrected). `raw.line` is itself already absolute (by induction: the very first
 *  call passes the top-level splitter's own output, which numbers against the whole file),
 *  so `child.line + raw.line - 1` composes correctly across repeated unwrap levels —
 *  generalizes `blockMembers`'s own `raw.text.slice(1, -1)` re-slicing idiom (manifest.ts),
 *  which stops short of line-correcting since its members share one owning block's
 *  approximate line by design; here the wrapper is exactly 3 levels deep and every body
 *  form gets its own genuine corpus line, worth the few extra lines of arithmetic. */
function children(raw: RawForm): RawForm[] {
  const inner = raw.text.slice(1, -1);
  return splitTopLevelForms(inner).map((c) => ({ text: c.text, line: c.line + raw.line - 1 }));
}

/** The one direct child among `kids` whose parsed datum's head symbol is `head` — throws
 *  loudly (never returns `undefined`) if the wrapper shape doesn't match what this module
 *  expects, so an upstream edit to `test.sld`'s own structure fails LOUD at manifest-build
 *  time instead of silently producing an empty/wrong corpus (the anti-vacuity floor this
 *  harness relies on elsewhere only catches a corpus that's too SMALL, not one built from
 *  the wrong forms entirely). */
async function findChildHeaded(kids: readonly RawForm[], head: string): Promise<RawForm> {
  for (const kid of kids) {
    let parsed;
    try {
      parsed = await readerParse(kid.text);
    } catch {
      continue;
    }
    if (parsed.length === 1 && headSymbolName(parsed[0]) === head) return kid;
  }
  throw new Error(
    `chibi srfi-1 corpus: expected a direct child headed '${head}' among [${kids.map((k) => k.text.slice(0, 40)).join(", ")}]`,
  );
}

/** Structurally unwrap `test.sld` down to `run-tests`'s body: `define-library` → its
 *  `begin` child → that `begin`'s `define` child → the define's body (everything past the
 *  `(run-tests)` signature, mirroring manifest.ts's own function-shorthand-define
 *  convention). */
export async function extractSrfi1Body(corpusPath: string): Promise<RawForm[]> {
  const text = fs.readFileSync(corpusPath, "utf-8");
  const topForms = splitTopLevelForms(text);
  if (topForms.length !== 1) {
    throw new Error(`chibi srfi-1 corpus: expected exactly 1 top-level form (define-library), got ${topForms.length}`);
  }
  const [defineLibrary] = topForms;
  const beginForm = await findChildHeaded(children(defineLibrary), "begin");
  const runTestsDefine = await findChildHeaded(children(beginForm), "define");
  const defineChildren = children(runTestsDefine);
  // defineChildren[0] = `define` (head atom), [1] = `(run-tests)` (the signature) — body
  // starts at index 2.
  return defineChildren.slice(2);
}

/** Build the SRFI-1 corpus's `Manifest` — the sibling entry point `chibi-srfi1.spec.ts`
 *  calls instead of `buildManifest` (which assumes a flat top level). */
export async function buildSrfi1Manifest(): Promise<Manifest> {
  const rawForms = await extractSrfi1Body(SRFI1_TEST_PATH);
  return buildManifestFromForms(SRFI1_TEST_PATH, rawForms);
}
