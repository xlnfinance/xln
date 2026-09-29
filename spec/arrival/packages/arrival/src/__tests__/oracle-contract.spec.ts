// oracle-contract.spec.ts — Track O / node O0: the shared conformance corpus + contract harness.
//
// This is the executable definition of "arrival's Layer-S oracle conforms to the constraint-kernel
// contract." It scans EVERY PREFIX of a corpus of real scout programs (valid / truncated /
// misnested / mid-token) and asserts:
//
//   1. arrival's structural reader (src/oracle/scanner.ts) AGREES with the canonical S-only
//      reference reader (sift/src/sampler/prefix-oracle.ts) on every shared structural field;
//   2. feasible() matches the reference's structural feasibility (no over-close);
//   3. the resumable session and from-scratch analyze AGREE on every prefix (the property the
//      integration plan §A1 names as the acceptance gate for Layer S);
//   4. the char-vs-token gap case: feasible(acceptedPrefix + candidateTokenString) on a mid-symbol
//      prefix like "(net" — structurally possible because the token completes some valid program.
//
// === Why the reference reader is INLINED here, not imported from sift ===
//
// arrival-scheme is a FOUNDATION package; sift (`@sift/membrane`) depends on it, not vice versa.
// `@sift/membrane` is not resolvable from this package, and a relative `../../../../../sift/...`
// import would couple a foundation's test suite to a sibling app's source tree (a layering
// violation). So the canonical S-only reference (`analyzePrefix` from sift's prefix-oracle.ts) is
// reproduced here VERBATIM, attributed below. The corpus is the single-sourced bridge: if sift's
// reference and this inlined copy ever drift, the fix is to re-sync this block from prefix-oracle.ts.
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scan, structuralScanner } from "../oracle/scanner.js";
import { makeOracle } from "../oracle/index.js";
import { makeOracleEnv } from "../oracle/env.js";
import { AmbientRuntime, type AmbientValue } from "../env/AmbientRuntime.js";

// ---------------------------------------------------------------------------------------------
// CANONICAL REFERENCE — verbatim copy of sift/src/sampler/prefix-oracle.ts `analyzePrefix`.
// Do not edit independently; re-sync from prefix-oracle.ts if that file changes.
// ---------------------------------------------------------------------------------------------
interface RefState {
  depth: number;
  inString: boolean;
  inComment: boolean;
  midToken: boolean;
  position: "top" | "operator" | "argument";
  closeable: boolean;
  closeSuffix: string;
  overClosed: boolean;
}
const REF_OPEN = new Set(["(", "[", "{"]);
const REF_CLOSE = new Set([")", "]", "}"]);
function refAnalyze(src: string): RefState {
  const elems: number[] = [];
  let depth = 0;
  let min = 0;
  let inString = false;
  let inComment = false;
  let blockComment = 0;
  let esc = false;
  let midToken = false;
  const completeToken = () => {
    if (midToken) {
      midToken = false;
      if (elems.length > 0) elems[elems.length - 1]++;
    }
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inString) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (blockComment > 0) {
      if (c === "#" && src[i + 1] === "|") {
        blockComment++;
        i++;
      } else if (c === "|" && src[i + 1] === "#") {
        blockComment--;
        i++;
      }
      continue;
    }
    if (inComment) {
      if (c === "\n") inComment = false;
      continue;
    }
    if (c === '"') {
      completeToken();
      inString = true;
      continue;
    }
    if (c === ";") {
      completeToken();
      inComment = true;
      continue;
    }
    if (c === "#" && src[i + 1] === "|") {
      completeToken();
      blockComment = 1;
      i++;
      continue;
    }
    if (REF_OPEN.has(c)) {
      completeToken();
      depth++;
      elems.push(0);
      continue;
    }
    if (REF_CLOSE.has(c)) {
      completeToken();
      depth--;
      if (depth < min) min = depth;
      elems.pop();
      if (elems.length > 0) elems[elems.length - 1]++;
      continue;
    }
    if (/\s/.test(c)) {
      completeToken();
      continue;
    }
    midToken = true;
  }
  const inText = inString || inComment || blockComment > 0;
  const frameElems = elems.length > 0 ? elems[elems.length - 1]! : -1;
  let position: RefState["position"];
  if (depth === 0) position = "top";
  else position = frameElems === 0 ? "operator" : "argument";
  return {
    depth,
    inString,
    inComment: inComment || blockComment > 0,
    midToken,
    position,
    closeable: depth === 0 && !inText,
    closeSuffix: depth > 0 ? ")".repeat(depth) : "",
    overClosed: min < 0,
  };
}
// --- end canonical reference ---------------------------------------------------------------------

