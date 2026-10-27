import { ethers } from 'ethers';
import type { JEvent } from '../../types';

type ReferenceBytes = { bytes: string; blockNumber: number; logIndex: number };
/** Watcher-owned content-addressed evidence; committed with its cursor, never Account state. */
export type DisputeReferenceState = {
  bodies: Record<string, ReferenceBytes>;
  arguments: Record<string, ReferenceBytes>;
  startBlocks: Record<string, number>;
};
export const emptyDisputeReferences = (): DisputeReferenceState => ({ bodies: {}, arguments: {}, startBlocks: {} });
export const disputePair = (args: Record<string, unknown>): string =>
  [String(args['sender']).toLowerCase(), String(args['counterentity']).toLowerCase()].sort().join(':');

export const rememberDisputeReference = (state: DisputeReferenceState, event: JEvent): void => {
  if (event.name !== 'DisputeStarted' && event.name !== 'CounterDisputeRegistered') return;
  const args = event.args;
  const pair = disputePair(args);
  const position = { blockNumber: event.blockNumber, logIndex: Number(event.logIndex) };
  const retain = (map: Record<string, ReferenceBytes>, key: string, bytes: string) => {
    const previous = map[key];
    if (!previous || previous.blockNumber > position.blockNumber
      || (previous.blockNumber === position.blockNumber && previous.logIndex > position.logIndex)) map[key] = { ...position, bytes };
  };
  if (typeof args['proofbody'] === 'string' && args['proofbody'] !== '0x') {
    retain(state.bodies, `${pair}:${String(args['proofbodyHash'])}`, args['proofbody']);
  }
  if (event.name !== 'DisputeStarted') return;
  state.startBlocks[pair] = Math.min(state.startBlocks[pair] ?? event.blockNumber, event.blockNumber);
  for (const field of ['starterInitialArguments', 'starterCounterArguments']) {
    const bytes = String(args[field]);
    retain(state.arguments, `${pair}:${String(args['nonce'])}:${String(args['proofbodyHash'])}:${ethers.keccak256(bytes)}`, bytes);
  }
};

export const earlierReferenceBytes = (entry: ReferenceBytes | undefined, event: JEvent): string | undefined =>
  entry && (entry.blockNumber < event.blockNumber
    || (entry.blockNumber === event.blockNumber && entry.logIndex < Number(event.logIndex))) ? entry.bytes : undefined;

/** Cursor publication must never persist bytes from a later, uncommitted scan. */
export const referencesThrough = (state: DisputeReferenceState, height: number): DisputeReferenceState => ({
  bodies: Object.fromEntries(Object.entries(state.bodies).filter(([, entry]) => entry.blockNumber <= height)),
  arguments: Object.fromEntries(Object.entries(state.arguments).filter(([, entry]) => entry.blockNumber <= height)),
  startBlocks: Object.fromEntries(Object.entries(state.startBlocks).filter(([, block]) => block <= height)),
});

export function validateDisputeReferences(value: unknown, height: number): asserts value is DisputeReferenceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'arguments,bodies,startBlocks') throw new Error('J_DISPUTE_REFERENCE_STATE_INVALID');
  for (const name of ['bodies', 'arguments', 'startBlocks']) {
    const entries: unknown = Reflect.get(value, name);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('J_DISPUTE_REFERENCE_MAP_INVALID');
    for (const [key, entry] of Object.entries(entries)) {
      const word = '0x[0-9a-f]{64}';
      const suffix = name === 'startBlocks' ? '' : name === 'bodies' ? `:${word}` : `:(0|[1-9][0-9]*):${word}:${word}`;
      if (!new RegExp(`^${word}:${word}${suffix}$`).test(key) || key.slice(0, 66) >= key.slice(67, 133)) throw new Error('J_DISPUTE_REFERENCE_KEY_INVALID');
      const block = name === 'startBlocks' ? entry : entry?.blockNumber;
      if (!Number.isSafeInteger(block) || block < 1 || block > height) throw new Error('J_DISPUTE_REFERENCE_HEIGHT_INVALID');
      if (name === 'startBlocks') continue;
      if (!entry || Object.keys(entry).sort().join(',') !== 'blockNumber,bytes,logIndex'
        || !Number.isSafeInteger(entry.logIndex) || entry.logIndex < 0
        || typeof entry.bytes !== 'string' || !/^0x([0-9a-f]{2})*$/.test(entry.bytes)
        || ethers.keccak256(entry.bytes) !== key.slice(-66)) throw new Error('J_DISPUTE_REFERENCE_BYTES_INVALID');
    }
  }
}

export const mergeDisputeReferences = (previous: DisputeReferenceState, next: DisputeReferenceState): DisputeReferenceState => {
  const result = structuredClone(previous);
  for (const name of ['bodies', 'arguments'] as const) {
    for (const [key, entry] of Object.entries(next[name])) {
      const old = result[name][key];
      if (!old || old.blockNumber > entry.blockNumber || (old.blockNumber === entry.blockNumber && old.logIndex > entry.logIndex)) result[name][key] = entry;
    }
  }
  for (const [key, block] of Object.entries(next.startBlocks)) result.startBlocks[key] = Math.min(result.startBlocks[key] ?? block, block);
  return result;
};
