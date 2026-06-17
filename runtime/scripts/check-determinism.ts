import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runDeterminismTests } from '../scenarios/determinism-test';

type Violation = {
  file: string;
  line: number;
  rule: string;
  snippet: string;
};

const ROOT = process.cwd();
const SCAN_ROOTS = [
  'runtime/account-tx',
  'runtime/entity-tx',
];
const SCAN_FILES = [
  'runtime/account-consensus.ts',
  'runtime/entity-consensus.ts',
  'runtime/entity-crontab.ts',
  'runtime/lending.ts',
];
const EXCLUDE_PARTS = [
  '/__tests__/',
  '/typechain/',
];

const BANNED_PATTERNS: Array<{ pattern: RegExp; rule: string }> = [
  { pattern: /\bDate\.now\s*\(/, rule: 'Date.now' },
  { pattern: /\bnew\s+Date\s*\(/, rule: 'new Date' },
  { pattern: /\bMath\.random\s*\(/, rule: 'Math.random' },
  { pattern: /\bperformance\.now\s*\(/, rule: 'performance.now' },
  { pattern: /\bsetTimeout\s*\(/, rule: 'setTimeout' },
  { pattern: /\bsetInterval\s*\(/, rule: 'setInterval' },
  { pattern: /\brandomBytes\s*\(/, rule: 'randomBytes' },
  { pattern: /\brandomUUID\s*\(/, rule: 'randomUUID' },
];

const toRel = (abs: string): string => path.relative(ROOT, abs).replace(/\\/g, '/');
const isCodeFile = (rel: string): boolean => /\.(ts|tsx|js|jsx)$/.test(rel) && !rel.endsWith('.d.ts');
const shouldSkip = (rel: string): boolean => EXCLUDE_PARTS.some((part) => rel.includes(part));

async function walk(absPath: string): Promise<string[]> {
  const stat = await fs.stat(absPath);
  if (stat.isFile()) return [absPath];

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(absPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(abs));
      continue;
    }
    files.push(abs);
  }
  return files;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

function findViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    for (const { pattern, rule } of BANNED_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file,
          line: index + 1,
          rule,
          snippet: line.trim(),
        });
      }
    }
  });
  return violations;
}

async function listTargetFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(ROOT, root);
    files.push(...await walk(abs));
  }
  for (const file of SCAN_FILES) {
    files.push(path.join(ROOT, file));
  }
  return [...new Set(files.map(toRel))]
    .filter(isCodeFile)
    .filter((rel) => !shouldSkip(rel))
    .sort();
}

async function runStaticDeterminismGuard(): Promise<void> {
  const files = await listTargetFiles();
  const violations: Violation[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(ROOT, file), 'utf8');
    violations.push(...findViolations(file, text));
  }

  if (violations.length > 0) {
    console.error('RJEA determinism guard failed. Use env.timestamp / deterministic seeds only.\n');
    for (const violation of violations) {
      console.error(`- ${violation.file}:${violation.line} [${violation.rule}] ${violation.snippet}`);
    }
    throw new Error(`static determinism guard found ${violations.length} violation(s)`);
  }

  console.log(`Static determinism guard passed (${files.length} files scanned)`);
}

async function main(): Promise<void> {
  await runStaticDeterminismGuard();
  await runDeterminismTests();
}

main().catch((error) => {
  console.log('check-determinism failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
