#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync } from 'fs';
import { resolve, relative } from 'path';

type Severity = 'fail' | 'warn';

type Finding = {
  ruleId: string;
  severity: Severity;
  message: string;
  matches: Array<{ file: string; line: number; text: string }>;
};

type SccSummary = {
  lines: number;
  blanks: number;
  comments: number;
  code: number;
  complexity: number;
  files: number;
};

type TestRun = {
  label: string;
  command: string;
  ok: boolean;
  output: string;
};

type SoundcheckResult = {
  targetPaths: string[];
  profile: string;
  filesScanned: number;
  scc: SccSummary | null;
  tsc: { ok: boolean; output: string };
  findings: Finding[];
  tests: TestRun[];
  soundness: {
    score: number;
    status: 'pass' | 'warn' | 'fail';
    categories: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
  };
  verdict: 'pass' | 'warn' | 'fail';
};

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.md']);
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.svelte-kit',
  'build',
  'dist',
  '.logs',
  'coverage',
]);

const ORDERBOOK_MARKERS = [
  'runtime/orderbook',
  'runtime/swap-execution.ts',
  'runtime/account-tx/handlers/swap-resolve.ts',
  'runtime/entity-tx/handlers/account.ts',
  'runtime/wal/state-restore.ts',
  'runtime/entity-consensus.ts',
  'runtime/entity-tx/handlers/dispute.ts',
  'runtime/scenarios/swap.ts',
  'runtime/types.ts',
];

function usage(): never {
  console.error('Usage: bun tools/soundcheck.ts [--json] [--skip-tsc] [--skip-tests] <file-or-dir> [...]');
  process.exit(1);
}

function run(cmd: string[], cwd = process.cwd()): { ok: boolean; output: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const output = `${proc.stdout ? new TextDecoder().decode(proc.stdout) : ''}${proc.stderr ? new TextDecoder().decode(proc.stderr) : ''}`.trim();
  return { ok: proc.exitCode === 0, output };
}

function parseArgs(argv: string[]) {
  const targets: string[] = [];
  let json = false;
  let skipTsc = false;
  let skipTests = false;

  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--skip-tsc') skipTsc = true;
    else if (arg === '--skip-tests') skipTests = true;
    else if (arg.startsWith('-')) usage();
    else targets.push(arg);
  }
  if (targets.length === 0) usage();
  return { targets, json, skipTsc, skipTests };
}

function isCodeFile(file: string): boolean {
  for (const ext of CODE_EXTENSIONS) {
    if (file.endsWith(ext)) return true;
  }
  return false;
}

function walkTarget(target: string, out: string[]) {
  const abs = resolve(target);
  if (!existsSync(abs)) return;
  const stat = lstatSync(abs);
  if (stat.isFile()) {
    if (isCodeFile(abs)) out.push(abs);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const entryPath = resolve(abs, entry.name);
    if (entry.isDirectory()) walkTarget(entryPath, out);
    else if (entry.isFile() && isCodeFile(entryPath)) out.push(entryPath);
  }
}

function collectFiles(targets: string[]): string[] {
  const files: string[] = [];
  for (const target of targets) walkTarget(target, files);
  return Array.from(new Set(files)).sort();
}

function detectProfile(targets: string[], files: string[]): string {
  const haystack = [...targets, ...files].map((v) => v.replace(/\\/g, '/'));
  if (haystack.some((entry) => ORDERBOOK_MARKERS.some((marker) => entry.includes(marker)))) return 'orderbook';
  return 'generic';
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

function pushFindingMatch(matches: Finding['matches'], file: string, line: number, text: string) {
  matches.push({
    file: relative(process.cwd(), file),
    line,
    text: text.trim().slice(0, 180),
  });
}

function scanRegex(files: string[], ruleId: string, severity: Severity, message: string, regex: RegExp): Finding | null {
  const matches: Finding['matches'] = [];
  for (const file of files) {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i]!)) pushFindingMatch(matches, file, i + 1, lines[i]!);
    }
  }
  return matches.length > 0 ? { ruleId, severity, message, matches } : null;
}

