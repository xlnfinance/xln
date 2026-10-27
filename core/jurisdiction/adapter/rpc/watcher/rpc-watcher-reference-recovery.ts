import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { JReplica } from '../../../../types/jurisdiction-runtime';
import { decodeJEventLog } from '../../j-event-log-decoder';
import { isJEventRelevantToWatcher } from '../../events/event-observation';
import { rememberDisputeReference, type DisputeReferenceState } from '../../events/dispute/reference-state';
import { prepareAuthenticatedWatcherIngress } from '../../rpc-public';
import type { AuthenticatedReceiptRange } from '../../receipt-root';

const iface = Depository__factory.createInterface();

type RecoveryRequest = {
  env: RuntimeReplica;
  watcherReplica: JReplica;
  references: DisputeReferenceState;
  fromBlock: number;
  toBlock: number;
  tipBlockHash: string;
  targetFinalized: boolean;
  isCancelled?(): boolean;
  readRange(from: number, to: number): Promise<AuthenticatedReceiptRange>;
};

/** Entity certification can fsync before the shared cursor/cache. Reauthenticate
 * that gap before publishing a cursor: hash-valid bytes alone cannot prove the
 * start coordinate. Link every page to the next and the final certified anchor;
 * remember only, so a finalized hash-only event cannot stall recovery. */
export const rebuildWatcherDisputeReferences = async (request: RecoveryRequest): Promise<DisputeReferenceState | null> => {
  const references = structuredClone(request.references);
  let parentHash: string | undefined;
  for (let from = request.fromBlock; from <= request.toBlock; from += 256) {
    if (request.isCancelled?.()) return null;
    const to = Math.min(from + 255, request.toBlock);
    const range = await request.readRange(from, to);
    if (request.isCancelled?.()) return null;
    const ingress = prepareAuthenticatedWatcherIngress(range, parentHash
      ? { height: from - 1, hash: parentHash, finalized: false } : undefined);
    for (const log of ingress.logs) {
      if (log.address.toLowerCase() !== request.watcherReplica.contracts?.depository?.toLowerCase()) continue;
      const event = decodeJEventLog(log, iface, { ...log, logIndex: log.index }, 'J_REFERENCE_RECOVERY_DECODE');
      if (isJEventRelevantToWatcher(request.env, event, request.watcherReplica)) rememberDisputeReference(references, event);
    }
    parentHash = ingress.tipBlockHash;
  }
  if (request.fromBlock <= request.toBlock && parentHash !== request.tipBlockHash.toLowerCase()) {
    const code = request.targetFinalized ? 'J_DISPUTE_REFERENCE_ANCHOR_MISMATCH' : 'J_RECEIPT_RANGE_REORG';
    throw new Error(`${code}:${request.toBlock}`);
  }
  return references;
};
