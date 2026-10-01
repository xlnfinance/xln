// The gate's counts that need the shape of the code, joined from the facts ast-grep reports (facts.yml): how long a
// declaration is, which names a file exports, and who imports them. A use of an export is an import that resolves to
// its file, so a same-spelled local in another file is no user; a type may also be used by its own file, outside its
// own declaration. An export form the gate cannot name is a hit of its own, never a silent pass.
import { posix } from "node:path";
import type { AstFact } from "./ast.ts";
import { MAX_DECLARATION_LINES, type Hit } from "./counts.ts";

const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx"] as const;
export const isSource = (file: string): boolean => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));
export const isTest = (file: string): boolean => /\.test\.(ts|mts|cts|tsx)$/.test(file);

const byRule = (facts: readonly AstFact[], ruleId: string): readonly AstFact[] => facts.filter((fact) => fact.ruleId === ruleId);
const capture = (fact: AstFact, name: string): string => fact.metaVariables?.single?.[name]?.text ?? "";
const holds = (outer: AstFact, inner: AstFact): boolean =>
  outer.file === inner.file && outer.range.byteOffset.start <= inner.range.byteOffset.start && inner.range.byteOffset.end <= outer.range.byteOffset.end;
const enclosing = (inner: AstFact, outers: readonly AstFact[]): AstFact | undefined => outers.find((outer) => holds(outer, inner));

const longDeclarations = (facts: readonly AstFact[], gated: ReadonlySet<string>): readonly Hit[] =>
  byRule(facts, "decl")
    .filter((fact) => gated.has(fact.file) && fact.range.end.line - fact.range.start.line + 1 > MAX_DECLARATION_LINES)
    .map((fact): Hit => ({ ruleId: "long-declaration", file: fact.file }));

export const resolveImport = (from: string, source: string, listed: ReadonlySet<string>): string | undefined => {
  const base = posix.normalize(posix.join(posix.dirname(from), source));
  const candidates = [base, ...SOURCE_EXTENSIONS.flatMap((extension) => [`${base}${extension}`, `${base}/index${extension}`])];
  return source.startsWith(".") ? candidates.find((candidate) => listed.has(candidate)) : undefined;
};

type Import = Readonly<{ importer: string; target: string; name: string }>;

// The module a fact sits in the import or export statement of, resolved to a listed file.
const targetOf = (fact: AstFact, statements: ReadonlyMap<string, readonly AstFact[]>, listed: ReadonlySet<string>): string | undefined => {
  const statement = enclosing(fact, statements.get(fact.file) ?? []);
  const target = statement === undefined ? undefined : resolveImport(fact.file, capture(statement, "SOURCE").slice(1, -1), listed);
  return target === fact.file ? undefined : target;
};

const importsOf = (facts: readonly AstFact[], statements: ReadonlyMap<string, readonly AstFact[]>, listed: ReadonlySet<string>): readonly Import[] =>
  byRule(facts, "specifier").flatMap((spec) => {
    const target = targetOf(spec, statements, listed);
    return target === undefined ? [] : [{ importer: spec.file, target, name: capture(spec, "NAME") }];
  });

// `import * as ns` of a gated file names no export, so every export of it would pass as used: it is a hit itself.
const namespaceImports = (facts: readonly AstFact[], statements: ReadonlyMap<string, readonly AstFact[]>, listed: ReadonlySet<string>, gated: ReadonlySet<string>): readonly Hit[] =>
  byRule(facts, "namespace").flatMap((fact) => {
    const target = targetOf(fact, statements, listed);
    return target !== undefined && gated.has(target) ? [{ ruleId: "namespace-import", file: fact.file }] : [];
  });

type Export = Readonly<{ file: string; name: string; scope: AstFact; ownUse: boolean }>;

// A declared type is also used when its own file names it outside its own declaration; a listed one is used by others only.
const exportsOf = (facts: readonly AstFact[], gated: ReadonlySet<string>): readonly Export[] => {
  const decls = byRule(facts, "decl").filter((decl) => gated.has(decl.file));
  const declared = (ruleId: string, ownUse: boolean): readonly Export[] =>
    byRule(facts, ruleId).flatMap((fact) => {
      const scope = enclosing(fact, decls);
      return scope === undefined ? [] : [{ file: fact.file, name: capture(fact, "NAME"), scope, ownUse }];
    });
  const listed = byRule(facts, "specifier-exported").flatMap((fact) => {
    const scope = enclosing(fact, decls);
    return scope === undefined ? [] : [{ file: fact.file, name: fact.text, scope, ownUse: false }];
  });
  return [...declared("value-name", false), ...declared("type-name", true), ...listed];
};

const deadExports = (facts: readonly AstFact[], gated: ReadonlySet<string>, used: ReadonlySet<string>): readonly Hit[] => {
  const refs = byRule(facts, "type-ref");
  const usedInOwnFile = (each: Export): boolean => each.ownUse && refs.some((ref) => ref.file === each.file && ref.text === each.name && !holds(each.scope, ref));
  return exportsOf(facts, gated)
    .filter((each) => !isTest(each.file) && !used.has(`${each.file}\t${each.name}`) && !usedInOwnFile(each))
    .map((each): Hit => ({ ruleId: "unreachable", file: `${each.file} (${each.name})` }));
};

// An export statement with no name the gate can read (`export default`, `export *`, `export declare`), or a declarator
// that binds a pattern, exports something the dead-export check cannot see.
const unsupportedExports = (facts: readonly AstFact[], gated: ReadonlySet<string>): readonly Hit[] => {
  const names = [...byRule(facts, "value-name"), ...byRule(facts, "type-name"), ...byRule(facts, "specifier-exported")];
  const bare = byRule(facts, "decl").filter((decl) => gated.has(decl.file) && decl.text.startsWith("export") && !names.some((name) => holds(decl, name)));
  return [...bare, ...byRule(facts, "unnamed-declarator").filter((fact) => gated.has(fact.file))].map((fact): Hit => ({ ruleId: "unsupported-export", file: fact.file }));
};

// `listed` is every file git lists; `gated` is the subset the tree rules govern.
export const syntaxHits = (facts: readonly AstFact[], listed: ReadonlySet<string>, gated: ReadonlySet<string>): readonly Hit[] => {
  const statements = Map.groupBy(byRule(facts, "source"), (fact) => fact.file);
  const used = new Set(importsOf(facts, statements, listed).map((each) => `${each.target}\t${each.name}`));
  return [
    ...longDeclarations(facts, gated),
    ...unsupportedExports(facts, gated),
    ...namespaceImports(facts, statements, listed, gated),
    ...deadExports(facts, gated, used),
  ];
};