function scanOrderbookWeakTypes(files: string[]): Finding | null {
  const matches: Finding['matches'] = [];
  const weakTypeRegex = /:\s*any\b|\bas any\b|<any>/;
  const orderbookContextRegex = /\b(orderbook|swap|offer|fillRatio|book)\b/i;

  for (const file of files) {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!weakTypeRegex.test(line)) continue;
      if (
        (file.endsWith('runtime/types.ts') || file.endsWith('runtime/entity-consensus.ts')) &&
        !orderbookContextRegex.test(line)
      ) {
        continue;
      }
      pushFindingMatch(matches, file, i + 1, line);
    }
  }

  return matches.length > 0
    ? {
        ruleId: 'any-keyword',
        severity: 'warn',
        message: 'Raw `any` still exists in orderbook-relevant target code.',
        matches,
      }
    : null;
}

function scanRehydrateContinues(files: string[]): Finding | null {
  const matches: Finding['matches'] = [];
  for (const file of files) {
    if (!file.endsWith('runtime/entity-tx/handlers/account.ts')) continue;
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!line.includes('rehydrateOnly')) continue;
      const window = lines.slice(i, i + 6).join('\n');
      const context = lines.slice(Math.max(0, i - 4), i + 6).join('\n');
      const nextMeaningfulLine = lines.slice(i + 1).find((candidate) => candidate.trim().length > 0) ?? '';
      const isPostInsertTradeSkip = nextMeaningfulLine.includes('continue;') && lines.slice(i + 1, i + 5).join('\n').includes('Process trade events');
      const looksLikeRejectPath = /warn|reject|invalid|skip|below|minTrade|overflow|zero|misaligned|band/i.test(context);
      if (
        !isPostInsertTradeSkip &&
        looksLikeRejectPath &&
        window.includes('continue;') &&
        !window.includes('quarantineOffer(') &&
        !window.includes('quarantinedOffers.push(')
      ) {
        pushFindingMatch(matches, file, i + 1, line);
      }
    }
  }
  return matches.length > 0
    ? {
        ruleId: 'rehydrate-quarantine-total',
        severity: 'fail',
        message: 'Rehydrate branches should quarantine before continuing.',
        matches,
      }
    : null;
}

function scanManualSwapKeys(files: string[]): Finding | null {
  const matches: Finding['matches'] = [];
  for (const file of files) {
    if (file.endsWith('runtime/swap-execution.ts')) continue;
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!/\$\{[^}]+\}:\$\{[^}]*offerId[^}]*\}/.test(line)) continue;
      if (!/(swapBookKey|pendingKey|pendingSwapFillRatios|const key\b|\.get\(|\.set\()/i.test(line)) continue;
      pushFindingMatch(matches, file, i + 1, line);
    }
  }
  return matches.length > 0
    ? {
        ruleId: 'manual-swap-key',
        severity: 'fail',
        message: 'Use swapKey(accountId, offerId) instead of manual stringly-typed keys.',
        matches,
      }
    : null;
}

function runScc(targets: string[]): SccSummary | null {
  const result = run(['scc', '-f', 'json2', '--no-cocomo', ...targets]);
  if (!result.ok) return null;
  const parsed = JSON.parse(result.output) as { languageSummary?: Array<{ Lines: number; Blank: number; Comment: number; Code: number; Complexity: number; Count: number }> };
  const rows = parsed.languageSummary ?? [];
  return rows.reduce<SccSummary>(
    (acc, row) => ({
      lines: acc.lines + (row.Lines ?? 0),
      blanks: acc.blanks + (row.Blank ?? 0),
      comments: acc.comments + (row.Comment ?? 0),
      code: acc.code + (row.Code ?? 0),
      complexity: acc.complexity + (row.Complexity ?? 0),
      files: acc.files + (row.Count ?? 0),
    }),
    { lines: 0, blanks: 0, comments: 0, code: 0, complexity: 0, files: 0 },
  );
}

function mappedTestsForProfile(profile: string): Array<{ label: string; command: string[] }> {
  if (profile === 'orderbook') {
    return [
      {
        label: 'runtime orderbook tests',
        command: [
          'bun',
          'test',
          'runtime/__tests__/price-improvement.test.ts',
          'runtime/__tests__/orderbook-matching-fallback.test.ts',
          'runtime/__tests__/orderbook-validity.test.ts',
          'runtime/__tests__/serialization-utils.test.ts',
        ],
      },
    ];
  }
  return [];
}

