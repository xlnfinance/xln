/**
 * Guardrail: forbid ad-hoc delta math in UI/tests/scenarios.
 *
 * Rule:
 * - Do not compute total delta as ondelta + offdelta outside deriveDelta().
 * - Use deriveDelta(delta, isLeft) and its returned fields.
 *
 * Escape hatch:
 * - Add `DELTA_MATH_ALLOWED` in-line for truly intentional cases.
 */

import { promises as fs } from 'fs';
import path from 'path';

type Violation = {
  file: string;
  line: number;
  snippet: string;
  rule: string;
};

const ROOT = process.cwd();
const SCAN_ROOTS = [
  'tests',
  'runtime/scenarios',
  'frontend/src/lib/components/Entity',
];

const EXCLUDE_PATH_PARTS = [
  '/node_modules/',
  '/dist/',
  '/test-results/',
  '/frontend/static/',
  '/runtime/typechain/',
  '/.logs/',
];

const ALLOWED_INLINE_MARKER = 'DELTA_MATH_ALLOWED';

const MANUAL_TOTAL_PATTERNS = [
  /\bondelta\s*\+\s*offdelta\b/,
  /\boffdelta\s*\+\s*ondelta\b/,
];

function toRel(abs: string): string {
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

function shouldSkip(rel: string): boolean {
  return EXCLUDE_PATH_PARTS.some((part) => rel.includes(part));
}

function isCodeFile(rel: string): boolean {
  return /\.(ts|tsx|js|jsx|svelte)$/.test(rel) && !rel.endsWith('.d.ts');
}

async function walk(absDir: string): Promise<string[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(abs));
      continue;
    }
    out.push(abs);
  }
  return out;
}

function findViolations(rel: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes(ALLOWED_INLINE_MARKER)) return;
    for (const pattern of MANUAL_TOTAL_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: rel,
          line: idx + 1,
          snippet: line.trim(),
          rule: 'manual-total-delta',
        });
        return;
      }
    }
  });
  return violations;
}

async function main(): Promise<void> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(ROOT, root);
    try {
      const listed = await walk(abs);
      files.push(...listed);
    } catch {
      // ignore missing scan roots
    }
  }

  const scoped = files
    .map(toRel)
    .filter(isCodeFile)
    .filter((rel) => !shouldSkip(rel));

  const violations: Violation[] = [];
  for (const rel of scoped) {
    const abs = path.join(ROOT, rel);
    const text = await fs.readFile(abs, 'utf8');
    violations.push(...findViolations(rel, text));
  }

  if (violations.length > 0) {
    console.error('❌ Manual delta math detected. Use deriveDelta() instead.\n');
    for (const v of violations) {
      console.error(`- ${v.file}:${v.line} [${v.rule}] ${v.snippet}`);
    }
    process.exit(1);
  }

  console.log(`✅ deriveDelta guard passed (${scoped.length} files scanned)`);
}

main().catch((err) => {
  console.error('❌ check-no-manual-delta-math failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

