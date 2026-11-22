import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { runProgressMarker, slotProgressMarker } from '../../execution/flow/progress-events';

export const completeLogLines = (log: string): string[] => log.split(/\r?\n/).slice(0, -1);

const record = (json: string, label: string) => requireBoundaryRecord(JSON.parse(json), label);
const integer = (value: unknown, label: string) => requireBoundaryInteger(value, label, 0);

const token = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,48}$/.test(value)) throw new Error(label);
  return value;
};

export const readRunProgress = (log: string) => {
  const line = completeLogLines(log).find(line => line.startsWith(runProgressMarker));
  if (!line) return null;
  const event = record(line.slice(runProgressMarker.length), 'PROGRESS_INVALID_RUN');
  return {
    runId: token(event['runId'], 'PROGRESS_INVALID_RUN_ID'),
    expiresAt: integer(event['expiresAt'], 'PROGRESS_INVALID_EXPIRY'),
  };
};

export type Scan = { first: number | null; through: number; cursor: number; target: number | null };
const rangeMarker = ' watcher.authenticated_range ';
const startupMarker = ' watcher.startup_progress ';

const readRange = (json: string, scans: Map<number, Scan>): void => {
  const event = record(json, 'PROGRESS_INVALID_RANGE');
  const chainId = integer(event['chainId'], 'PROGRESS_INVALID_CHAIN');
  const first = requireBoundaryInteger(event['fromBlock'], 'PROGRESS_INVALID_FROM_BLOCK', 1);
  scans.set(chainId, {
    first: scans.get(chainId)?.first ?? first,
    through: requireBoundaryInteger(event['toBlock'], 'PROGRESS_INVALID_TO_BLOCK', first),
    cursor: integer(event['committedBeforeRange'], 'PROGRESS_INVALID_COMMITTED_CURSOR'),
    target: scans.get(chainId)?.target ?? null,
  });
};

const readStartup = (json: string, scans: Map<number, Scan>): boolean => {
  const event = record(json, 'PROGRESS_INVALID_STARTUP');
  const chains = event['chains'];
  const complete = event['complete'];
  if (!Array.isArray(chains) || typeof complete !== 'boolean') throw new Error('PROGRESS_INVALID_STARTUP');
  for (const item of chains) {
    const chain = requireBoundaryRecord(item, 'PROGRESS_INVALID_STARTUP_CHAIN');
    const chainId = integer(chain['chainId'], 'PROGRESS_INVALID_CHAIN');
    scans.set(chainId, {
      first: scans.get(chainId)?.first ?? null,
      through: integer(chain['authenticatedThrough'], 'PROGRESS_INVALID_AUTHENTICATED_CURSOR'),
      cursor: integer(chain['committedCursor'], 'PROGRESS_INVALID_COMMITTED_CURSOR'),
      target: integer(chain['targetBlock'], 'PROGRESS_INVALID_STARTUP_TARGET'),
    });
  }
  return complete;
};

export const readCatchUp = (lines: readonly string[]) => {
  const scans = new Map<number, Scan>();
  let complete: boolean | null = null;
  for (const line of lines) {
    const range = line.indexOf(rangeMarker);
    const startup = line.indexOf(startupMarker);
    if (range >= 0) readRange(line.slice(range + rangeMarker.length), scans);
    if (startup >= 0) complete = readStartup(line.slice(startup + startupMarker.length), scans);
  }
  return { scans, complete };
};

const statuses = {
  attempted: 'attempted, acceptance unknown',
  submitted: 'accepted by RPC',
  known: 'already known to RPC',
  confirmed: 'confirmed',
  reverted: 'reverted',
  conflict: 'nonce conflict',
  pending: 'pending',
  unobserved: 'unobserved',
  unavailable: 'receipt evidence unavailable',
} as const;

const decodeSlot = (json: string) => {
  const event = record(json, 'PROGRESS_INVALID_SLOT');
  const status = event['status'];
  const hash = event['hash'];
  if (typeof status !== 'string' || !Object.hasOwn(statuses, status)) throw new Error('PROGRESS_INVALID_SLOT_STATUS');
  if (hash !== null && (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)))
    throw new Error('PROGRESS_INVALID_SLOT_HASH');
  return {
    runId: token(event['runId'], 'PROGRESS_INVALID_RUN_ID'),
    step: token(event['step'], 'PROGRESS_INVALID_STEP'),
    chainId: integer(event['chainId'], 'PROGRESS_INVALID_CHAIN'),
    nonce: integer(event['nonce'], 'PROGRESS_INVALID_NONCE'),
    phase: status as keyof typeof statuses,
    hash,
  };
};

export const readSlots = (gateway: string, execution: string, runId?: string) => {
  const slots = new Map<string, { latest: ReturnType<typeof decodeSlot>; send?: ReturnType<typeof decodeSlot> }>();
  for (const line of [...completeLogLines(gateway), ...completeLogLines(execution)]) {
    if (!line.startsWith(slotProgressMarker)) continue;
    const event = decodeSlot(line.slice(slotProgressMarker.length));
    if (runId !== undefined && event.runId !== runId) continue;
    const key = `${event.runId}:${event.chainId}:${event.step}:${event.nonce}`;
    const send = ['attempted', 'submitted', 'known'].includes(event.phase) ? event : slots.get(key)?.send;
    slots.set(key, { latest: event, ...(send ? { send } : {}) });
  }
  return [...slots.values()].map(({ latest, send }) => ({
    ...latest,
    hash: latest.hash ?? send?.hash ?? null,
    status:
      (latest.phase === 'unavailable' || latest.phase === 'unobserved') && send
        ? `${statuses[send.phase]} | ${statuses[latest.phase]}`
        : statuses[latest.phase],
  }));
};