function collectFindings(files: string[], profile: string): Finding[] {
  const findings: Finding[] = [];

  const todoFinding = scanRegex(files, 'todo-markers', 'warn', 'TODO/FIXME/HACK markers remain in target.', /\b(TODO|FIXME|HACK)\b/);
  if (todoFinding) findings.push(todoFinding);

  const anyFinding =
    profile === 'orderbook'
      ? scanOrderbookWeakTypes(files)
      : scanRegex(files, 'any-keyword', 'warn', 'Raw `any` still exists in target.', /:\s*any\b|\bas any\b|<any>/);
  if (anyFinding) findings.push(anyFinding);

  if (profile === 'orderbook') {
    const localeFinding = scanRegex(files, 'no-locale-compare', 'fail', '`localeCompare` should not be used in consensus-critical orderbook code.', /\.localeCompare\(/);
    if (localeFinding) findings.push(localeFinding);

    const swapKeyFinding = scanManualSwapKeys(files);
    if (swapKeyFinding) findings.push(swapKeyFinding);

    const orderbookAnyFinding = scanRegex(
      files,
      'orderbookext-any',
      'fail',
      '`orderbookExt` should be strongly typed, not `any`.',
      /orderbookExt\?: any/,
    );
    if (orderbookAnyFinding) findings.push(orderbookAnyFinding);

    const swapBookMutationFinding = scanRegex(
      files,
      'swapbook-mutable',
      'warn',
      '`swapBook` is still mutated directly; derived view is preferable.',
      /swapBook\.(set|delete)\(/,
    );
    if (swapBookMutationFinding) findings.push(swapBookMutationFinding);

    const rehydrateFinding = scanRehydrateContinues(files);
    if (rehydrateFinding) findings.push(rehydrateFinding);
  }

  return findings;
}

function summarizeVerdict(findings: Finding[], tscOk: boolean, tests: TestRun[]): SoundcheckResult['verdict'] {
  if (!tscOk) return 'fail';
  if (tests.some((test) => !test.ok)) return 'fail';
  if (findings.some((finding) => finding.severity === 'fail')) return 'fail';
  if (findings.length > 0) return 'warn';
  return 'pass';
}

function buildSoundness(findings: Finding[], tscOk: boolean, tests: TestRun[]): SoundcheckResult['soundness'] {
  const hasRule = (ruleId: string) => findings.some((finding) => finding.ruleId === ruleId);
  const categoryStatus = (...ruleIds: string[]): 'pass' | 'warn' | 'fail' => {
    const subset = findings.filter((finding) => ruleIds.includes(finding.ruleId));
    if (subset.some((finding) => finding.severity === 'fail')) return 'fail';
    if (subset.length > 0) return 'warn';
    return 'pass';
  };

  const categories: SoundcheckResult['soundness']['categories'] = [
    {
      name: 'type-safety',
      status: !tscOk ? 'fail' : categoryStatus('any-keyword', 'orderbookext-any'),
      detail: !tscOk ? 'TypeScript compilation failed.' : hasRule('orderbookext-any') ? 'Weak runtime typing remains.' : 'Type checks passed.',
    },
    {
      name: 'determinism',
      status: categoryStatus('no-locale-compare', 'manual-swap-key'),
      detail: hasRule('no-locale-compare') || hasRule('manual-swap-key')
        ? 'Stringly or locale-sensitive ordering remains in deterministic paths.'
        : 'Deterministic path checks passed.',
    },
    {
      name: 'restore',
      status: categoryStatus('rehydrate-quarantine-total'),
      detail: hasRule('rehydrate-quarantine-total')
        ? 'Restore/debug rehydrate still has non-quarantined early-exit paths.'
        : 'Persisted-book restore checks passed.',
    },
    {
      name: 'state-model',
      status: categoryStatus('swapbook-mutable'),
      detail: hasRule('swapbook-mutable')
        ? 'Secondary mutable swap state still exists.'
        : 'No mutable swap cache findings.',
    },
    {
      name: 'tests',
      status: tests.some((test) => !test.ok) ? 'fail' : 'pass',
      detail: tests.some((test) => !test.ok) ? 'Mapped tests failed.' : 'Mapped tests passed.',
    },
    {
      name: 'hygiene',
      status: categoryStatus('todo-markers'),
      detail: hasRule('todo-markers') ? 'Markers remain in target.' : 'No TODO/FIXME/HACK markers found.',
    },
  ];

  const failCount = findings.filter((finding) => finding.severity === 'fail').length + (tscOk ? 0 : 1) + tests.filter((test) => !test.ok).length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  const score = Math.max(0, 100 - failCount * 15 - warnCount * 4);
  const status = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';
  return { score, status, categories };
}

function renderText(result: SoundcheckResult): string {
  const lines: string[] = [];
  lines.push(`Target: ${result.targetPaths.join(', ')}`);
  lines.push(`Profile: ${result.profile}`);
  lines.push(`Files scanned: ${result.filesScanned}`);
  lines.push('');

  if (result.scc) {
    lines.push('Size');
    lines.push(`- files: ${result.scc.files}`);
    lines.push(`- lines: ${result.scc.lines}`);
    lines.push(`- code: ${result.scc.code}`);
    lines.push(`- comments: ${result.scc.comments}`);
    lines.push(`- blanks: ${result.scc.blanks}`);
    lines.push(`- complexity: ${result.scc.complexity}`);
    lines.push('');
  }

  lines.push('Types');
  lines.push(`- tsc: ${result.tsc.ok ? 'pass' : 'fail'}`);
  lines.push('');

  lines.push('Invariants');
  if (result.findings.length === 0) {
    lines.push('- none');
  } else {
    for (const finding of result.findings) {
      lines.push(`- [${finding.severity}] ${finding.ruleId}: ${finding.message} (${finding.matches.length})`);
      for (const match of finding.matches.slice(0, 3)) {
        lines.push(`  ${match.file}:${match.line} ${match.text}`);
      }
      if (finding.matches.length > 3) lines.push(`  ... ${finding.matches.length - 3} more`);
    }
  }
  lines.push('');

  lines.push('Mapped tests');
  if (result.tests.length === 0) {
    lines.push('- none');
  } else {
    for (const test of result.tests) lines.push(`- ${test.ok ? 'pass' : 'fail'} ${test.label}`);
  }
  lines.push('');

  lines.push('Soundness');
  lines.push(`- score: ${result.soundness.score}`);
  lines.push(`- status: ${result.soundness.status}`);
  for (const category of result.soundness.categories) {
    lines.push(`- ${category.name}: ${category.status} (${category.detail})`);
  }
  lines.push('');

  lines.push(`Verdict: ${result.verdict.toUpperCase()}`);
  return lines.join('\n');
}

async function main() {
  const { targets, json, skipTsc, skipTests } = parseArgs(process.argv.slice(2));
  const normalizedTargets = targets.map((target) => relative(process.cwd(), resolve(target)));
  const files = collectFiles(targets);
  const profile = detectProfile(normalizedTargets, files.map((file) => relative(process.cwd(), file)));
  const scc = runScc(targets);
  const findings = collectFindings(files, profile);
  const tsc = skipTsc ? { ok: true, output: 'skipped' } : run(['bun', 'x', 'tsc', '--noEmit', '--pretty', 'false']);

  const tests: TestRun[] = [];
  if (!skipTests) {
    for (const spec of mappedTestsForProfile(profile)) {
      const result = run(spec.command);
      tests.push({
        label: spec.label,
        command: spec.command.join(' '),
        ok: result.ok,
        output: result.output,
      });
    }
  }

  const result: SoundcheckResult = {
    targetPaths: normalizedTargets,
    profile,
    filesScanned: files.length,
    scc,
    tsc,
    findings,
    tests,
    soundness: buildSoundness(findings, tsc.ok, tests),
    verdict: summarizeVerdict(findings, tsc.ok, tests),
  };

  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));

  process.exit(result.verdict === 'fail' ? 1 : 0);
}

await main();
