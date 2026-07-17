import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

type JsonRecord = Record<string, unknown>;

export type PlaywrightFailure = {
  reportPath: string;
  file: string;
  title: string;
  line: number;
  column: number;
  project: string;
  error: string;
  stack: string | null;
  attachments: Array<{
    name: string;
    contentType: string;
    path: string | null;
  }>;
};

export type IsolatedE2ERerunOptions = {
  videoMode: string;
  traceMode: string;
  screenshotMode: string;
  prewaitHealth: string;
  strictBrowserHealth: boolean;
};

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;

const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.map(record).filter((entry): entry is JsonRecord => entry !== null) : [];

const text = (value: unknown): string =>
  typeof value === 'string' ? stripVTControlCharacters(value).trim() : '';

const positiveInteger = (value: unknown): number => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
};

const jsonErrorLocation = (source: string, error: ParseError, firstLine: number) => {
  const prefix = source.slice(0, Math.max(0, error.offset));
  const lines = prefix.split('\n');
  return {
    line: firstLine + lines.length - 1,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
};

export const parseJsonStrict = (
  source: string,
  path: string,
  firstLine = 1,
): unknown => {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: false, disallowComments: true });
  const firstError = errors[0];
  if (!firstError) return value;
  const location = jsonErrorLocation(source, firstError, firstLine);
  throw new Error(
    `E2E_JSON_INVALID:path=${path}:line=${location.line}:column=${location.column}:` +
    `reason=${printParseErrorCode(firstError.error)}`,
  );
};

export const parseJsonLinesStrict = (source: string, path: string): unknown[] =>
  source
    .split('\n')
    .flatMap((line, index) => line.trim() ? [parseJsonStrict(line, path, index + 1)] : []);

type FailureCandidate = PlaywrightFailure & {
  startedAt: number;
  sequence: number;
};

const firstErrorDetails = (result: JsonRecord): { error: string; stack: string | null } => {
  const candidates = [
    ...records(result['errors']),
    record(result['error']),
  ].filter((entry): entry is JsonRecord => entry !== null);
  const first = candidates[0] ?? {};
  const message = text(first['message']) || text(first['value']) || 'Playwright test failed';
  const stack = candidates.map(candidate => text(candidate['stack'])).find(Boolean) || null;
  return { error: message, stack };
};

const failureAttachments = (result: JsonRecord): PlaywrightFailure['attachments'] =>
  records(result['attachments']).map(attachment => ({
    name: text(attachment['name']) || 'attachment',
    contentType: text(attachment['contentType']) || 'application/octet-stream',
    path: text(attachment['path']) || null,
  }));

const collectSuiteFailures = (
  suite: JsonRecord,
  inheritedFile: string,
  candidates: FailureCandidate[],
): void => {
  const suiteFile = text(suite['file']) || inheritedFile;
  for (const spec of records(suite['specs'])) {
    const file = text(spec['file']) || suiteFile;
    const title = text(spec['title']);
    for (const test of records(spec['tests'])) {
      const unexpected = test['status'] === 'unexpected' || spec['ok'] === false;
      if (!unexpected) continue;
      const failedResults = records(test['results']).filter(result =>
        ['failed', 'timedOut', 'interrupted'].includes(text(result['status'])));
      const result = failedResults[0] ?? records(test['results']).at(-1);
      if (!result) continue;
      const details = firstErrorDetails(result);
      candidates.push({
        reportPath: '',
        file,
        title,
        line: positiveInteger(spec['line']),
        column: positiveInteger(spec['column']),
        project: text(test['projectName']),
        error: details.error,
        stack: details.stack,
        attachments: failureAttachments(result),
        startedAt: Date.parse(text(result['startTime'])) || Number.MAX_SAFE_INTEGER,
        sequence: candidates.length,
      });
    }
  }
  for (const child of records(suite['suites'])) collectSuiteFailures(child, suiteFile, candidates);
};

export const readPlaywrightFailureReport = (reportPath: string): PlaywrightFailure | null => {
  const report = record(parseJsonStrict(readFileSync(reportPath, 'utf8'), reportPath));
  if (!report || !Array.isArray(report['suites']) || !Array.isArray(report['errors'])) {
    throw new Error(`E2E_PLAYWRIGHT_REPORT_SHAPE_INVALID:path=${reportPath}`);
  }
  const candidates: FailureCandidate[] = [];
  for (const suite of records(report['suites'])) collectSuiteFailures(suite, '', candidates);
  const first = candidates.sort((left, right) =>
    left.startedAt - right.startedAt || left.sequence - right.sequence)[0];
  if (!first) return null;
  if (!first.file || !first.title || first.line === 0 || !first.error) {
    throw new Error(`E2E_PLAYWRIGHT_FAILURE_SHAPE_INVALID:path=${reportPath}`);
  }
  const reportRoot = text(record(report['config'])?.['rootDir']);
  const absoluteFile = reportRoot
    ? isAbsolute(first.file) ? first.file : resolve(reportRoot, first.file)
    : '';
  const repositoryRelativeFile = absoluteFile ? relative(process.cwd(), absoluteFile) : '';
  // Playwright reports files relative to config.rootDir (XLN uses `tests/`).
  // Preserve an already-useful reporter path when the configured root belongs
  // to another checkout; otherwise the capsule would emit an unrunnable path.
  const file = repositoryRelativeFile &&
    repositoryRelativeFile !== '..' &&
    !repositoryRelativeFile.startsWith('../') &&
    !repositoryRelativeFile.startsWith('..\\') &&
    !isAbsolute(repositoryRelativeFile)
    ? repositoryRelativeFile
    : first.file;
  const { startedAt: _startedAt, sequence: _sequence, ...failure } = first;
  return { ...failure, file, reportPath };
};

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:@=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildIsolatedE2ERerunCommand = (
  failure: PlaywrightFailure,
  options: IsolatedE2ERerunOptions,
): string => [
  'bun',
  'runtime/scripts/run-e2e-parallel-isolated.ts',
  '--shards=1',
  '--workers-per-shard=1',
  '--max-failures=1',
  `--pw-files=${failure.file}::${failure.title}`,
  ...(failure.project ? [`--pw-project=${failure.project}`] : []),
  `--video=${options.videoMode}`,
  `--trace=${options.traceMode}`,
  `--screenshot=${options.screenshotMode}`,
  `--prewait-health=${options.prewaitHealth}`,
  ...(options.strictBrowserHealth ? ['--strict-browser-health'] : []),
  '--preserve-artifacts',
].map(shellQuote).join(' ');
