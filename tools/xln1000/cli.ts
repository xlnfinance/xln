#!/usr/bin/env bun
/**
 * XLN-1000 steering metric (docs/xln1000.md).
 *   measure  read-only against one git revision; tree only unless --ledger / --ci; prints the table, JSON to stdout or --out
 *   record   measure, then append one line to docs/evidence/xln1000/history.jsonl (refuses a dirty kernel tree)
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { measure, type Measurement } from './measure';
import { formatTable } from './report';
import { dirtyPaths } from './repo';

const HISTORY_FILE = 'docs/evidence/xln1000/history.jsonl';
const RECORD_GUARDED_PATHS = ['core', 'jurisdictions', 'ui'];
const VALUE_FLAGS = new Set(['repo', 'rev', 'out', 'ledger-dir']);
const BOOLEAN_FLAGS = new Set(['json', 'ci', 'ledger', 'allow-dirty', 'help']);
const USAGE = `usage: bun tools/xln1000/cli.ts [measure|record] [options]
  --rev <rev>        revision to measure (default HEAD)
  --repo <dir>       repository root (default: the repository holding this tool)
  --ledger           also read the local QA ledger <repo>/.logs (grows over time; windows end at the commit time)
  --ledger-dir <dir> read the QA ledger from <dir> instead (implies --ledger)
  --ci               also read GitHub Actions status for the SHA (networked, via gh)
  --json             print the JSON result on stdout (table goes to stderr)
  --out <file>       write the JSON result to a file
  --allow-dirty      record even with uncommitted core/, jurisdictions/ or ui/ changes (marked dirty)`;

type Options = Readonly<{
  command: 'measure' | 'record' | 'help';
  repo: string;
  rev: string;
  out: string | null;
  ledger: string | null;
  json: boolean;
  ci: boolean;
  allowDirty: boolean;
}>;

const readFlags = (argv: readonly string[]): { positional: string[]; flags: Map<string, string> } => {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [name = '', inline] = token.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) flags.set(name, 'true');
    else if (VALUE_FLAGS.has(name)) flags.set(name, inline ?? argv[(index += 1)] ?? '');
    else throw new Error(`XLN1000_UNKNOWN_FLAG --${name}\n${USAGE}`);
    if (flags.get(name) === '') throw new Error(`XLN1000_FLAG_NEEDS_VALUE --${name}`);
  }
  return { positional, flags };
};

const parseOptions = (argv: readonly string[]): Options => {
  const { positional, flags } = readFlags(argv);
  const command = flags.has('help') ? 'help' : (positional[0] ?? 'measure');
  if (command !== 'measure' && command !== 'record' && command !== 'help')
    throw new Error(`XLN1000_UNKNOWN_COMMAND ${command}\n${USAGE}`);
  if (positional.length > 1) throw new Error(`XLN1000_UNEXPECTED_ARGUMENT ${positional[1] ?? ''}`);
  const repo = resolve(flags.get('repo') ?? join(import.meta.dir, '..', '..'));
  const wantsLedger = flags.has('ledger') || flags.has('ledger-dir');
  const ledger = wantsLedger ? resolve(flags.get('ledger-dir') ?? join(repo, '.logs')) : null;
  return {
    command,
    repo,
    rev: flags.get('rev') ?? 'HEAD',
    out: flags.has('out') ? resolve(flags.get('out') ?? '') : null,
    ledger,
    json: flags.has('json'),
    ci: flags.has('ci'),
    allowDirty: flags.has('allow-dirty'),
  };
};

const runMeasure = (options: Options): Measurement => {
  const started = performance.now();
  const result = measure({ root: options.repo, rev: options.rev, ledgerDir: options.ledger, ci: options.ci });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, json);
  if (options.json) {
    process.stdout.write(json);
    console.error(formatTable(result));
  } else console.log(formatTable(result));
  console.error(
    `measured in ${((performance.now() - started) / 1000).toFixed(1)} s${options.out ? `; json -> ${options.out}` : ''}`,
  );
  return result;
};

const historyLine = (result: Measurement, dirty: boolean): string =>
  JSON.stringify({
    sha: result.sha,
    tool: result.tool,
    recordedAt: new Date().toISOString(),
    dirty,
    inputs: {
      ledger: result.inputs.ledger !== null,
      ci: result.inputs.ci !== null,
      worktreeNegativeEvidence: result.inputs.worktreeNegativeEvidence.length,
    },
    total: result.total,
    axes: Object.fromEntries(result.axes.map(axis => [axis.id, axis.score])),
    vetoes: result.vetoes,
  });

const runRecord = (options: Options): number => {
  const dirty = dirtyPaths(options.repo, RECORD_GUARDED_PATHS);
  if (dirty.length > 0 && !options.allowDirty) {
    console.error(
      `XLN1000_RECORD_REFUSED: ${String(dirty.length)} uncommitted paths under core/, jurisdictions/ or ui/:`,
    );
    for (const line of dirty.slice(0, 10)) console.error(`  ${line}`);
    console.error(
      'Commit them first, or pass --allow-dirty to record anyway (the history line is then marked dirty: true).',
    );
    return 2;
  }
  if (dirty.length > 0)
    console.error(
      `XLN1000_RECORD_DIRTY: recording with ${String(dirty.length)} uncommitted kernel paths (--allow-dirty)`,
    );
  const result = runMeasure(options);
  const history = join(options.repo, HISTORY_FILE);
  if (!existsSync(dirname(history))) mkdirSync(dirname(history), { recursive: true });
  appendFileSync(history, `${historyLine(result, dirty.length > 0)}\n`);
  console.error(`recorded -> ${HISTORY_FILE}`);
  return 0;
};

const main = (): number => {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (options.command === 'record') return runRecord(options);
  runMeasure(options);
  return 0;
};

/** Tool errors carry an XLN1000_* code and their evidence in the message; anything else keeps its stack. */
const reportFailure = (error: unknown): number => {
  const known = error instanceof Error && error.message.startsWith('XLN1000_');
  console.error(known ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error));
  return 1;
};

try {
  process.exitCode = main();
} catch (error) {
  process.exitCode = reportFailure(error);
}
