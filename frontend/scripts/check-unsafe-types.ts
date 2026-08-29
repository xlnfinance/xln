import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

type Finding = {
  file: string;
  line: number;
  kind: 'explicit-any' | 'double-assertion' | 'ts-suppression';
};

const frontendRoot = join(import.meta.dir, '..');
const sourceRoot = join(frontendRoot, 'src');
const scanRoots = [
  sourceRoot,
  join(frontendRoot, 'apps'),
  join(frontendRoot, 'packages'),
  join(frontendRoot, 'config'),
  join(frontendRoot, 'scripts'),
];

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      return target === join(sourceRoot, 'routes', 'ai') ? [] : sourceFiles(target);
    }
    return entry.isFile() && (
      target.endsWith('.ts') || target.endsWith('.tsx') || target.endsWith('.svelte')
    ) ? [target] : [];
  });

const inspectScript = (file: string, sourceText: string, lineOffset: number): Finding[] => {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const findings: Finding[] = [];
  const record = (node: ts.Node, kind: Finding['kind']): void => {
    findings.push({
      file: relative(frontendRoot, file),
      line: lineOffset + source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
    });
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) record(node, 'explicit-any');
    if (
      ts.isAsExpression(node) &&
      ts.isAsExpression(node.expression) &&
      node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      record(node, 'double-assertion');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};

const inspectFile = (file: string): Finding[] => {
  const text = readFileSync(file, 'utf8');
  const suppressions = text.split(/\r?\n/).flatMap((line, index) =>
    /@ts-(?:ignore|nocheck|expect-error)\b/.test(line)
      ? [{ file: relative(frontendRoot, file), line: index + 1, kind: 'ts-suppression' as const }]
      : [],
  );
  if (!file.endsWith('.svelte')) return [...inspectScript(file, text, 0), ...suppressions];
  const scripts = [...text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  return [
    ...scripts.flatMap((match) => {
      const prefix = text.slice(0, match.index);
      const openingTagLength = match[0].indexOf('>') + 1;
      const lineOffset = prefix.split(/\r?\n/).length - 1 +
        match[0].slice(0, openingTagLength).split(/\r?\n/).length - 1;
      return inspectScript(file, match[1] ?? '', lineOffset);
    }),
    ...suppressions,
  ];
};

const scannedFiles = scanRoots.flatMap(sourceFiles).sort();
const findings = scannedFiles.flatMap(inspectFile);
if (findings.length > 0) {
  console.error('Frontend unsafe TypeScript invariant failed:');
  for (const finding of findings) {
    console.error(`- ${finding.kind} ${finding.file}:${finding.line}`);
  }
  process.exit(1);
}

console.log(`FRONTEND_UNSAFE_TYPES_OK files=${scannedFiles.length} findings=0`);
