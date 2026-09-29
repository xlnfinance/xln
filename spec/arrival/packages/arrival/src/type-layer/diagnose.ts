// diagnose — type-hint DIAGNOSE primitive: whole-program semantic diagnostics over a
// harvested prelude, mapped back to scheme coordinates.
//
// `createDiagnoseLens` reads `getSemanticDiagnostics` off the single-compile host
// (compile-host.ts), filters to the current-program region, maps each TS offset
// through lower.ts's per-statement span-map, and extracts a structured payload
// (expected/actual/propertyName/candidates/signature). Constrained-decode T
// (getTypeValidCandidates) lives on arrival-lsp, not here.
//
// ADVISORY, NOT BLOCKING: WARNINGS only. Telemetry-first; never gates execution —
// `diagnose` OBSERVES a throwaway program; never rejects or changes what runs.
//
// Context region is a RECIPE: `contextDefines` are prior iterations' `(define …)` SOURCE,
// re-lowered each call (homoiconicity → deterministic types). Diagnostics inside the
// context region fall outside the current-program span-map and drop as unmappable.

import * as ts from "typescript";

import { compile } from "./compile-host.js";
import { lower, type LoweredStatement } from "./lower.js";
import type { HarvestedPrelude } from "./prelude.js";

/** One diagnostic, span-mapped to lowered-unit scheme coordinates. Arrival-native
 *  (tuple spans); manifold spine adapter maps to `MappedDiagnostic` (pre-renders
 *  `signatureText`; leaves `expected`/`actual` as TS strings for render back-translation). */
export interface RawMappedDiagnostic {
  readonly code: number;
  /** Span in lowered-unit scheme coordinates (`forms[i].span` shifted by `programStartOffset`). */
  readonly span: readonly [start: number, end: number];
  /** Raw TS message — INTERNAL ONLY, never rendered (TS never leaks to the surface). */
  readonly tsMessage: string;
  readonly expected?: string; // TS type string when applicable
  readonly actual?: string;
  readonly propertyName?: string; // 2353/2561/2551/2339
  readonly candidateProperties?: readonly string[]; // closed key set (did-you-mean)
  readonly signatureText?: string; // arity 2554/2555; adapter pre-renders to scheme
}

interface DiagnoseUnit {
  /** Offset where the current program begins in the lowered-unit scheme space (= joined
   *  context scheme length; 0 when `contextDefines` is empty). */
  readonly programStartOffset: number;
  /** Per-statement spans of the CURRENT program, in lowered-unit scheme coordinates. */
  readonly statementSpans: readonly (readonly [start: number, end: number])[];
}

export interface DiagnoseLens {
  diagnose(
    programSource: string,
    contextDefines: readonly string[],
    options?: { codes?: readonly number[] },
  ): { unit: DiagnoseUnit; diagnostics: readonly RawMappedDiagnostic[] };
}

/** Build a diagnose lens over a harvested prelude. The prelude text is captured
 *  once; each `diagnose` builds one fresh, private `ts.Program` (stateless per call). */
export function createDiagnoseLens(harvested: HarvestedPrelude): DiagnoseLens {
  const preludeText = harvested.prelude;

  return {
    diagnose(programSource, contextDefines, options) {
      const codes = options?.codes;

      // Context region = recipe: re-lower each prior define's SOURCE. Its scheme
      // length sets programStartOffset; its lowered TS sits between prelude and program in the
      // probe, and its diagnostics drop as unmappable (outside the current-program span-map).
      const contextScheme = contextDefines.join("\n");
      const programStartOffset = contextScheme.length === 0 ? 0 : contextScheme.length + 1; // +1 for the join to the program

      let contextTs: string;
      let programTs: string;
      let statements: readonly LoweredStatement[];
      try {
        contextTs = contextScheme.length === 0 ? "" : lower(contextScheme).ts;
        const loweredProgram = lower(programSource);
        programTs = loweredProgram.ts;
        statements = loweredProgram.statements;
      } catch {
        // Unparseable scheme → no diagnosis (deliver.ts treats a throw as skip:"crash"; here we
        // surface an empty, well-formed result rather than propagate).
        return { unit: { programStartOffset, statementSpans: [] }, diagnostics: [] };
      }

      const statementSpans = statements.map((s): readonly [number, number] => [
        s.schemeSpan[0] + programStartOffset,
        s.schemeSpan[1] + programStartOffset,
      ]);
      const unit: DiagnoseUnit = { programStartOffset, statementSpans };

      const probe = [preludeText, contextTs, programTs].join("\n");
      const tsProgramStart = preludeText.length + 1 + contextTs.length + 1; // prelude \n context \n [program…]

      const compiled = compile(probe);
      if (compiled === null) return { unit, diagnostics: [] };
      const { program, checker, sourceFile } = compiled;

      const diagnostics: RawMappedDiagnostic[] = [];
      for (const d of program.getSemanticDiagnostics(sourceFile)) {
        if (d.start === undefined) continue;
        const local = d.start - tsProgramStart;
        if (local < 0 || local >= programTs.length) continue; // prelude/context region → unmappable, drop

        const stmtIndex = statements.findIndex((s) => s.tsRange[0] <= local && local < s.tsRange[1]);
        if (stmtIndex === -1) continue; // between statements (a separator) → unmappable, drop
        const span = statementSpans[stmtIndex]!;

        const tsMessage = ts.flattenDiagnosticMessageText(d.messageText, " ");
        // Whitelist gate: keep the diagnostic, but skip payload extraction
        // for non-whitelisted codes (select.ts re-filters by whitelist downstream).
        if (codes !== undefined && !codes.includes(d.code)) {
          diagnostics.push({ code: d.code, span, tsMessage });
          continue;
        }
        diagnostics.push({ code: d.code, span, tsMessage, ...extractPayload(checker, sourceFile, d) });
      }
      return { unit, diagnostics };
    },
  };
}

