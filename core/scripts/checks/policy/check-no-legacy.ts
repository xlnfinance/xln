/**
 * Forbid compatibility vocabulary in all first-party source and tests.
 *
 * XLN is pre-mainnet: there is no deployed population whose data we must keep
 * reading. A word like "legacy" or "backwards compatible" in production is
 * therefore either a second code path that consensus does not exercise, or a
 * silent reader that accepts state the canonical producer never writes. Both
 * are how fail-open behaviour survives review, so the vocabulary itself is
 * banned and every genuine exception is named below.
 *
 * The allowlist is exact: a file path plus the literal substring that is
 * permitted in it. Widening it is a design decision, not a formatting fix.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Allowance = {
  /** Exact repo-relative path. */
  file: string;
  /** Literal substring permitted on a matching line. */
  match: string;
  /** Why this is permanent rather than debt. */
  reason: string;
};

const SCAN_ROOTS = [
  '.github',
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
  'core',
  'scripts',
  'tests',
  'tools',
  'ui/src',
] as const;
const SCAN_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
  '.svelte',
  '.sol',
  '.sh',
  '.py',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
] as const;
const SKIP_PATH_FRAGMENTS = [
  '/generated/',
  '/node_modules/',
  '/artifacts/',
  '/typechain/',
  '/cache/',
  '/dist/',
  '/build/',
  '/target/',
  '/forge-out/',
  '/build-tron/',
  '/jurisdictions/lib/',
  '/static/',
  '/packages/npm/xlnfinance/app/',
  // Immutable historical evidence records the names that existed at release
  // time. It is never decoded as live product configuration.
  '/docs/releases/data/',
  '/audits/evidence/',
  // This checker and its siblings necessarily name the words they forbid.
  'core/scripts/checks/policy/check-no-legacy.ts',
  'core/scripts/checks/architecture/check-canonical-vocabulary.ts',
  'core/scripts/checks/consensus/check-canonical-identity-scan.ts',
  'core/scripts/checks/consensus/check-failure-taxonomy-scan.ts',
  'core/scripts/checks/contracts/check-onchain-hanko-ast.ts',
  'core/scripts/checks/consensus/check-consensus-hanko-scan.ts',
] as const;

const FORBIDDEN = [
  /legacy/i,
  /deprecated/i,
  /fallback/i,
  /backward\s?compat/i,
  /backwards\s?compat/i,
  /compatibility alias/i,
  // An optional field justified by the age of the data it reads is a
  // compatibility reader wearing a comment.
  /older (?:data|scenario|record|run|client)/i,
  // "Kept for caller compatibility" hid a required parameter that the function
  // deliberately never used, so the signature lied about what the value binds.
  // Anything kept *for* compatibility is kept for no live reason.
  /(?:kept|retained|preserved) for [a-z ]*compat/i,
  /for (?:caller|callsite|call-site|consumer|client) compat/i,
  // A numbered in-house domain or API implies a retained predecessor. There
  // is one canonical producer/reader; testnet cutovers replace it atomically.
  /xln:[^'"\s]+:v[2-9]\b/i,
  /\b(?:const|function|class|interface|type)\s+\w+(?:V|v)[2-9]\b/,
  /['"`][^'"`\n]*\/v[2-9](?:\/|[?'"`])/i,
  // Retired pre-mainnet surfaces are checked here too so compatibility has
  // one owner and one gate.
  /\bprocessJBlockEvents\b/,
  /\bevms\s*:/,
  /\.evms\b/,
] as const;

const ALLOWLIST: readonly Allowance[] = [
  {
    file: 'frontend/svelte.config.js',
    match: "fallback: 'index.html'",
    reason: 'Exact Svelte adapter-static option name for the SPA shell output.',
  },
  {
    file: 'core/__tests__/development/frontend/frontend-check-output.test.ts',
    match: "fallback: 'index.html'",
    reason: 'Pins the exact required Svelte adapter-static option above.',
  },
  {
    file: 'core/jurisdiction/adapter/browservm/browservm-provider.ts',
    match: 'createLegacyTx',
    reason: 'Third-party @ethereumjs/tx export name for pre-EIP-2718 transactions.',
  },
  {
    file: 'jurisdictions/scripts/verify/verify-public-stack.ts',
    match: 'https://sourcify.dev/server/v2/',
    reason: 'Sourcify owns and requires this external verification API route.',
  },
];

const listFiles = (directory: string): string[] => readdirSync(directory, {
  withFileTypes: true,
}).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return listFiles(path);
  return entry.isFile() && SCAN_EXTENSIONS.some(ext => path.endsWith(ext)) ? [path] : [];
});

const isAllowed = (file: string, line: string): boolean =>
  ALLOWLIST.some(entry => entry.file === file && line.includes(entry.match));

const violations: string[] = [];
let scanned = 0;

for (const root of SCAN_ROOTS) {
  for (const path of listFiles(root)) {
    const rootedPath = `/${path.replace(/^\/+/, '')}`;
    if (SKIP_PATH_FRAGMENTS.some(fragment => rootedPath.includes(fragment))) continue;
    scanned += 1;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const pattern = FORBIDDEN.find(rule => rule.test(line));
      if (!pattern || isAllowed(path, line)) return;
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (violations.length > 0) {
  throw new Error(
    'NO_LEGACY_VIOLATION: first-party source may not carry compatibility vocabulary.\n' +
    'Delete the second code path, or add an exact allowlist entry with a reason.\n' +
    violations.join('\n'),
  );
}

console.log(`NO_LEGACY_OK files=${scanned} allowlist=${ALLOWLIST.length}`);