function prefixesOf(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i <= s.length; i++) out.push(s.slice(0, i));
  return out;
}

function loadCorpus(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "fixtures", "scout-corpus.scm"), "utf8");
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith(";"));
}

const CORPUS = loadCorpus();

describe("oracle Layer-S — corpus loaded", () => {
  it("has a non-trivial corpus", () => {
    expect(CORPUS.length).toBeGreaterThan(20);
  });
});

describe("oracle Layer-S — agrees with the canonical reference on every prefix", () => {
  it.each(CORPUS)("agrees on all prefixes of %j", (entry) => {
    for (const prefix of prefixesOf(entry)) {
      const ref = refAnalyze(prefix);
      const got = scan(prefix);
      const ctx = JSON.stringify(prefix);
      expect(got.depth, `depth @ ${ctx}`).toBe(ref.depth);
      expect(got.inString, `inString @ ${ctx}`).toBe(ref.inString);
      expect(got.inComment, `inComment @ ${ctx}`).toBe(ref.inComment);
      expect(got.midToken, `midToken @ ${ctx}`).toBe(ref.midToken);
      expect(got.position, `position @ ${ctx}`).toBe(ref.position);
      expect(got.closeable, `closeable @ ${ctx}`).toBe(ref.closeable);
      expect(got.closeSuffix, `closeSuffix @ ${ctx}`).toBe(ref.closeSuffix);
      expect(got.overClosed, `overClosed @ ${ctx}`).toBe(ref.overClosed);
    }
  });
});

describe("oracle Layer-S — feasible() matches structural feasibility (no over-close)", () => {
  it.each(CORPUS)("feasible matches reference on all prefixes of %j", (entry) => {
    for (const prefix of prefixesOf(entry)) {
      const ref = refAnalyze(prefix);
      expect(structuralScanner.feasible(prefix), `feasible @ ${JSON.stringify(prefix)}`).toBe(!ref.overClosed);
    }
  });
});

describe("oracle Layer-S — analyze() exposes the full contract surface with graceful Σ/T", () => {
  it.each(CORPUS)(
    "Σ/T degrade gracefully on every prefix of %j (validSymbols=null, expectedType=null, produces=true)",
    (entry) => {
      for (const prefix of prefixesOf(entry)) {
        const st = structuralScanner.analyze(prefix);
        expect(st.validSymbols()).toBeNull();
        expect(st.expectedType()).toBeNull();
        expect(st.produces("anything", "AnyType")).toBe(true);
        expect(st.validClasses()).toBeInstanceOf(Set);
      }
    },
  );

  // INVARIANT: appending closeSuffix to a well-nested, non-truncated prefix always
  // closes it to depth 0. Only well-nested, non-text-truncated entries are repairable
  // by appending closeSuffix — the corpus is pre-filtered to that subset (a row-
  // conditional skip on the full CORPUS would otherwise report a vacuous pass for
  // every truncated/in-text entry; per the it.each protocol, filter the row set
  // instead of branching inside the row).
  const REPAIRABLE = CORPUS.filter((entry) => {
    const st = structuralScanner.analyze(entry);
    return !st.overClosed && !st.inString && !st.inComment;
  });
  it.each(REPAIRABLE)("closeSuffix actually closes %j (appending it reaches depth 0 / closeable)", (entry) => {
    const st = structuralScanner.analyze(entry);
    const repaired = entry + st.closeSuffix;
    expect(scan(repaired).depth, `depth after repair of ${JSON.stringify(entry)}`).toBe(0);
  });

  it.each(CORPUS)("validClasses gates `end`/`close` correctly on every prefix of %j", (entry) => {
    for (const prefix of prefixesOf(entry)) {
      const st = structuralScanner.analyze(prefix);
      const classes = st.validClasses();
      expect(classes.has("end")).toBe(st.closeable);
      if (!st.inString && !st.inComment) {
        expect(classes.has("close")).toBe(st.depth > 0);
      }
    }
  });
});

