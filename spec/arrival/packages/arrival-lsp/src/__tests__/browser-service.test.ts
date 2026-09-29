// browser-service — the fs-less entry proof.
//
// `createBrowserSchemeLanguageService` must answer the same queries as the Node
// service while touching NEITHER `node:fs` NOR `ts.sys`: prelude + TS default
// libs come from direct Vite glob loads (at bundle time). Running it under vitest
// (Node) is exactly the point — the service itself cannot tell; the environment
// object is the only difference. The drift guard verifies that glob-loaded
// content matches what `getPreludeFiles()` reads off disk.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { getPreludeFiles, PROGRAM_FILE } from "@inhuman.tools/arrival-internals-types-prelude";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createBrowserSchemeLanguageService, TS_LIB_FILES } from "../browser.js";
import { stripGlobalValues } from "../ts-lib-strip.js";
import { TS_DEFAULT_LIB, TS_LIB_FILE_NAMES } from "../ts-libs.generated.js";

// The prelude-loader drift guard (glob map == disk map) now lives in the
// type-prelude package (both loaders are its own); here we only prove the browser
// SERVICE answers with no fs.

describe("stripped-lib world — internal coherence guard", () => {
  // The value-strip must leave the lib chain SELF-CONSISTENT: dropping a value
  // (e.g. `Symbol`, which computed properties like `[Symbol.iterator]()` resolve
  // through) can silently degrade type relations elsewhere in the chain —
  // invisible through the program-file-only public API. This walks EVERY file
  // of the world and demands zero internal diagnostics.
  it("the prelude + stripped libs compile with zero internal diagnostics", () => {
    const files = getPreludeFiles();
    const libs = new Map(TS_LIB_FILES);
    files.set(PROGRAM_FILE, "export {};\n");
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...files.keys()],
      getScriptVersion: () => "1",
      getScriptSnapshot: (fn) => {
        const t = files.get(fn) ?? libs.get(fn);
        return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
      },
      getCurrentDirectory: () => "/",
      getCompilationSettings: () => ({
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        lib: ["lib.es2022.d.ts"],
        types: [],
        skipLibCheck: false,
      }),
      getDefaultLibFileName: () => TS_DEFAULT_LIB,
      fileExists: (fn) => files.has(fn) || libs.has(fn),
      readFile: (fn) => files.get(fn) ?? libs.get(fn),
    };
    const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
    const program = svc.getProgram()!;
    const offenders: string[] = [];
    for (const sf of program.getSourceFiles()) {
      const ds = [...program.getSemanticDiagnostics(sf), ...program.getSyntacticDiagnostics(sf)];
      if (ds.length > 0)
        offenders.push(`${sf.fileName}: ${ts.flattenDiagnosticMessageText(ds[0]!.messageText, " ").slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
    expect(program.getGlobalDiagnostics()).toEqual([]);
  });
});

describe("browser language service — same answers, no fs", () => {
  const ls = createBrowserSchemeLanguageService();

  it("(car 5) → the same 2345 bite on the `5`, in Scheme coordinates", () => {
    const scheme = `(define z (car 5))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(scheme.slice(d.start, d.start + d.length)).toBe("5");
    expect(d.severity).toBe("error");
    expect(d.code).toBe(2345);
  });

  it("a clean program → 0 diagnostics (the bundled lib chain resolves)", () => {
    // A global error (e.g. an unresolvable `lib.es2022.d.ts`) would surface here.
    expect(ls.getSemanticDiagnostics(`(define xs (list 1 2 3))\n(car xs)`)).toHaveLength(0);
  });

  it("hover answers with the inferred type", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const info = ls.getQuickInfoAtPosition(scheme, scheme.lastIndexOf("xs") + 1);
    expect(info).not.toBeNull();
    // Fixed-arity list → TS tuple (PRE list.d.ts); List<> is the homogeneous fallthrough.
    expect(info!.displayText).toMatch(/\[number,\s*number,\s*number\]|List<number>/);
  });

  it("completions surface in-scope bindings", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.lastIndexOf("car") + 1).map((e) => e.name));
    expect(names.has("xs")).toBe(true);
  });
});

describe("direct-from-ts lib loading (new path)", () => {
  it("manifest contains the expected root and a reasonable number of transitive libs", () => {
    expect(TS_DEFAULT_LIB).toBe("lib.es2022.d.ts");
    expect(TS_LIB_FILE_NAMES).toContain("lib.es2022.d.ts");
    expect(TS_LIB_FILE_NAMES).toContain("lib.es5.d.ts");
    expect(TS_LIB_FILE_NAMES.length).toBeGreaterThan(40);
  });

  it("browser path produces a stripped map with the same names as the manifest", () => {
    const loadedNames = TS_LIB_FILES.map(([n]) => n);
    expect(loadedNames).toEqual([...TS_LIB_FILE_NAMES]);
  });

  it("stripGlobalValues removes top level var/function decls (except Symbol)", () => {
    const sample = `
interface X {}
declare var console: any;
declare function parseInt(s: string): number;
declare const Symbol: any;
var hidden = 1;
`;
    const stripped = stripGlobalValues("test.d.ts", sample);
    expect(stripped).not.toContain("declare var console");
    expect(stripped).not.toContain("declare function parseInt");
    expect(stripped).not.toContain("var hidden");
    expect(stripped).toContain("interface X");
    expect(stripped).toContain("Symbol");
  });
});
