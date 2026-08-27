import type { AccountOutput, AccountReplica, AccountState, AccountTx } from '../../../types/account';
import { RecencyMemo } from '../../../support/collections/recency-memo';
import { peekAccountStateRoot } from '../../commitment/state-root';
import { ACCOUNT_LIVE_ENVELOPE } from '../../state/candidate-overlay';
import type { ApplyAccountTxOk } from '../../tx/apply-types';

/**
 * The transition a proposer validated while building its frame is the exact
 * transition its ACK later commits: `isValidation` changes nothing in the
 * Account transition and the live state cannot move while the frame is
 * pending. Re-executing every tx at ACK time doubled the proposer-side
 * Account work. Only the bilateral AccountState transition is kept here,
 * keyed by the frame it certifies, and published at ACK when the live
 * bilateral root is still the base root; otherwise ACK re-executes.
 * Entity-private replica fields (shadow, dispute draft, proof nonce) keep
 * moving while the ACK is outstanding and are never part of the cache.
 */
export type PreparedProposalCommit = Readonly<{
  /** Root of the live AccountState the candidate was prepared from. */
  baseRoot: string;
  state: AccountState;
  accountStateRoot: string;
  candidateEffects: readonly AccountOutput[];
  txResults: readonly ApplyAccountTxOk[];
  timedOutHashlocks: readonly string[];
  /** Reducer time already spent on these txs at proposal time. */
  applyUs: number;
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

const sameByIdentity = (left: object, right: object, skip: ReadonlySet<string>): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (skip.has(key)) continue;
    if (Reflect.get(left, key) !== Reflect.get(right, key)) return false;
  }
  return true;
};

const SHADOW_REBALANCE_KEY: ReadonlySet<string> = new Set(['rebalance']);
const STATE_KEY: ReadonlySet<string> = new Set(['state', 'shadow']);
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Every replica field outside the live frame envelope must be the same
 * object on the candidate as on the base (the draft shell copies references;
 * untouched persistent collections keep their wrapper identity). Any replaced
 * field proves the transition wrote outside the bilateral state — forwards,
 * dispute drafts, shadow quotes — and the transition must not be replayed
 * from the cache. Derived from the envelope, so a new replica field fails
 * closed instead of being silently overwritten at ACK.
 */
export const preparedCommitLeavesPrivateStateUntouched = (
  base: AccountReplica,
  candidate: AccountReplica,
): boolean => {
  const skip = new Set<string>([...ACCOUNT_LIVE_ENVELOPE, ...STATE_KEY]);
  if (!sameByIdentity(base, candidate, skip)) return false;
  if (!sameByIdentity(base.shadow, candidate.shadow, SHADOW_REBALANCE_KEY)) return false;
  return sameByIdentity(base.shadow.rebalance, candidate.shadow.rebalance, NO_KEYS);
};

const preparedCommits = new RecencyMemo<string, PreparedProposalCommit>(8_192);

export const preparedCommitKey = (account: AccountReplica, stateHash: string): string =>
  `${account.proofHeader.fromEntity.toLowerCase()}|${account.proofHeader.toEntity.toLowerCase()}|${stateHash.toLowerCase()}`;

export const rememberPreparedProposalCommit = (key: string, entry: PreparedProposalCommit): void => {
  preparedCommits.set(key, entry);
};

/** Read the canonical prepared candidate without consuming the later ACK fast path. */
export const peekPreparedProposalCommit = (
  key: string,
  liveState: AccountState,
): PreparedProposalCommit | undefined => {
  const entry = preparedCommits.get(key);
  return entry && peekAccountStateRoot(liveState) === entry.baseRoot ? entry : undefined;
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