/** Structured payload per code. Every extraction is defensive: an un-locatable node
 *  or a checker miss yields no payload (the diagnostic still carries code + span + message) —
 *  never a crash (payload extraction failure never propagates). */
function extractPayload(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  d: ts.Diagnostic,
): Partial<RawMappedDiagnostic> {
  try {
    const node = nodeAt(sourceFile, d.start!, d.length ?? 0);
    if (node === undefined) return {};
    switch (d.code) {
      case 2345: // argument type mismatch
      case 2322: {
        // assignability mismatch
        const actualType = checker.getTypeAtLocation(node);
        const actual = checker.typeToString(actualType);
        const expected = expectedTypeAt(checker, node);
        return expected === undefined ? { actual } : { expected, actual };
      }
      case 2353: // object literal excess property
      case 2561: // … with a did-you-mean suggestion
      case 2551: // property doesn't exist on a typo'd READ (TS's actual code for this, not 2339)
      case 2339: {
        // property does not exist. lower.ts's ONLY property-read shape is bracket access
        // (`(:key obj)` → `obj["key"]`) — the diagnostic node is then the STRING LITERAL
        // itself, whose `.getText()` includes the quotes; `.text` gives the unescaped bare
        // name (matching the identifier-node case's plain text, e.g. an object-literal
        // kwargs key).
        const propertyName = ts.isStringLiteralLike(node) ? node.text : node.getText(sourceFile);
        const candidateProperties = candidatePropertiesFor(checker, node);
        return candidateProperties === undefined ? { propertyName } : { propertyName, candidateProperties };
      }
      case 2554: // too few arguments
      case 2555: {
        // too many arguments
        const signatureText = calleeSignatureText(checker, node);
        return signatureText === undefined ? {} : { signatureText };
      }
      default:
        return {}; // 2349 (not callable) and any non-whitelisted recognized code → code only
    }
  } catch {
    return {}; // payload extraction threw → drop payload, keep code + span + message
  }
}

/** The innermost node whose range covers the diagnostic's start (preferring the tightest
 *  span that contains `[start, start+length)`). A parse-walk, no checker. */
function nodeAt(sourceFile: ts.SourceFile, start: number, length: number): ts.Node | undefined {
  const end = start + length;
  let best: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    const ns = node.getStart(sourceFile);
    const ne = node.getEnd();
    if (ns <= start && end <= ne) {
      // A tighter (or equal-and-deeper) containing node wins.
      if (best === undefined || ne - ns <= best.getEnd() - best.getStart(sourceFile)) best = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return best;
}

/** The expected (contextual) type at an expression node — the parameter/slot type a mismatch
 *  is measured against. `undefined` when the node is not an expression or has no contextual type. */
function expectedTypeAt(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  if (!ts.isExpression(node)) return undefined;
  const contextual = checker.getContextualType(node);
  return contextual === undefined ? undefined : checker.typeToString(contextual);
}

/** The closed key set a mismatched/unknown property is measured against: the members of the
 *  target OBJECT type (a property node's containing object literal's contextual type, or the
 *  object an access reads). `undefined` when no object type is resolvable. */
function candidatePropertiesFor(checker: ts.TypeChecker, node: ts.Node): readonly string[] | undefined {
  // Excess/unknown property in an object literal: node is the property name; walk to the
  // object literal and read ITS contextual (expected) type's members.
  const objectLiteral = enclosingObjectLiteral(node);
  if (objectLiteral !== undefined) {
    const expected = checker.getContextualType(objectLiteral);
    if (expected !== undefined) return namesOf(checker, expected);
  }
  // Property access `obj.k` / `obj["k"]`: read the accessed object's own type members.
  const accessed = accessedObject(node);
  if (accessed !== undefined) return namesOf(checker, checker.getTypeAtLocation(accessed));
  return undefined;
}

function namesOf(checker: ts.TypeChecker, t: ts.Type): readonly string[] | undefined {
  const props = checker.getPropertiesOfType(t).map((s) => s.getName());
  return props.length > 0 ? props : undefined;
}

function enclosingObjectLiteral(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  for (let p: ts.Node | undefined = node; p !== undefined; p = p.parent) {
    if (ts.isObjectLiteralExpression(p)) return p;
    if (ts.isCallExpression(p) || ts.isStatement(p)) return undefined; // don't escape the call/statement
  }
  return undefined;
}

function accessedObject(node: ts.Node): ts.Expression | undefined {
  for (let p: ts.Node | undefined = node; p !== undefined; p = p.parent) {
    if (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) return p.expression;
    if (ts.isStatement(p)) return undefined;
  }
  return undefined;
}

/** The callee's first call signature as a TS signature string — the arity payload the adapter
 *  pre-renders to scheme. Walks to the enclosing call and reads its callee's signature. */
function calleeSignatureText(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  for (let p: ts.Node | undefined = node; p !== undefined; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const calleeType = checker.getTypeAtLocation(p.expression);
      const sig = checker.getSignaturesOfType(calleeType, ts.SignatureKind.Call)[0];
      return sig === undefined ? undefined : checker.signatureToString(sig);
    }
    if (ts.isStatement(p)) return undefined;
  }
  return undefined;
}
