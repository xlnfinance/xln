/**
 * Appends one terse, durable progress heartbeat for long autonomous work.
 * This is operator evidence under .logs/qa; it never enters product state.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUTPUT_PATH = resolve(process.cwd(), '.logs', 'qa', 'agent-progress.jsonl');
const MAX_TEXT_LENGTH = 140;
const MAX_STORED_TEXT_LENGTH = 1_000;
const STALL_LIMIT_MS = 30 * 60 * 1000;

type ProgressEntry = Readonly<{
  at: string;
  percent: number;
  focus: string;
  blocker: string | null;
  next: string;
}>;

const ENTRY_KEYS = ['at', 'percent', 'focus', 'blocker', 'next'] as const;

const flag = (name: string): string | undefined => {
  const prefix = '--' + name + '=';
  return process.argv.slice(2).find(argument => argument.startsWith(prefix))?.slice(prefix.length);
};

const text = (name: string): string => {
  const value = String(flag(name) ?? '').trim();
  if (!value || value.length > MAX_TEXT_LENGTH || /[\r\n]/.test(value)) {
    throw new Error('PROGRESS_' + name.toUpperCase() + '_INVALID:max=' + String(MAX_TEXT_LENGTH));
  }
  return value;
};

const parseEntry = (value: unknown, index: number): ProgressEntry => {
  const label = 'PROGRESS_ENTRY_' + String(index);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(label + '_RECORD_REQUIRED');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...ENTRY_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, keyIndex) => key !== expected[keyIndex])) {
    throw new Error(label + '_FIELDS_INVALID:' + keys.join(','));
  }
  const blocker = record['blocker'];
  if (
    typeof record['at'] !== 'string' || !Number.isFinite(Date.parse(record['at'])) ||
    typeof record['percent'] !== 'number' || !Number.isInteger(record['percent']) ||
    record['percent'] < 0 || record['percent'] > 100 ||
    typeof record['focus'] !== 'string' || !record['focus'] || record['focus'].length > MAX_STORED_TEXT_LENGTH ||
    (blocker !== null && (typeof blocker !== 'string' || !blocker || blocker.length > MAX_STORED_TEXT_LENGTH)) ||
    typeof record['next'] !== 'string' || !record['next'] || record['next'].length > MAX_STORED_TEXT_LENGTH
  ) throw new Error(label + '_INVALID');
  return {
    at: record['at'],
    percent: record['percent'],
    focus: record['focus'],
    blocker,
    next: record['next'],
  };
};

const readEntries = (): ProgressEntry[] => {
  try {
    return readFileSync(OUTPUT_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line, index) => {
        if (!line.trimStart().startsWith('{')) return [];
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
          Object.keys(parsed).sort().join(',') === 'at,progress,status'
        ) return [];
        if (
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
          Object.keys(parsed).sort().join(',') === 'blocker,focus,next,progress,time'
        ) {
          const legacy = parsed as Record<string, unknown>;
          return [parseEntry({
            at: legacy['time'],
            percent: legacy['progress'],
            focus: legacy['focus'],
            blocker: legacy['blocker'],
            next: legacy['next'],
          }, index)];
        }
        return [parseEntry(parsed, index)];
      });
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : '';
    if (code === 'ENOENT') return [];
    throw error;
  }
};

const percent = Number(flag('percent'));
if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
  throw new Error('PROGRESS_PERCENT_INVALID');
}
const focus = text('focus');
const next = text('next');
const blockerValue = String(flag('blocker') ?? '').trim();
if (blockerValue.length > MAX_TEXT_LENGTH || /[\r\n]/.test(blockerValue)) {
  throw new Error('PROGRESS_BLOCKER_INVALID:max=' + String(MAX_TEXT_LENGTH));
}
const now = new Date();
const entries = readEntries();
if (blockerValue) {
  const sameBlocker = entries.find(entry => entry.blocker === blockerValue);
  if (sameBlocker && now.getTime() - Date.parse(sameBlocker.at) >= STALL_LIMIT_MS) {
    throw new Error(
      'PROGRESS_BLOCKER_ESCALATION_REQUIRED:blocker=' + blockerValue + ':since=' + sameBlocker.at,
    );
  }
}

const entry: ProgressEntry = {
  at: now.toISOString(),
  percent,
  focus,
  blocker: blockerValue || null,
  next,
};
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
appendFileSync(OUTPUT_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
console.log(
  OUTPUT_PATH + ': ' + entry.at + ' | ' + String(percent) + '% | ' + focus + ' | next: ' + next,
);
