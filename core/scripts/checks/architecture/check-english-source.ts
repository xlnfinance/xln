import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CYRILLIC = /[\u0400-\u04ff]/u;
const CHECKED_EXTENSION = /\.(?:cjs|js|json|md|mjs|py|sol|svelte|ts|tsx)$/u;

// These files are multilingual product data, not the language of the
// implementation or its canonical documentation. Keep this list exact: a
// directory-wide exemption would let Russian comments leak into source code.
const MULTILINGUAL_FILES = new Set([
  'debates/server.ts',
  'debates/tests/viral-surface.spec.ts',
  'frontend/src/lib/ai/xln-guide-context.ts',
  'frontend/src/lib/components/Landing/content.ts',
  'frontend/src/lib/i18n/index.ts',
  'frontend/src/lib/i18n/locales/ru.json',
]);

// Bundled browser runtime embeds compressed BIP39 tables whose opaque byte
// strings decode as Cyrillic under a UTF-8 scan. Source of truth is
// brainvault/; do not treat the artifact as editable prose.
const BUNDLED_ARTIFACT_FILES = new Set([
  'ui/public/runtime.js',
]);

// External projects retain their own source-language policy. Root XLN gates
// must not classify their implementation or documentation as XLN source.
const EXCLUDED_PREFIXES = ['.archive/', 'ai/', 'brainvault/'];

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean);

const violations: string[] = [];
for (const file of trackedFiles) {
  if (!CHECKED_EXTENSION.test(file)) continue;
  // Path-only refactors leave deleted entries in `git ls-files` until the
  // replacement commit is staged. The source-language gate audits files that
  // exist in the candidate tree; a deleted path has no content to classify.
  if (!fs.existsSync(file)) continue;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) continue;
  if (MULTILINGUAL_FILES.has(file)) continue;
  if (BUNDLED_ARTIFACT_FILES.has(file)) continue;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (CYRILLIC.test(line)) violations.push(`${file}:${index + 1}:${line.trim()}`);
  }
}

if (violations.length > 0) {
  console.error('English-only source invariant failed:\n');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `ENGLISH_SOURCE_OK checked=${trackedFiles.length} multilingualAllowlist=${MULTILINGUAL_FILES.size}`,
);
