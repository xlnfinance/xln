// Shared runner helpers for hand-written polyglot spec files under
// src/reader/__tests__/polyglot/ — originally extracted verbatim from the retired
// spec-corpus.test.ts's AST canonicalization / eval-value-fold / error-class
// helpers so focused *.spec.ts suites (inline it.each tables) can reuse the
// exact same conventions the former JSONL-driven corpus runner used.
import { execState } from "../../../eval/generator-exec.js";
import { parse } from "../../parse.js";
import { AJSObject } from "../../../membrane/AJSObject.js";
import { AVector } from "../../../values/primitives/AVector.js";
import { ADict } from "../../../values/primitives/ADict.js";
import { APair } from "../../../values/primitives/APair.js";
import { ASymbol } from "../../../values/primitives/ASymbol.js";
import { AString } from "../../../values/primitives/AString.js";
import { ABool } from "../../../values/primitives/ABool.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { AInexact } from "../../../values/primitives/AInexact.js";
import { theVoid } from "../../../values/primitives/AVoid.js";
import { ANil } from "../../../values/primitives/ANil.js";

/** Canonical AST rendering — the corpus README's convention. Recursive (String(pair)
 *  would render an embedded literal node through its own print protocol, which is the
 *  VALUE face, not the canonical AST face). */
function renderAst(v: unknown): string {
  if (ADict.isDictLiteral(v)) {
    return `{${v.literalForms.map(renderAst).join(" ")}}`;
  }
  if (v instanceof AVector) {
    const body = v.__vector__.map(renderAst).join(" ");
    return v.evalElements ? `[${body}]` : `#(${body})`;
  }
  if (v instanceof APair) {
    const parts: string[] = [];
    let node: unknown = v;
    while (node instanceof APair) {
      parts.push(renderAst(node.car));
      node = node.cdr;
    }
    const tail = node instanceof ANil ? "" : ` . ${renderAst(node)}`;
    return `(${parts.join(" ")}${tail})`;
  }
  if (v instanceof AString) return JSON.stringify(v.toString());
  if (v instanceof ANil) return "()";
  return String(v);
}

/** Eval-result fold — the corpus README's value convention. */
function toJson(v: unknown): unknown {
  if (v == null || v instanceof ANil || v === theVoid) return null;
  if (v instanceof AExact || v instanceof AInexact) return Number(v.valueOf());
  if (v instanceof ABool) return Boolean(v.valueOf());
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof AString) return v.toString();
  if (v instanceof ASymbol) {
    return { $sym: typeof v.__name__ === "string" ? v.__name__ : String(v.valueOf()) };
  }
  if (v instanceof AVector) return v.__vector__.map(toJson);
  if (v instanceof AJSObject || v instanceof ADict) {
    return Object.fromEntries(v.keys().map((k) => [k, toJson(v.get(k))]));
  }
  if (typeof v === "object" && !(v instanceof APair)) {
    // the raw Record `(dict …)` returns
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
  }
  throw new Error(`corpus toJson: unfoldable value ${String(v)} — keep corpus expectations JSON-shaped`);
}

/** The stable error class of a thrown error — own `.code`, or the nearest one up the
 *  cause chain (eval wraps parse/throw sites in ArrivalError layers). */
function errorClass(e: unknown): string | undefined {
  for (let cur = e; cur instanceof Error; cur = cur.cause as Error | undefined) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** The corrected-form hint an errors-as-doors error carries (`EvalError.hint`) — same
 *  cause-chain walk as `errorClass`, since eval wraps the door in ArrivalError layers.
 *  `code` routes, `hint` teaches; a door test asserts both faces. */
function errorHint(e: unknown): string | string[] | undefined {
  for (let cur = e; cur instanceof Error; cur = cur.cause as Error | undefined) {
    const hint = (cur as { hint?: unknown }).hint;
    if (typeof hint === "string" || Array.isArray(hint)) return hint as string | string[];
  }
  return undefined;
}

/** Parse input, return canonical AST string of the last datum. */
export async function readAst(input: string): Promise<string> {
  const datums = await parse(input);
  return renderAst(datums.at(-1));
}

/** Eval input, return JSON-folded value of the last result. */
export async function evalJson(input: string): Promise<unknown> {
  const { values } = await execState(input);
  return toJson(values.at(-1));
}

/** Run a door: eval input and return the thrown error, or `undefined` if it wrongly
 *  succeeded. Bracket-semantic doors are eval-time — the reader accepts every balanced
 *  bracket as data, so only the special form has the frame to reject (and to guess intent). */
export async function evalError(input: string): Promise<unknown> {
  try {
    await evalJson(input);
    return undefined;
  } catch (e) {
    return e;
  }
}

export { errorClass, errorHint };
