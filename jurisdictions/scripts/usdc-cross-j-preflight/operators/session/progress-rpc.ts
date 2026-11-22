import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { networks } from '../../identities';
import { completeLogLines } from './progress-log';

const headerMarker = 'USDC_PREFLIGHT_HEADER_TIMING:';
const receiptMarker = 'USDC_HYPERRPC_RECEIPTS:';
const rangeMarker = 'USDC_HYPERSYNC_RANGE_TIMING:';
const integer = (value: unknown) => requireBoundaryInteger(value, 'PROGRESS_INVALID_RPC_TIMING', 0);
type Timing = Readonly<{ queueMs: number; upstreamMs: number }>;
type HeaderTiming = { queueMs?: number; sentAt?: number };

const addHeaderTiming = (
  event: Record<string, unknown>,
  header: Map<number, HeaderTiming>,
  latest: Map<string, Timing>,
): void => {
  const id = integer(event['id']);
  const phase = event['phase'];
  if (phase === 'queued') {
    header.set(id, {});
    return;
  }
  const sample = header.get(id);
  if (!sample) return;
  if (phase === 'admitted') sample.queueMs = integer(event['elapsedMs']);
  if (phase === 'sent') sample.sentAt = integer(event['elapsedMs']);
  if (phase === 'upstream-replied' && sample.queueMs !== undefined && sample.sentAt !== undefined) {
    const chain = networks.find(chain => chain.chainId === event['chainId']);
    if (chain)
      latest.set(`${chain.name} headers`, {
        queueMs: sample.queueMs,
        upstreamMs: integer(integer(event['elapsedMs']) - sample.sentAt),
      });
  }
  if (phase === 'finished') header.delete(id);
};

export const readRpcTimings = (log: string): Map<string, Timing> => {
  const latest = new Map<string, Timing>();
  const header = new Map<number, HeaderTiming>();
  for (const line of completeLogLines(log)) {
    const marker = [headerMarker, receiptMarker, rangeMarker].find(prefix => line.startsWith(prefix));
    if (!marker) continue;
    const event = requireBoundaryRecord(JSON.parse(line.slice(marker.length)), 'PROGRESS_INVALID_RPC_TIMING');
    if (marker === headerMarker) {
      addHeaderTiming(event, header, latest);
    } else if (event['queueMs'] !== undefined) {
      const receipts = marker === receiptMarker;
      latest.set(receipts ? 'HyperRPC receipts' : 'HyperSync range', {
        queueMs: integer(event['queueMs']),
        upstreamMs: integer(event[receipts ? 'ms' : 'upstreamMs']),
      });
    }
  }
  return latest;
};
