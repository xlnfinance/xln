import { ethers } from 'ethers';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import { decodeDisputeFinalizationLog, extractCanonicalDepositoryEventArgs, validateDisputeFinalizationLog } from '../depository-event-codec';
import type { JEvent } from '../../types';

const iface = Depository__factory.createInterface();
export type DisputeReferenceLog = { topics: readonly string[]; data: string; blockNumber: number; index?: number; logIndex?: number };
export type ReadDisputeReferenceLogs = (event: JEvent) => Promise<readonly DisputeReferenceLog[]>;

const earlierSource = (event: JEvent, log: DisputeReferenceLog) => {
  if (log.blockNumber > event.blockNumber || (log.blockNumber === event.blockNumber
    && Number(log.index ?? log.logIndex) >= Number(event.logIndex))) return null;
  const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  if (!parsed || (parsed.name !== 'DisputeStarted' && parsed.name !== 'CounterDisputeRegistered')) return null;
  const args = extractCanonicalDepositoryEventArgs(parsed);
  const pair = (value: Record<string, unknown>) => [value['sender'], value['counterentity']].map(String).sort().join(':');
  return pair(args) === pair(event.args) ? { name: parsed.name, args } : null;
};

const applyReference = (event: JEvent, args: Record<string, unknown>, source: NonNullable<ReturnType<typeof earlierSource>>): void => {
  const finalized = event.name === 'DisputeFinalized';
  if (args['proofbody'] === '0x' && source.args['proofbodyHash'] === args[finalized ? 'finalProofbodyHash' : 'proofbodyHash']
    && source.args['proofbody'] !== '0x') {
    args[finalized ? 'finalProofbody' : 'counterProofbody'] = source.args[
      source.name === 'DisputeStarted' ? 'initialProofbody' : 'counterProofbody'];
  }
  if (!finalized || source.name !== 'DisputeStarted') return;
  const data = validateDisputeFinalizationLog(args);
  if (source.args['proofbodyHash'] !== data.initialProofbodyHash || String(source.args['nonce']) !== String(args['initialNonce'])) return;
  for (const field of ['starterInitialArguments', 'starterCounterArguments']) {
    const value = source.args[field];
    if (typeof value === 'string' && ethers.keccak256(value) === data.starterArgumentsHash) args['starterArguments'] = value;
  }
};

/** The final receipt commits to every resolved byte string; a forged RPC log cannot substitute bytes. */
export const resolveDisputeLogReferences = async (event: JEvent, readLogs: ReadDisputeReferenceLogs): Promise<JEvent> => {
  if (event.name !== 'DisputeFinalized' && event.name !== 'CounterDisputeRegistered') return event;
  const args = { ...event.args };
  const finalized = event.name === 'DisputeFinalized';
  const data = finalized ? validateDisputeFinalizationLog(args) : undefined;
  if (args['proofbody'] === '0x' || (data && data.starterArgumentsHash !== ethers.keccak256('0x'))) {
    for (const log of await readLogs(event)) {
      const source = earlierSource(event, log);
      if (source) applyReference(event, args, source);
    }
  }
  if (!args[finalized ? 'finalProofbody' : 'counterProofbody']) throw new Error('J_DISPUTE_EVENT_PROOFBODY_LOG_MISSING');
  return { ...event, args, ...(finalized ? { disputeFinalizationEvidence: decodeDisputeFinalizationLog(args) } : {}) };
};

/** Queries only body-bearing logs at this Depository, in either pair direction. */
export const disputeReferenceFilter = (event: JEvent, address: string) => ({
  address, fromBlock: 0, toBlock: event.blockNumber,
  topics: [[iface.getEvent('DisputeStarted').topicHash, iface.getEvent('CounterDisputeRegistered').topicHash],
    [String(event.args['sender']), String(event.args['counterentity'])],
    [String(event.args['sender']), String(event.args['counterentity'])]],
});
