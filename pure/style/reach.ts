// Reachability of xln.ts: every top-level declaration must be reachable from a root, or it is dead code.
// Roots are the names any other .ts file under pure/ mentions (tests, xln_run.ts, benches; not this gate) and the
// names used by top-level statements that declare nothing. An edge runs from a declaration to every top-level name
// it mentions.
// Mentions are matched by name, not by binding, so a name in a comment or a shadowing local keeps a declaration
// alive: the scan can miss dead code, but never reports live code as dead.
import ts from "typescript";
import { readFileSync } from "node:fs";

type Declared = { readonly name: string; readonly node: ts.Node };
export type Unreachable = { readonly name: string; readonly line: number };

const dir = `${import.meta.dir}/..`;
const source = ts.createSourceFile("xln.ts", readFileSync(`${dir}/xln.ts`, "utf8"), ts.ScriptTarget.ES2022, true);

const named = (st: ts.Statement): readonly Declared[] => {
  switch (true) {
    case ts.isVariableStatement(st):
      return st.declarationList.declarations
        .flatMap((d) => (ts.isIdentifier(d.name) ? [{ name: d.name.text, node: d }] : []));
    case ts.isFunctionDeclaration(st):
    case ts.isClassDeclaration(st):
    case ts.isTypeAliasDeclaration(st):
    case ts.isInterfaceDeclaration(st):
    case ts.isEnumDeclaration(st):
      return st.name === undefined ? [] : [{ name: st.name.text, node: st }];
    default:
      return [];
  }
};

const identifiers = (n: ts.Node): readonly string[] =>
  [...(ts.isIdentifier(n) ? [n.text] : []), ...n.getChildren(source).flatMap(identifiers)];

const declared = source.statements.flatMap(named);
const names = new Set(declared.map((d) => d.name));
const edges = new Map(
  [...Map.groupBy(declared, (d) => d.name)].map(([name, ds]) => [
    name,
    ds.flatMap((d) => identifiers(d.node)).filter((x) => names.has(x)),
  ]),
);

const otherFiles = [...new Bun.Glob("**/*.ts").scanSync({ cwd: dir })]
  .filter((f) => f !== "xln.ts" && !["node_modules/", "db-tmp/", "style/"].some((d) => f.startsWith(d)));
const words = (f: string): readonly string[] => readFileSync(`${dir}/${f}`, "utf8").match(/[A-Za-z_$][\w$]*/g) ?? [];
const mentioned = new Set(otherFiles.flatMap(words));
const statementRoots = source.statements.filter((st) => named(st).length === 0 && !ts.isImportDeclaration(st))
  .flatMap(identifiers);
const roots = [...[...names].filter((n) => mentioned.has(n)), ...statementRoots.filter((n) => names.has(n))];

/** Breadth-first closure: each layer adds the names the previous layer mentions and nothing has reached yet. */
const reach = (frontier: readonly string[], seen: ReadonlySet<string>): ReadonlySet<string> => {
  const fresh = [...new Set(frontier)].filter((n) => !seen.has(n));
  return fresh.length === 0 ? seen : reach(fresh.flatMap((n) => edges.get(n) ?? []), new Set([...seen, ...fresh]));
};
const reached = reach(roots, new Set());

export const unreachable: readonly Unreachable[] = declared
  .filter((d) => !reached.has(d.name))
  .map((d) => ({ name: d.name, line: source.getLineAndCharacterOfPosition(d.node.getStart(source)).line + 1 }));