describe("oracle Layer-S — resumable session agrees with from-scratch analyze (the §A1 property)", () => {
  it.each(CORPUS)("session === analyze on every prefix of %j", (entry) => {
    const session = structuralScanner.session!();
    for (let i = 0; i < entry.length; i++) {
      session.advance(entry[i]!);
      const prefix = entry.slice(0, i + 1);
      const fromScratch = structuralScanner.analyze(prefix);
      const live = session.state;
      const ctx = JSON.stringify(prefix);
      expect(live.depth, `depth @ ${ctx}`).toBe(fromScratch.depth);
      expect(live.inString, `inString @ ${ctx}`).toBe(fromScratch.inString);
      expect(live.inComment, `inComment @ ${ctx}`).toBe(fromScratch.inComment);
      expect(live.midToken, `midToken @ ${ctx}`).toBe(fromScratch.midToken);
      expect(live.position, `position @ ${ctx}`).toBe(fromScratch.position);
      expect(live.formKind, `formKind @ ${ctx}`).toBe(fromScratch.formKind);
      expect(live.strict, `strict @ ${ctx}`).toBe(fromScratch.strict);
      expect(live.closeable, `closeable @ ${ctx}`).toBe(fromScratch.closeable);
      expect(live.closeSuffix, `closeSuffix @ ${ctx}`).toBe(fromScratch.closeSuffix);
      expect(live.overClosed, `overClosed @ ${ctx}`).toBe(fromScratch.overClosed);
      expect(session.lastClosed).toBeNull();
      expect(session.failed).toBe(false);
    }
  });

  it("clone() branches with no shared mutable state", () => {
    const base = structuralScanner.session!("(filter signable");
    const branch = base.clone();
    branch.advance(" flows)");
    expect(branch.state.closeable).toBe(true);
    expect(base.state.closeable).toBe(false);
    expect(base.state.depth).toBe(1);
  });
});

describe("oracle Layer-S — char-vs-token gap (the load-bearing subtlety)", () => {
  it("feasible(acceptedPrefix + candidateTokenString) on a mid-symbol prefix like '(net'", () => {
    expect(structuralScanner.feasible("(net")).toBe(true);
    expect(structuralScanner.feasible("(net" + "work")).toBe(true);
    expect(structuralScanner.feasible("(network)")).toBe(true);
    expect(structuralScanner.analyze("(network)").closeable).toBe(true);
    const mid = structuralScanner.analyze("(net");
    expect(mid.midToken).toBe(true);
    expect(mid.position).toBe("operator"); // the head of the form is being typed
    expect(mid.closeable).toBe(false);
    expect(mid.validClasses().has("end")).toBe(false);
  });

  it("an over-close is infeasible (the one structurally-rejected case)", () => {
    expect(structuralScanner.feasible(")")).toBe(false);
    expect(structuralScanner.feasible("(a))")).toBe(false);
    expect(structuralScanner.feasible("(a)")).toBe(true);
  });
});

describe("oracle Layer-S — formKind / strict (arrival-only contract additions)", () => {
  it("top level is top + strict", () => {
    const st = structuralScanner.analyze("");
    expect(st.formKind).toBe("top");
    expect(st.strict).toBe(true);
  });

  it("a quoted form is quote + lazy (Σ/T off)", () => {
    const st = structuralScanner.analyze("'(a ");
    expect(st.formKind).toBe("quote");
    expect(st.strict).toBe(false);
  });

  it("a (quote …) form is quote + lazy", () => {
    const st = structuralScanner.analyze("(quote (a ");
    expect(st.formKind).toBe("quote");
    expect(st.strict).toBe(false);
  });

  it("an if branch is a lazy-arm", () => {
    const st = structuralScanner.analyze("(if cond ");
    expect(st.formKind).toBe("lazy-arm");
    expect(st.strict).toBe(false);
  });

  it("an ordinary application argument is strict", () => {
    const st = structuralScanner.analyze("(+ 1 ");
    expect(st.formKind).toBe("application");
    expect(st.strict).toBe(true);
  });

  it("the operator slot of an application is strict application", () => {
    const st = structuralScanner.analyze("(");
    expect(st.position).toBe("operator");
    expect(st.formKind).toBe("application");
  });
});

// =================================================================================================
// Layer Σ (O2) — bound-symbol masking.
//
// Σ refines the `atom` class into the SET OF BOUND IDENTIFIERS legal at the cursor: boundSymbols()
// (from the injected discovery env) ∪ scope-locals (the prefix's own let/lambda/define binders),
// position-filtered (operator ⇒ callables, argument ⇒ any). With no env, Σ degrades to null — the
// Layer-S contract — which the 109 cases above already prove holds (validSymbols()=null there).
// =================================================================================================

/** A tiny discovery env with a callable builtin (`car`), a callable operator (`+`), and a
 *  non-callable value (`flows`). Σ sources boundSymbols()/isCallable() from this via makeOracleEnv. */
