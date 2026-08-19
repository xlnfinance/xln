#!/usr/bin/env bun
/**
 * Persistent OpenCode reviewer sessions. Resume the same GLM / DeepSeek
 * reviewers instead of starting a fresh chat each recheck.
 *
 *   bun tools/opencode-dialog.ts list
 *   bun tools/opencode-dialog.ts ask glm --message='...'
 *   bun tools/opencode-dialog.ts ask deepseek --file=.logs/qa/opencode-overlay-prompt.txt
 *   bun tools/opencode-dialog.ts export glm
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const STORE_PATH = resolve(ROOT, '.logs/qa/opencode-sessions.json');

const REVIEWERS = {
  glm: {
    model: 'zai-coding-plan/glm-5.3',
    title: 'xln-overlay-glm',
  },
  deepseek: {
    model: 'opencode/deepseek-v4-flash',
    title: 'xln-overlay-deepseek',
  },
} as const;

type ReviewerId = keyof typeof REVIEWERS;
type StoredSession = Readonly<{
  sessionId: string;
  model: string;
  title: string;
  updatedAt: string;
}>;
type Store = Partial<Record<ReviewerId, StoredSession>>;

const isReviewer = (value: string): value is ReviewerId => value in REVIEWERS;

const loadStore = (): Store => {
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Store;
  } catch {
    return {};
  }
};

const saveStore = (store: Store): void => {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
};

const flag = (argv: readonly string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  const match = argv.find(argument => argument.startsWith(prefix));
  return match?.slice(prefix.length);
};

const sessionIdFromText = (text: string): string | undefined => {
  const match = text.match(/ses_[A-Za-z0-9]+/);
  return match?.[0];
};

const ask = (reviewerId: ReviewerId, message: string): void => {
  const reviewer = REVIEWERS[reviewerId];
  const store = loadStore();
  const existing = store[reviewerId]?.sessionId;
  const args = [
    'run',
    '--auto',
    '--agent', 'plan',
    '--format', 'json',
    '--dir', ROOT,
    '-m', reviewer.model,
    '--title', reviewer.title,
    ...(existing ? ['-s', existing] : []),
    message,
  ];
  console.log(`OPENCODE_ASK reviewer=${reviewerId} model=${reviewer.model} session=${existing ?? 'new'}`);
  const result = spawnSync('opencode', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(result.stdout ?? '');
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`OPENCODE_ASK_FAILED:${reviewerId}:status=${String(result.status)}`);
  }
  const sessionId = sessionIdFromText(output) ?? existing;
  if (!sessionId) throw new Error(`OPENCODE_SESSION_ID_MISSING:${reviewerId}`);
  saveStore({
    ...store,
    [reviewerId]: {
      sessionId,
      model: reviewer.model,
      title: reviewer.title,
      updatedAt: new Date().toISOString(),
    },
  });
  console.log(`OPENCODE_SESSION reviewer=${reviewerId} session=${sessionId}`);
};

const exportSession = (reviewerId: ReviewerId): void => {
  const sessionId = loadStore()[reviewerId]?.sessionId;
  if (!sessionId) throw new Error(`OPENCODE_SESSION_MISSING:${reviewerId}`);
  const result = spawnSync('opencode', ['export', sessionId], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  if (result.status !== 0) process.exitCode = result.status ?? 1;
};

const list = (): void => {
  const store = loadStore();
  for (const reviewerId of Object.keys(REVIEWERS) as ReviewerId[]) {
    const row = store[reviewerId];
    console.log(`${reviewerId} model=${REVIEWERS[reviewerId].model} session=${row?.sessionId ?? 'none'} updated=${row?.updatedAt ?? '-'}`);
  }
};

const run = (argv: readonly string[]): void => {
  const command = argv[0] ?? 'list';
  if (command === 'list') return list();
  const reviewer = argv[1] ?? '';
  if (!isReviewer(reviewer)) throw new Error(`OPENCODE_REVIEWER_UNKNOWN:${reviewer}`);
  if (command === 'export') return exportSession(reviewer);
  if (command !== 'ask') throw new Error(`OPENCODE_COMMAND_UNKNOWN:${command}`);
  const file = flag(argv, 'file');
  const messageFlag = flag(argv, 'message');
  const message = file ? readFileSync(resolve(ROOT, file), 'utf8') : messageFlag;
  if (!message?.trim()) throw new Error('OPENCODE_MESSAGE_REQUIRED');
  ask(reviewer, message);
};

if (import.meta.main) run(process.argv.slice(2));
