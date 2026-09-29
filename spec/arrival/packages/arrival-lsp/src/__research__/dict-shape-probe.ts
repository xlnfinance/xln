// Isolate: is the cost the Dict<Pairs> MAPPED-TYPE REMAP, or just object size?
// Compare three ways to carry the SAME W-key shape + W/3 indexed reads:
//   (A) Dict<Pairs>  — the mapped remap `{[P in Pairs[number] as P[0]]:P[1]}`
//   (B) direct object literal type `{ k0:..; k1:.. }`  (what require'd JSON could be)
//   (C) brand carrier JSSchemeDict<{...}> projecting via indexed access only
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRE =
  `${readFileSync(
    path.join(here, "..", "prelude", "types.d.ts"),
    "utf8",
  )}\ntype JSSchemeDict<O> = { readonly __o: O };\n` +
  `declare function gprop<O, K extends keyof O>(o: O, k: K): O[K];\ndeclare function jprop<O, K extends keyof O>(d: JSSchemeDict<O>, k: K): O[K];\n`;

function gen(W: number, mode: "A" | "B" | "C" | "D"): string {
  const entriesArr: string[] = [],
    objLit: string[] = [];
  for (let i = 0; i < W; i++) {
    const v = i % 2 === 0 ? `${i}` : `"s${i}"`;
    entriesArr.push(`["k${i}", ${v}]`);
    objLit.push(`k${i}: ${v}`);
  }
  const reads: string[] = [];
  switch (mode) {
    case "A": {
      const decl = `declare const data: Dict<[${entriesArr.join(", ")}]>;`;
      for (let i = 0; i < W; i += 3) reads.push(`const r${i} = data["k${i}"];`);
      return `${PRE}\n${decl}\n${reads.join("\n")}\nexport {};\n`;
    }
    case "B": {
      const decl = `declare const data: { ${objLit.join("; ")} };`;
      for (let i = 0; i < W; i += 3) reads.push(`const r${i} = data["k${i}"];`);
      return `${PRE}\n${decl}\n${reads.join("\n")}\nexport {};\n`;
    }
    case "D": {
      const decl = `declare const data: { ${objLit.join("; ")} };`;
      for (let i = 0; i < W; i += 3) reads.push(`const r${i} = gprop(data, "k${i}");`);
      return `${PRE}\n${decl}\n${reads.join("\n")}\nexport {};\n`;
    }
    default: {
      const decl = `declare const data: JSSchemeDict<{ ${objLit.join("; ")} }>;`;
      for (let i = 0; i < W; i += 3) reads.push(`const r${i} = jprop(data, "k${i}");`);
      return `${PRE}\n${decl}\n${reads.join("\n")}\nexport {};\n`;
    }
  }
}
function check(src: string): number {
  const files = new Map([["__p.ts", src]]);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (files.has(f) ? ts.ScriptSnapshot.fromString(files.get(f)!) : undefined),
    getCurrentDirectory: () => here,
    getCompilationSettings: () => ({
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      types: [],
      skipLibCheck: true,
    }),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
    readFile: (f) => (files.has(f) ? files.get(f) : ts.sys.readFile(f)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  const t = performance.now();
  svc.getSemanticDiagnostics("__p.ts");
  return performance.now() - t;
}
for (const W of [500, 1000, 2000]) {
  const sa = gen(W, "A"),
    sb = gen(W, "B"),
    sc = gen(W, "C"),
    sd = gen(W, "D");
  const run = (s: string) => {
    check(s);
    const xs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t = performance.now();
      check(s);
      xs.push(performance.now() - t);
    }
    return xs.toSorted((a, b) => a - b)[1];
  };
  console.log(
    `W=${String(W).padStart(4)} | A mapped+index=${run(sa).toFixed(0)}ms | B direct+index=${run(sb).toFixed(0)}ms | D direct+GENERIC-prop=${run(sd).toFixed(0)}ms | C brand=${run(sc).toFixed(0)}ms`,
  );
}
