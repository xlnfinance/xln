import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CYRILLIC = /[\u0400-\u04ff]/u;
const CHECKED_EXTENSION = /\.(?:cjs|js|json|md|mjs|py|sol|svelte|ts|tsx)$/u;

// These files are multilingual product data, not the language of the
// implementation or its canonical documentation. Keep this list exact: a
// directory-wide exemption would let Russian comments leak into source code.
const MULTILINGUAL_FILES = new Set([
  // Preserve the original external-review quotations, including their language.
  'design/review/2026-09-06-b02/openrouter_deepseek_deepseek-v4-flash-vision-exp.desktop-dark.json',
  'design/review/2026-09-06-b02/summary.md',
  'docs/evidence/improvement-loop-20260918/quorum-result-02.json',
  'docs/evidence/improvement-loop-20260918/quorum-result-06.json',
  'docs/evidence/improvement-loop-20260918/quorum-result-07.json',
  'docs/evidence/improvement-loop-20260918/quorum-result-11.json',
  'docs/evidence/improvement-loop-20260918/quorum-result.json',
  'docs/evidence/ios-ux-20260918/quorum-result.json',
  // These dated September 13 reports retain the owner's original Russian wording.
  'docs/ios-e2e-video-2026-09-13.md',
  'docs/ios-native-plan.md',
  'docs/ios-storage-recovery-2026-09-13.md',
  'docs/three-hub-stage-2026-09-13.md',
  'docs/xln-gtm-review-2026-09-13.md',
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
const BUNDLED_ARTIFACT_FILES = new Set(['ui/public/runtime.js']);

// External projects retain their own source-language policy. Root XLN gates
// must not classify their implementation or documentation as XLN source.
const EXCLUDED_PREFIXES = ['.archive/', 'ai/', 'brainvault/'];

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean);

const violations: string[] = [];
for (const file of trackedFiles) {
  if (!CHECKED_EXTENSION.test(file)) continue;
  // Path-only refactors leave deleted entries in `git ls-files` until the
  // replacement commit is staged. The source-language gate audits files that
  // exist in the candidate tree; a deleted path has no content to classify.
  if (!fs.existsSync(file)) continue;
  // Owner-authorized Russian publications and their editable sources live here.
  // Other documentation and implementation retain the English-only policy.
  if (file.startsWith('docs/ru/')) continue;
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

console.log(`ENGLISH_SOURCE_OK checked=${trackedFiles.length} multilingualAllowlist=${MULTILINGUAL_FILES.size}`);
