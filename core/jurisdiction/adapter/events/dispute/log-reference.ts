import { disputePair, earlierReferenceBytes, rememberDisputeReference, type DisputeReferenceState } from './reference-state';
import { ethers } from 'ethers';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import { decodeDisputeLogBody, decodeDisputeFinalizationLog, extractCanonicalDepositoryEventArgs, validateDisputeFinalizationLog } from '../depository-event-codec';
import type { JEvent } from '../../types';
import { DisputeEvidenceUnavailableError } from '../../kernel/failure';

const iface = Depository__factory.createInterface();
type DisputeReferenceLog = { topics: readonly string[]; data: string; blockNumber: number; index?: number; logIndex?: number };
export type ReadDisputeReferenceLogs = (event: JEvent, fromBlock?: number, toBlock?: number) => Promise<readonly DisputeReferenceLog[]>;

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
export const resolveDisputeLogReferences = async (event: JEvent, readLogs: ReadDisputeReferenceLogs, state?: DisputeReferenceState, deploymentBlock?: number): Promise<JEvent> => {
  if (event.name !== 'DisputeFinalized' && event.name !== 'CounterDisputeRegistered') return event;
  const args = { ...event.args };
  const finalized = event.name === 'DisputeFinalized';
  const data = finalized ? validateDisputeFinalizationLog(args) : undefined;
  const field = finalized ? 'finalProofbody' : 'counterProofbody';
  const pair = disputePair(args);
  if (state) {
    const body = earlierReferenceBytes(state.bodies[`${pair}:${String(args[finalized ? 'finalProofbodyHash' : 'proofbodyHash'])}`], event);
    if (!args[field] && body) args[field] = decodeDisputeLogBody({ ...args, proofbody: body }, finalized);
    if (data) args['starterArguments'] = earlierReferenceBytes(state.arguments[
      `${pair}:${String(args['initialNonce'])}:${data.initialProofbodyHash}:${data.starterArgumentsHash}`], event) ?? args['starterArguments'];
  }
  const missing = () => !args[field] || (data && data.starterArgumentsHash !== ethers.keccak256(String(args['starterArguments'] ?? '0x')));
  if (missing()) {
    // Fresh storage anchors need not have observed a pre-anchor dispute. The
    // committed stack deployment is the canonical lower bound, never genesis.
    const start = state?.startBlocks[pair] ?? deploymentBlock;
    if (state && start === undefined) throw new DisputeEvidenceUnavailableError('J_DISPUTE_EVENT_START_BLOCK_MISSING');
    // RPC pages are bounded even when a dispute remains open for years. Local VM
    // callers have their complete in-memory logs and do not perform network I/O.
    for (let from = start; ; from = Number(from) + 256) {
      const to = from === undefined ? undefined : Math.min(from + 255, event.blockNumber);
      const logs = await readLogs(event, from, to).catch(cause => {
        throw new DisputeEvidenceUnavailableError('J_DISPUTE_EVENT_REFERENCE_READ_FAILED', { cause });
      });
      for (const log of logs) {
        const source = earlierSource(event, log);
        if (!source) continue;
        applyReference(event, args, source);
        if (state) rememberDisputeReference(state, { ...event, ...source,
          blockNumber: log.blockNumber, logIndex: Number(log.index ?? log.logIndex) });
      }
      if (!missing() || to === undefined || to >= event.blockNumber) break;
    }
  }
  if (!args[finalized ? 'finalProofbody' : 'counterProofbody']) throw new DisputeEvidenceUnavailableError('J_DISPUTE_EVENT_PROOFBODY_LOG_MISSING');
  return { ...event, args, ...(finalized ? { disputeFinalizationEvidence: decodeDisputeFinalizationLog(args) } : {}) };
};

/** Queries only body-bearing logs at this Depository, in either pair direction. */
export const disputeReferenceFilter = (event: JEvent, address: string, fromBlock = 1, toBlock = event.blockNumber) => ({
  address, fromBlock, toBlock,
  topics: [[iface.getEvent('DisputeStarted').topicHash, iface.getEvent('CounterDisputeRegistered').topicHash],
    [String(event.args['sender']), String(event.args['counterentity'])],
    [String(event.args['sender']), String(event.args['counterentity'])]],
});
