import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

import type { QaTaggedTest } from '../qa/test-categories';

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' ? value as JsonRecord : {};

const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.map(record) : [];

const normalizePath = (value: string): string => value.replace(/\\/g, '/');
const normalizeTag = (value: unknown): string => {
  const tag = String(value).trim();
  return tag && !tag.startsWith('@') ? `@${tag}` : tag;
};

const collectSuiteTests = (suite: JsonRecord, rootDir: string, out: QaTaggedTest[]): void => {
  for (const spec of records(suite['specs'])) {
    const title = String(spec['title'] ?? '').trim();
    const file = String(spec['file'] ?? '').trim();
    if (!title || !file) continue;
    const line = Number(spec['line']);
    out.push({
      file: normalizePath(relative(process.cwd(), resolve(rootDir, file))),
      line: Number.isFinite(line) && line > 0 ? Math.floor(line) : null,
      title,
      tags: Array.isArray(spec['tags']) ? spec['tags'].map(normalizeTag).filter(Boolean).sort() : [],
    });
  }
  for (const child of records(suite['suites'])) collectSuiteTests(child, rootDir, out);
};

export const parsePlaywrightTestMetadata = (payload: unknown): QaTaggedTest[] => {
  const report = record(payload);
  const config = record(report['config']);
  const rootDir = String(config['rootDir'] ?? '').trim();
  if (!rootDir) throw new Error('PLAYWRIGHT_LIST_ROOT_DIR_MISSING');
  const errors = records(report['errors'])
    .map((error) => String(error['message'] ?? '').trim())
    .filter(Boolean);
  if (errors.length > 0) throw new Error(`PLAYWRIGHT_LIST_FAILED\n${errors.join('\n')}`);
  const tests: QaTaggedTest[] = [];
  for (const suite of records(report['suites'])) collectSuiteTests(suite, rootDir, tests);
  const unique = new Map<string, QaTaggedTest>();
  for (const test of tests) unique.set(`${test.file}:${test.line ?? 0}:${test.title}`, test);
  return [...unique.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.title.localeCompare(b.title));
};

export type PlaywrightMetadataOptions = {
  profile?: string | undefined;
  project?: string | undefined;
};

export const listPlaywrightTestMetadata = (
  files: readonly string[],
  options: PlaywrightMetadataOptions = {},
): QaTaggedTest[] => {
  if (files.length === 0) return [];
  const args = ['playwright', 'test', '--config', 'playwright.config.ts', '--list', '--reporter=json'];
  if (options.project) args.push(`--project=${options.project}`);
  args.push(...files);
  const result = spawnSync('bunx', args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_SKIP_WEBSERVER: '1',
      PW_BASE_URL: process.env['PW_BASE_URL'] || 'https://localhost:1',
      E2E_BASE_URL: process.env['E2E_BASE_URL'] || 'https://localhost:1',
      E2E_API_BASE_URL: process.env['E2E_API_BASE_URL'] || 'http://127.0.0.1:1',
      E2E_ANVIL_RPC: process.env['E2E_ANVIL_RPC'] || 'http://127.0.0.1:1',
      E2E_RESET_BASE_URL: process.env['E2E_RESET_BASE_URL'] || 'http://127.0.0.1:1',
      ...(options.profile ? { PW_PROFILE: options.profile } : {}),
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const stdout = String(result.stdout ?? '').trim();
  if (result.error) throw result.error;
  if (!stdout) throw new Error(`PLAYWRIGHT_LIST_EMPTY_OUTPUT:${String(result.stderr ?? '').trim()}`);
  try {
    return parsePlaywrightTestMetadata(JSON.parse(stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(stderr ? `${message}\n${stderr}` : message);
  }
};
