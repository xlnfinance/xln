import { promises } from 'fs';
import path from 'path';

type Violation = {
  file: string;
  line: number;
  snippet: string;
};

const ROOT = process.cwd();
// Every first-party executable/source surface is covered. Keep generated,
// vendored and historical trees out of the scan instead of weakening the
// rule with per-file allowlists.
const SCAN_ROOTS = [
  'brainvault',
  'cli',
  'custody',
  'debates',
  'e2e',
  'frontend/src',
  'jurisdictions',
  'native',
  'ops',
  'packages',
  'release',
  'runtime',
  'scripts',
  'tests',
  'tools',
  'ui/src',
];
const EXCLUDE_PARTS = [
  '/node_modules/',
  '/frontend/build/',
  '/frontend/static/',
  '/dist/',
  '/packages/npm/xlnfinance/app/',
  '/test-results/',
  '/playwright-report/',
  '/.logs/',
  '/runtime/typechain/',
  '/jurisdictions/artifacts/',
  '/jurisdictions/cache/',
  '/jurisdictions/lib/',
  '/native/target/',
];
const WEAK_COLLECTION_PATTERN = new RegExp(`\\b${'Weak'}(?:Map|Set)\\b`);

const toRel = (abs: string): string => path.relative(ROOT, abs).replace(/\\/g, '/');
const isCodeFile = (rel: string): boolean => /\.(ts|tsx|js|jsx|svelte)$/.test(rel) && !rel.endsWith('.d.ts');
const shouldSkip = (rel: string): boolean => {
  const rooted = `/${rel.replace(/^\/+/, '')}`;
  return EXCLUDE_PARTS.some((part) => rooted.includes(part));
};

async function walk(absPath: string): Promise<string[]> {
  const stat = await promises.stat(absPath);
  if (stat.isFile()) return [absPath];

  const entries = await promises.readdir(absPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(absPath, entry.name);
    if (entry.isDirectory()) files.push(...await walk(abs));
    else files.push(abs);
  }
  return files;
}

function findViolations(rel: string, text: string): Violation[] {
  const violations: Violation[] = [];
  text.split('\n').forEach((line, index) => {
    if (!WEAK_COLLECTION_PATTERN.test(line)) return;
    violations.push({ file: rel, line: index + 1, snippet: line.trim() });
  });
  return violations;
}

async function main(): Promise<void> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      files.push(...await walk(path.join(ROOT, root)));
    } catch {
      // Missing roots are fine in partial checkouts.
    }
  }

  const violations: Violation[] = [];
  for (const rel of files.map(toRel).filter(isCodeFile).filter((file) => !shouldSkip(file))) {
    const text = await promises.readFile(path.join(ROOT, rel), 'utf8');
    violations.push(...findViolations(rel, text));
  }

  if (violations.length > 0) {
    console.error('Forbidden weak collection usage detected. Use persisted state or explicit lifecycle cleanup.');
    for (const violation of violations) {
      console.error(`- ${violation.file}:${violation.line} ${violation.snippet}`);
    }
    process.exit(1);
  }

  console.log('No weak collection usage found');
}

main().catch((error) => {
  console.error('check-no-weak-collections failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
