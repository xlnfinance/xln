/**
 * Forbid compatibility vocabulary in production source.
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

const SCAN_ROOTS = ['runtime', 'frontend/src'] as const;
const SCAN_EXTENSIONS = ['.ts', '.svelte'] as const;
const SKIP_PATH_FRAGMENTS = [
  '/__tests__/',
  '/generated/',
  '/node_modules/',
  // This checker and its siblings necessarily name the words they forbid.
  'runtime/scripts/checks/policy/check-no-legacy.ts',
  'runtime/scripts/checks/policy/check-no-pre-mainnet-legacy.ts',
  'runtime/scripts/checks/architecture/check-canonical-vocabulary.ts',
  'runtime/scripts/checks/consensus/check-failure-taxonomy-scan.ts',
  'runtime/scripts/checks/contracts/check-onchain-hanko-ast.ts',
  'runtime/scripts/checks/consensus/check-consensus-hanko-scan.ts',
] as const;

const FORBIDDEN = [
  /legacy/i,
  /deprecated/i,
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
] as const;

const ALLOWLIST: readonly Allowance[] = [
  {
    file: 'runtime/jurisdiction/adapter/browservm/browservm-provider.ts',
    match: 'createLegacyTx',
    reason: 'Third-party @ethereumjs/tx export name for pre-EIP-2718 transactions.',
  },
  {
    file: 'runtime/entity/profile/index.ts',
    match: 'assertNoLegacyProfileFields',
    reason: 'Enforcement: rejects pre-canonical profile fields rather than reading them.',
  },
  {
    file: 'runtime/account/crypto.ts',
    match: 'DEPRECATED_SIGNER_PREFIX',
    reason: 'Enforcement: rejection error code for non-numeric signer ids.',
  },
  {
    file: 'frontend/src/lib/security/vaultProtection.ts',
    match: 'legacyKeyId',
    reason: 'BrainVault V1 key derivation; the V1 vault format is a supported protocol input.',
  },
  {
    file: 'frontend/src/lib/components/Landing/content.ts',
    match: 'Legacy',
    reason: 'Marketing copy about incumbent payment rails, not a code path.',
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
    if (SKIP_PATH_FRAGMENTS.some(fragment => path.includes(fragment))) continue;
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
    'NO_LEGACY_VIOLATION: production source may not carry compatibility vocabulary.\n' +
    'Delete the second code path, or add an exact allowlist entry with a reason.\n' +
    violations.join('\n'),
  );
}

console.log(`NO_LEGACY_OK files=${scanned} allowlist=${ALLOWLIST.length}`);