function sigmaEnv(): AmbientRuntime {
  // W8: oracle Σ filters operator heads via is_applyable — bare host fns are not callables.
  const fn = new ANativeProcedure({
    name: "id",
    arity: { min: 0, max: null },
    contract: undefined,
    impl: (args) => args[0] as never,
  });
  return AmbientRuntime.root("sigma-test", {
    car: fn,
    "+": fn,
    flows: 42 as unknown as AmbientValue,
  });
}

describe("oracle Layer-Σ — graceful degradation when no env is injected", () => {
  it.each(["", "(", "(car ", "(let ((x 1)) (+ x ", "'(a "])(
    "makeOracle() (no env) keeps Σ null on shape %j — identical to the Layer-S scanner",
    (prefix) => {
      const oracle = makeOracle();
      expect(oracle.analyze(prefix).validSymbols(), `Σ @ ${JSON.stringify(prefix)}`).toBeNull();
    },
  );
});

describe("oracle Layer-Σ — env-backed validSymbols (live when an env is given)", () => {
  it("an env-bound builtin (car) appears at OPERATOR position; a non-callable (flows) does not", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(");
    expect(st.position).toBe("operator");
    const valid = st.validSymbols();
    expect(valid).not.toBeNull();
    expect(valid!.has("car")).toBe(true); // callable ⇒ legal operator
    expect(valid!.has("+")).toBe(true);
    expect(valid!.has("flows")).toBe(false); // non-callable ⇒ illegal operator head
  });

  it("at ARGUMENT position any bound symbol is valid (callable or not)", () => {
    const oracle = makeOracle(sigmaEnv());
    const valid = oracle.analyze("(car ").validSymbols();
    expect(valid).not.toBeNull();
    expect(valid!.has("flows")).toBe(true); // a value is a fine argument
    expect(valid!.has("car")).toBe(true);
  });

  it("a NEVER-bound name is never in the valid set (operator or argument)", () => {
    const oracle = makeOracle(sigmaEnv());
    expect(oracle.analyze("(").validSymbols()!.has("nonesuch")).toBe(false);
    expect(oracle.analyze("(car ").validSymbols()!.has("nonesuch")).toBe(false);
  });

  it("makeOracleEnv enumerates the parent chain and resolves nearest-binding callability", () => {
    const root = AmbientRuntime.root("root", { car: ((x: unknown) => x) as unknown as AmbientValue });
    const child = root.child("child", { y: 7 as unknown as AmbientValue });
    const oe = makeOracleEnv(child);
    expect(oe.boundSymbols().has("car")).toBe(true); // inherited from parent
    expect(oe.boundSymbols().has("y")).toBe(true); // own frame
    expect(oe.isCallable("car")).toBe(true);
    expect(oe.isCallable("y")).toBe(false);
  });
});

describe("oracle Layer-Σ — lexical scope: a let-bound name is in scope inside BODY, absent outside", () => {
  it("in (let ((x …)) BODY), x ∈ validSymbols() inside BODY", () => {
    const oracle = makeOracle(sigmaEnv());
    const inBody = oracle.analyze("(let ((x 1)) (+ x ").validSymbols();
    expect(inBody).not.toBeNull();
    expect(inBody!.has("x")).toBe(true);
  });

  it("x ∉ validSymbols() once the let form has CLOSED (outside its body)", () => {
    const oracle = makeOracle(sigmaEnv());
    const outside = oracle.analyze("(let ((x 1)) (+ x)) (+ ").validSymbols();
    expect(outside).not.toBeNull();
    expect(outside!.has("x")).toBe(false);
  });

  it("a lambda parameter is in scope inside the lambda body", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(lambda (y) (+ y ").validSymbols();
    expect(st!.has("y")).toBe(true);
  });

  it("a curried define binds the function name AND its parameters in the body", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(define (f a b) (+ a ").validSymbols();
    expect(st!.has("f")).toBe(true);
    expect(st!.has("a")).toBe(true);
    expect(st!.has("b")).toBe(true);
  });

  it("a top-level (define name …) is visible to following sibling forms", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(define foo 1) (+ foo ").validSymbols();
    expect(st!.has("foo")).toBe(true);
  });

  it("inside a quote, Σ is disabled (quoted data may name any symbol)", () => {
    const oracle = makeOracle(sigmaEnv());
    expect(oracle.analyze("'(a ").validSymbols()).toBeNull();
    expect(oracle.analyze("(quote (a ").validSymbols()).toBeNull();
  });

  it("at TOP level Σ is null (a free-standing datum head is unconstrained by the bound set)", () => {
    const oracle = makeOracle(sigmaEnv());
    expect(oracle.analyze("").validSymbols()).toBeNull();
    expect(oracle.analyze("(a) ").validSymbols()).toBeNull();
  });
});
