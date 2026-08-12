import { CHILD_LOG_RING_MAX } from '../orchestrator-config';

export type PrefixLogState = { pending: string };

/**
 * Retains a small diagnostic tail without allowing noisy children to grow the
 * orchestrator heap forever. Lines are also capped because one malformed log
 * record must not consume the entire ring.
 */
export const pushChildLogLines = (target: string[], chunk: Buffer | string): void => {
  for (const rawLine of chunk.toString().split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) target.push(line.slice(0, 1_000));
  }
  if (target.length > CHILD_LOG_RING_MAX) {
    target.splice(0, target.length - CHILD_LOG_RING_MAX);
  }
};

/**
 * Child output arrives in arbitrary chunks, not complete lines. Preserve the
 * unfinished suffix so prefixes and fatal-line inspection see the exact line
 * the child emitted rather than fragments created by stream scheduling.
 */
export const writePrefixedLogChunk = (
  stream: NodeJS.WritableStream,
  prefix: string,
  state: PrefixLogState,
  chunk: Buffer | string,
  onLine?: (line: string) => void,
): void => {
  const lines = `${state.pending}${chunk.toString()}`.split(/\r?\n/);
  state.pending = lines.pop() ?? '';
  for (const line of lines) {
    onLine?.(line);
    stream.write(`${prefix} ${line}\n`);
  }
};

export const flushPrefixedLogChunk = (
  stream: NodeJS.WritableStream,
  prefix: string,
  state: PrefixLogState,
  onLine?: (line: string) => void,
): void => {
  if (!state.pending) return;
  onLine?.(state.pending);
  stream.write(`${prefix} ${state.pending}\n`);
  state.pending = '';
};
