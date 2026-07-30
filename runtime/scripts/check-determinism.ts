import { promises } from 'node:fs';
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
  'runtime/account',
  'runtime/entity',
  'runtime/jurisdiction',
  'runtime/runtime/frame',
];
const SCAN_FILES = ['runtime/extensions/lending.ts'];
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
  { pattern: /\bgetRandomValues\s*\(/, rule: 'getRandomValues' },
];

// These calls operate only on the live replica envelope or external ingress;
// none contributes bytes to Runtime, Entity, Account, or Jurisdiction state.
// Keep every exception exact so adding another nondeterministic call fails CI.
const ALLOWED_INFRA_CALLS = new Set([
  'runtime/entity/htlc/payment-admission.ts:getRandomValues',
  'runtime/jurisdiction/config.ts:Date.now',
  'runtime/jurisdiction/config.ts:setTimeout',
  'runtime/runtime/frame/process-profile.ts:Date.now',
  'runtime/runtime/frame/start.ts:Date.now',
]);

const toRel = (abs: string): string => path.relative(ROOT, abs).replace(/\\/g, '/');
const isCodeFile = (rel: string): boolean => /\.(ts|tsx|js|jsx)$/.test(rel) && !rel.endsWith('.d.ts');
const shouldSkip = (rel: string): boolean => EXCLUDE_PARTS.some((part) => rel.includes(part));

async function walk(absPath: string): Promise<string[]> {
  const stat = await promises.stat(absPath);
  if (stat.isFile()) return [absPath];

  const entries = await promises.readdir(absPath, { withFileTypes: true });
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
      if (pattern.test(line) && !ALLOWED_INFRA_CALLS.has(`${file}:${rule}`)) {
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
    const text = await promises.readFile(path.join(ROOT, file), 'utf8');
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
  if (process.argv.includes('--static-only')) return;
  await runDeterminismTests();
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.log('check-determinism failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
