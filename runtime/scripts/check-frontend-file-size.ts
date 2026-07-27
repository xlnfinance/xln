import { promises } from 'fs';
import path from 'path';
import { compareStableText } from '../protocol/serialization';

type FileSizeViolation = {
  file: string;
  lines: number;
};

const ROOT = process.cwd();
const SOURCE_ROOTS = ['runtime', 'frontend/src', 'tests', 'scripts', 'jurisdictions'];
const MAX_SOURCE_FILE_LINES = 3000;
const CODE_FILE_RE = /\.(svelte|ts|tsx|js|cjs|mjs|css|sol|sh)$/;
const GENERATED_PATH_PARTS = [
  '/node_modules/',
  '/artifacts/',
  '/cache/',
  '/typechain-types/',
  '/build/',
  '/.svelte-kit/',
];

function toRel(abs: string): string {
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

async function walk(absPath: string): Promise<string[]> {
  const stat = await promises.stat(absPath);
  if (stat.isFile()) return [absPath];

  const entries = await promises.readdir(absPath, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(absPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs)));
      continue;
    }
    out.push(abs);
  }
  return out;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

async function main(): Promise<void> {
  const files = (await Promise.all(SOURCE_ROOTS.map(root => walk(path.join(ROOT, root)))))
    .flat()
    .map(toRel)
    .filter(rel => CODE_FILE_RE.test(rel))
    .filter(rel => !rel.endsWith('.d.ts'))
    .filter(rel => !GENERATED_PATH_PARTS.some(part => `/${rel}`.includes(part)));

  const violations: FileSizeViolation[] = [];
  for (const rel of files) {
    const text = await promises.readFile(path.join(ROOT, rel), 'utf8');
    const lines = countLines(text);
    if (lines > MAX_SOURCE_FILE_LINES) {
      violations.push({ file: rel, lines });
    }
  }

  violations.sort((a, b) => b.lines - a.lines || compareStableText(a.file, b.file));

  if (violations.length > 0) {
    console.error(`Source file-size invariant failed: max ${MAX_SOURCE_FILE_LINES} lines per handwritten file.\n`);
    for (const violation of violations) {
      console.error(`- ${violation.file}: ${violation.lines} lines`);
    }
    process.exit(1);
  }

  console.log(`Source file-size invariant passed (${files.length} files, max ${MAX_SOURCE_FILE_LINES} lines)`);
}

main().catch(error => {
  console.error('check-source-file-size failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
