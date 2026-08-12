import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AggregatedHealth, MarketMakerChild } from '../orchestrator-types';

export type LastBootstrapEvent = {
  event: string;
  stage: string | null;
  at: string | null;
  height: number | null;
  backlog: unknown;
  readyHash: string | null;
  runtimeStateHash: string | null;
  entityStateHash: string | null;
};

type BootstrapEventReaderDeps = {
  isRecord(value: unknown): value is Record<string, unknown>;
  toFiniteNumber(value: unknown): number | null;
  warnTailRead(message: string, path: string, error: unknown): void;
};

export const resolveBootstrapEventsPath = (marketMakerChild: MarketMakerChild): string =>
  String(process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] || '').trim() ||
  join(marketMakerChild.dbPath, 'bootstrap-events.jsonl');

const readTailText = (
  deps: Pick<BootstrapEventReaderDeps, 'warnTailRead'>,
  path: string,
  maxBytes: number,
): string | null => {
  if (!path || !existsSync(path)) return null;
  let descriptor: number | null = null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0) return null;
    const length = Math.min(stat.size, Math.max(1, maxBytes));
    const buffer = Buffer.alloc(length);
    descriptor = openSync(path, 'r');
    const bytesRead = readSync(descriptor, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8', 0, bytesRead);
  } catch (error) {
    deps.warnTailRead('bootstrap_events_tail_read_failed', path, error);
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (error) {
        deps.warnTailRead('bootstrap_events_tail_close_failed', path, error);
      }
    }
  }
};

const decodeBootstrapEvent = (
  deps: Pick<BootstrapEventReaderDeps, 'isRecord' | 'toFiniteNumber'>,
  line: string,
): LastBootstrapEvent | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!deps.isRecord(parsed)) return null;
    const event = String(parsed['event'] || '').trim();
    if (!event) return null;
    return {
      event,
      stage: String(parsed['stage'] || '').trim() || null,
      at: String(parsed['at'] || '').trim() || null,
      height: deps.toFiniteNumber(parsed['height']),
      backlog: parsed['backlog'],
      readyHash: String(parsed['hash'] || '').trim() || null,
      runtimeStateHash: String(parsed['runtimeStateHash'] || '').trim() || null,
      entityStateHash: String(parsed['entityStateHash'] || '').trim() || null,
    };
  } catch {
    // A bounded tail can start in the middle of its oldest JSONL record.
    return null;
  }
};

export const readLastMarketMakerBootstrapEvent = (
  deps: BootstrapEventReaderDeps,
  path: string,
): LastBootstrapEvent | null => {
  // Reading only the tail keeps health polling bounded after months of uptime.
  const tail = readTailText(deps, path, 64 * 1024);
  if (!tail) return null;
  const lines = tail
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = decodeBootstrapEvent(deps, lines[index]!);
    if (event) return event;
  }
  return null;
};

export const summarizeBootstrapBacklog = (
  isRecord: BootstrapEventReaderDeps['isRecord'],
  value: unknown,
): AggregatedHealth['bootstrapTimeline']['backlog'] => {
  if (!isRecord(value)) return null;
  const queuedInputs = Array.isArray(value['queuedEntityInputs']) ? value['queuedEntityInputs'] : [];
  const queuedEntityTxCount = queuedInputs.reduce((sum, entry) => {
    if (!isRecord(entry)) return sum;
    return sum + Math.max(0, Math.floor(Number(entry['txCount'] || 0)));
  }, 0);
  const runtimeTxs = Math.max(0, Math.floor(Number(value['runtimeTxs'] || 0)));
  const entityInputs = Math.max(0, Math.floor(Number(value['entityInputs'] || 0)));
  const jInputs = Math.max(0, Math.floor(Number(value['jInputs'] || 0)));
  const processing = value['processing'] === true;
  return {
    processing,
    runtimeTxs,
    entityInputs,
    jInputs,
    queuedEntityInputCount: queuedInputs.length,
    queuedEntityTxCount,
    total: runtimeTxs + entityInputs + jInputs + (processing ? 1 : 0),
  };
};

export const emptyBootstrapBacklog = (): NonNullable<AggregatedHealth['bootstrapTimeline']['backlog']> => ({
  processing: false,
  runtimeTxs: 0,
  entityInputs: 0,
  jInputs: 0,
  queuedEntityInputCount: 0,
  queuedEntityTxCount: 0,
  total: 0,
});
