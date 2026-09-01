/**
 * Localizes a TS Account worker root disagreement to its first divergent
 * Account.
 *
 * The outbound stage ends by comparing the workers' canonical Accounts root
 * against the Entity map the coordinator just folded post-Accounts into. When
 * those disagree the failure is fatal, and the bare pair of hashes says nothing
 * about which Account moved, so this builds the evidence needed to answer that
 * without a second run:
 *
 * - the root each stage claimed, and the frame's base root;
 * - which Accounts each stage reported, and which the continuation was given;
 * - every Account the Entity map changed that no stage reported, and every
 *   Account reported whose Entity leaf disagrees with the published leaf;
 * - every logical shard a stage rebuilt for which no Account was reported,
 *   which is the signature of a root published over an incomplete subset.
 *
 * Diagnostics only: this never repairs a root and never suppresses the halt.
 */

import type { EntityAccountMap } from '../../entity/state/persistent-account-map';
import { safeStringify } from '../../protocol/serialization';
import type { TsAccountWorkerBatchResult, TsAccountWorkerPostAccount } from './protocol';
import { tsAccountLogicalShard } from './sharding';

/** Enough rows to name the divergence, few enough to keep one halt line readable. */
const DIVERGENCE_SAMPLE_LIMIT = 16;

export type AccountRootDivergenceInput = Readonly<{
  frameId: string;
  workers: number;
  /** Entity tx types in this frame that are not Account inputs. */
  entityTxTypes: readonly string[];
  /** Canonical root the coordinator held before the outbound stage opened. */
  baseRoot: string;
  prepare: TsAccountWorkerBatchResult;
  continuation: TsAccountWorkerBatchResult | undefined;
  continuationTxAccountIds: readonly string[];
  continuationProposalAccountIds: readonly string[];
  /** Post-Accounts actually folded into the Entity map, keyed by Account id. */
  applied: ReadonlyMap<string, TsAccountWorkerPostAccount>;
  accounts: EntityAccountMap;
  finalRoot: string;
  entityRoot: string;
}>;

const sample = (values: readonly string[]): readonly string[] =>
  values.slice(0, DIVERGENCE_SAMPLE_LIMIT);

const changedShardIds = (result: TsAccountWorkerBatchResult | undefined): readonly number[] =>
  (result?.changedSubroots ?? []).map(subroot => subroot.shardId);

const stageReport = (
  result: TsAccountWorkerBatchResult | undefined,
): Record<string, unknown> | null => {
  if (!result) return null;
  const accountIds = (result.postAccounts ?? []).map(row => row.accountId);
  const shardIds = changedShardIds(result);
  return {
    accountsRoot: result.accountsRoot ?? null,
    postAccounts: accountIds.length,
    postAccountSample: sample(accountIds),
    changedShards: shardIds.length,
    changedShardSample: shardIds.slice(0, DIVERGENCE_SAMPLE_LIMIT),
  };
};

/**
 * Accounts the workers published a leaf for whose Entity-map leaf disagrees.
 * A non-empty list means the fold produced a different value than the worker
 * hashed, so the Account document, not the shard bookkeeping, is at fault.
 * A live candidate map carries no leaf index, so it reports its dirty set
 * instead.
 */
const leafMismatches = (
  applied: AccountRootDivergenceInput['applied'],
  accounts: EntityAccountMap,
): readonly string[] | null => {
  if (!('valueHashAt' in accounts)) return null;
  const rows: string[] = [];
  for (const [accountId, row] of applied) {
    const live = accounts.valueHashAt(accountId);
    if (live === row.entityAccountLeaf) continue;
    rows.push(`${accountId}:worker=${row.entityAccountLeaf}:entity=${String(live)}`);
    if (rows.length >= DIVERGENCE_SAMPLE_LIMIT) break;
  }
  return rows;
};

/**
 * Accounts the Entity map changed this frame that no stage reported. Those
 * moved outside the workers' view, so the published root cannot describe them.
 */
const unreportedDirtyAccounts = (
  applied: AccountRootDivergenceInput['applied'],
  accounts: EntityAccountMap,
): readonly string[] | null => {
  if (!('dirtyKeys' in accounts)) return null;
  return [...accounts.dirtyKeys()]
    .filter(accountId => !applied.has(accountId))
    .sort()
    .map(accountId => {
      // Whether the Account existed before this frame separates "the Entity
      // created an Account the workers were never told about" from "the Entity
      // edited an Account the workers already hold".
      const certified = accounts.getCertifiedBase(accountId);
      const live = accounts.get(accountId);
      return `${accountId}:base=${certified === undefined ? 'absent' : String(certified.currentHeight)}`
        + `:live=${live === undefined ? 'deleted' : String(live.currentHeight)}`
        + `:status=${String(live?.status ?? 'active')}`;
    });
};

/**
 * Shards a stage rebuilt without reporting any Account in them. The workers
 * moved state the Entity map was never told about, so the published root
 * covers a set the fold could not reproduce.
 */
const unreportedShards = (input: AccountRootDivergenceInput): readonly number[] => {
  const reported = new Set<number>();
  for (const accountId of input.applied.keys()) reported.add(tsAccountLogicalShard(accountId));
  const changed = new Set<number>([
    ...changedShardIds(input.prepare),
    ...changedShardIds(input.continuation),
  ]);
  return [...changed].filter(shardId => !reported.has(shardId)).sort((left, right) => left - right);
};

const describeAccountRootDivergence = (input: AccountRootDivergenceInput): string => {
  const missingShards = unreportedShards(input);
  const unreportedDirty = unreportedDirtyAccounts(input.applied, input.accounts);
  return safeStringify({
    frameId: input.frameId,
    workers: input.workers,
    entityTxTypes: input.entityTxTypes,
    baseRoot: input.baseRoot,
    finalRoot: input.finalRoot,
    entityRoot: input.entityRoot,
    entityAccounts: input.accounts.size,
    prepare: stageReport(input.prepare),
    continuation: stageReport(input.continuation),
    continuationInput: {
      txAccountIds: sample(input.continuationTxAccountIds),
      proposalAccountIds: sample(input.continuationProposalAccountIds),
    },
    foldedAccounts: input.applied.size,
    leafMismatches: leafMismatches(input.applied, input.accounts),
    unreportedDirtyAccounts: unreportedDirty && sample(unreportedDirty),
    unreportedDirtyAccountCount: unreportedDirty?.length ?? null,
    unreportedChangedShards: missingShards.slice(0, DIVERGENCE_SAMPLE_LIMIT),
    unreportedChangedShardCount: missingShards.length,
  });
};

/**
 * The outbound stage's terminal invariant: the workers' canonical Accounts root
 * must equal the Entity map the coordinator just folded into. A disagreement is
 * always fatal — this never repairs, recomputes or tolerates one; it only
 * attaches the evidence that names the divergent Account.
 */
export const assertAccountRootMatch = (input: AccountRootDivergenceInput): void => {
  if (input.entityRoot === input.finalRoot) return;
  throw new Error(
    `TS_ACCOUNT_WORKER_PROVIDER_ROOT_MISMATCH:${input.finalRoot}:${input.entityRoot}:`
    + describeAccountRootDivergence(input),
  );
};
