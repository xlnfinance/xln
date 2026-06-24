import { promises as fs } from 'fs';
import path from 'path';

type FileSizeViolation = {
  file: string;
  lines: number;
};

const ROOT = process.cwd();
const FRONTEND_ROOT = path.join(ROOT, 'frontend/src');
const MAX_FRONTEND_FILE_LINES = 5000;
const CODE_FILE_RE = /\.(svelte|ts|js)$/;

function toRel(abs: string): string {
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

async function walk(absPath: string): Promise<string[]> {
  const stat = await fs.stat(absPath);
  if (stat.isFile()) return [absPath];

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(absPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(abs));
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
  const files = (await walk(FRONTEND_ROOT))
    .map(toRel)
    .filter((rel) => CODE_FILE_RE.test(rel))
    .filter((rel) => !rel.endsWith('.d.ts'));

  const violations: FileSizeViolation[] = [];
  for (const rel of files) {
    const text = await fs.readFile(path.join(ROOT, rel), 'utf8');
    const lines = countLines(text);
    if (lines > MAX_FRONTEND_FILE_LINES) {
      violations.push({ file: rel, lines });
    }
  }

  violations.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

  if (violations.length > 0) {
    console.error(`Frontend file-size invariant failed: max ${MAX_FRONTEND_FILE_LINES} lines per source file.\n`);
    for (const violation of violations) {
      console.error(`- ${violation.file}: ${violation.lines} lines`);
    }
    process.exit(1);
  }

  console.log(`Frontend file-size invariant passed (${files.length} files, max ${MAX_FRONTEND_FILE_LINES} lines)`);
}

main().catch((error) => {
  console.error('check-frontend-file-size failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
