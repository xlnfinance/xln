import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const E2E_FATAL_LOG_TAIL_LINES = 80;

export const RUNTIME_FATAL_LOG_PATTERNS: RegExp[] = [
  /MISSING_SIGNER_KEY/,
  /JADAPTER_MISSING/,
  /MM_READY_TIMEOUT/,
  /CROSS_J_[A-Z0-9_:-]*/,
  /J_SUBMIT_FATAL/,
  /RUNTIME_LOOP_HALTED/,
  /RUNTIME_LOOP_ERROR/,
  /staticCall revert/,
  /processBatch failed/,
  /batch from .* FAILED/,
  /Runtime loop error/,
  /\[ERROR\]\[runtime\] loop\.error/,
  /ROUTE_NO_P2P/,
  /child\.unexpected_exit/,
  /ENTITY_FRAME_TX_FAILED/,
];

export type FatalLogHit = {
  pattern: string;
  lineNumber: number;
  line: string;
};

export type IncrementalRuntimeFatalLogScanner = {
  scan: () => FatalLogHit | null;
};

const findFatalPattern = (line: string): RegExp | undefined =>
  RUNTIME_FATAL_LOG_PATTERNS.find(candidate => candidate.test(line));

/**
 * Reads only bytes appended since the previous scan. The partial final line is
 * deliberately retained and rechecked with the next append: a process may
 * flush `RUNTIME_LOOP_` and `HALTED` in separate writes.
 */
export const createIncrementalRuntimeFatalLogScanner = (
  path: string,
): IncrementalRuntimeFatalLogScanner => {
  const readBuffer = Buffer.allocUnsafe(64 * 1024);
  let byteOffset = 0;
  let nextLineNumber = 1;
  let partialLine = '';
  let fileIdentity = '';
  let decoder = new StringDecoder('utf8');

  const reset = (identity: string): void => {
    byteOffset = 0;
    nextLineNumber = 1;
    partialLine = '';
    fileIdentity = identity;
    decoder = new StringDecoder('utf8');
  };

  const inspectAppend = (text: string): FatalLogHit | null => {
    const lines = `${partialLine}${text}`.split('\n');
    partialLine = lines.pop() ?? '';
    const firstLineNumber = nextLineNumber;
    nextLineNumber += lines.length;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const pattern = findFatalPattern(line);
      if (!pattern) continue;
      return {
        pattern: String(pattern),
        lineNumber: firstLineNumber + index,
        line: line.slice(0, 500),
      };
    }

    const partialPattern = findFatalPattern(partialLine);
    if (!partialPattern) return null;
    return {
      pattern: String(partialPattern),
      lineNumber: nextLineNumber,
      line: partialLine.slice(0, 500),
    };
  };

  return {
    scan: (): FatalLogHit | null => {
      let fd: number | null = null;
      try {
        fd = openSync(path, 'r');
        const stats = fstatSync(fd);
        const identity = `${stats.dev}:${stats.ino}`;
        if (identity !== fileIdentity || stats.size < byteOffset) reset(identity);

        while (byteOffset < stats.size) {
          const requested = Math.min(readBuffer.length, stats.size - byteOffset);
          const bytesRead = readSync(fd, readBuffer, 0, requested, byteOffset);
          if (bytesRead === 0) break;
          byteOffset += bytesRead;
          const hit = inspectAppend(decoder.write(readBuffer.subarray(0, bytesRead)));
          if (hit) return hit;
        }
        return null;
      } catch {
        return null;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    },
  };
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
    const pattern = findFatalPattern(line);
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
