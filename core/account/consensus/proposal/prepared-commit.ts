import type { AccountOutput, AccountReplica, AccountState, AccountTx } from '../../../types/account';
import { RecencyMemo } from '../../../support/collections/recency-memo';
import { peekAccountStateRoot } from '../../commitment/state-root';

/**
 * The transition a proposer validated while building its frame is the exact
 * transition its ACK later commits: `isValidation` changes nothing in the
 * Account transition and the live state cannot move while the frame is
 * pending. Re-executing every tx at ACK time doubled the proposer-side
 * Account work. The prepared replica is kept here, keyed by the frame it
 * certifies, and published at ACK when the base state is still the same
 * object; otherwise ACK falls back to re-execution.
 */
export type PreparedProposalCommit = Readonly<{
  /** Root of the live AccountState the candidate was prepared from. */
  baseRoot: string;
  candidate: AccountReplica;
  accountStateRoot: string;
  candidateEffects: readonly AccountOutput[];
  timedOutHashlocks: readonly string[];
}>;

const PREPARED_COMMIT_TX_TYPES: ReadonlySet<AccountTx['type']> = new Set<AccountTx['type']>([
  'htlc_lock',
  'htlc_resolve',
  'direct_payment',
  'swap_offer',
  'swap_resolve',
  'swap_cancel_request',
]);

/** Only transitions whose handlers read nothing outside AccountState may skip re-execution. */
export const preparedCommitCoversTxs = (txs: readonly AccountTx[]): boolean =>
  txs.every(tx => PREPARED_COMMIT_TX_TYPES.has(tx.type));

const preparedCommits = new RecencyMemo<string, PreparedProposalCommit>(8_192);

export const preparedCommitKey = (account: AccountReplica, stateHash: string): string =>
  `${account.proofHeader.fromEntity.toLowerCase()}|${account.proofHeader.toEntity.toLowerCase()}|${stateHash.toLowerCase()}`;

export const rememberPreparedProposalCommit = (key: string, entry: PreparedProposalCommit): void => {
  preparedCommits.set(key, entry);
};

/**
 * Shells are re-forked every Entity frame, so object identity cannot prove
 * the base is unchanged; the (memoized, structurally invalidated) state root
 * can. Any replaced collection or scalar yields a different root.
 */
export const takePreparedProposalCommit = (
  key: string,
  liveState: AccountState,
): PreparedProposalCommit | undefined => {
  const entry = preparedCommits.get(key);
  if (!entry) return undefined;
  preparedCommits.delete(key);
  // A missing memo means the live state was replaced since the proposal.
  return peekAccountStateRoot(liveState) === entry.baseRoot ? entry : undefined;
};
