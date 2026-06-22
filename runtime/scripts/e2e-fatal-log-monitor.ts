import { readFileSync } from 'node:fs';

export const E2E_FATAL_LOG_TAIL_LINES = 80;

export const RUNTIME_FATAL_LOG_PATTERNS: RegExp[] = [
  /MISSING_SIGNER_KEY/,
  /JADAPTER_MISSING/,
  /PENDING[-_]FRAME[-_]STALE/,
  /MM_READY_TIMEOUT/,
  /CROSS_J_[A-Z0-9_:-]*/,
  /J_SUBMIT_FATAL/,
  /RUNTIME_LOOP_HALTED/,
  /RUNTIME_LOOP_ERROR/,
  /staticCall revert/,
  /processBatch failed/,
  /batch from .* FAILED/,
  /Runtime loop error/,
  /ENTITY_FRAME_TX_FAILED/,
];

export type FatalLogHit = {
  pattern: string;
  lineNumber: number;
  line: string;
};

export const tailLog = (path: string, lines = E2E_FATAL_LOG_TAIL_LINES): string => {
  try {
    const text = readFileSync(path, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '(unable to read log tail)';
  }
};

export const findFirstRuntimeFatalLogHit = (path: string, fromLine = 0): FatalLogHit | null => {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = Math.max(0, fromLine); i < lines.length; i += 1) {
    const line = lines[i] || '';
    const pattern = RUNTIME_FATAL_LOG_PATTERNS.find(candidate => candidate.test(line));
    if (!pattern) continue;
    return {
      pattern: String(pattern),
      lineNumber: i + 1,
      line: line.slice(0, 500),
    };
  }
  return null;
};

export const findRuntimeFatalLogLines = (path: string, maxLines = 12): string[] => {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    if (!RUNTIME_FATAL_LOG_PATTERNS.some(pattern => pattern.test(line))) continue;
    out.push(`${i + 1}: ${line.slice(0, 500)}`);
    if (out.length >= maxLines) break;
  }
  return out;
};
