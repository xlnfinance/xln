import type { AccountReplica, AccountTx, Delta } from '../../types/account';
import type { AccountOutput } from '../../types/account';
import type { JReplica } from '../../types/jurisdiction-runtime';
import { createStructuredLogger } from '../../infra/logger';
import { txFingerprint } from '../../protocol/tx-multiset';
import {
  checkAutoRebalance,
  resolveAutoRebalanceFeePolicy,
} from '../tx/handlers/request-collateral';
import { normalizeAccountStateDomain, type AccountStateDomain } from '../state-root';
import { assertAccountMempoolWithinLimit } from '../mempool';
import {
  firstUsableContractAddress,
  requireDurableJurisdictionStack,
} from '../../jurisdiction/contract-address';
import { buildAccountProofBody } from '../../protocol/dispute/proof-builder';

const accountConsensusHelperLog = createStructuredLogger('account.consensus');

export const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

export const isEntityId32 = (value: unknown): value is string =>
  typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);

export const summarizeDeltasForLog = (deltas: Map<number, Delta>) =>
  Array.from(deltas.entries()).map(([tokenId, delta]) => ({
    tokenId,
    collateral: delta.collateral?.toString(),
    ondelta: delta.ondelta?.toString(),
    offdelta: delta.offdelta?.toString(),
    leftCreditLimit: delta.leftCreditLimit?.toString(),
    rightCreditLimit: delta.rightCreditLimit?.toString(),
    leftHold: delta.leftHold.toString(),
    rightHold: delta.rightHold.toString(),
  }));

type AccountDomainSubject = Readonly<{
  domain: AccountStateDomain;
}>;

export type AccountJurisdictionView = Readonly<{
  jReplicas: ReadonlyMap<string, JReplica>;
}>;

export function getAccountStateDomain(account: AccountDomainSubject): AccountStateDomain {
  return normalizeAccountStateDomain(account.domain);
}

/**
 * Resolve the built-in DeltaTransformer from the exact durable jurisdiction
 * selected by the Entity-certified Account domain. Names, active-J defaults,
 * live adapters and peer payloads are deliberately ignored: only the imported
 * `(chainId, Depository) -> contracts` record is proof authority.
 */
export function requireAccountDeltaTransformerAddress(
  jurisdictions: AccountJurisdictionView,
  account: AccountDomainSubject,
): string {
  const domain = getAccountStateDomain(account);
  const depository = domain.depositoryAddress.toLowerCase();
  const matches = Array.from(jurisdictions.jReplicas.values()).flatMap((replica) => {
    if (Number(replica.chainId) !== domain.chainId) return [];
    const canonicalDepository = firstUsableContractAddress(replica.contracts?.depository)?.toLowerCase();
    const aliasDepository = firstUsableContractAddress(replica.depositoryAddress)?.toLowerCase();
    if (canonicalDepository !== depository && aliasDepository !== depository) return [];
    const stack = requireDurableJurisdictionStack(replica);
    return stack.depository === depository ? [stack] : [];
  });
  if (matches.length === 0) {
    throw new Error(`ACCOUNT_PROOF_JURISDICTION_NOT_FOUND:${domain.chainId}:${depository}`);
  }
  if (matches.length > 1) {
    throw new Error(`ACCOUNT_PROOF_JURISDICTION_AMBIGUOUS:${domain.chainId}:${depository}`);
  }
  return matches[0]!.deltaTransformer;
}

export const buildAccountProofBodyFromJurisdictions = (
  jurisdictions: AccountJurisdictionView,
  account: AccountReplica,
) =>
  buildAccountProofBody(
    account,
    requireAccountDeltaTransformerAddress(jurisdictions, account),
  );

export function shouldIncludeToken(delta: Delta, totalDelta: bigint): boolean {
  const hasHolds = delta.leftHold !== 0n || delta.rightHold !== 0n;

  return !(totalDelta === 0n && delta.leftCreditLimit === 0n && delta.rightCreditLimit === 0n && !hasHolds);
}

type SettlementVector = Map<number, { collateral: bigint; ondelta: bigint }>;

export function captureSettlementVector(account: AccountReplica): SettlementVector {
  const out: SettlementVector = new Map();
  for (const [tokenId, delta] of account.deltas.entries()) {
    out.set(tokenId, { collateral: delta.collateral, ondelta: delta.ondelta });
  }
  return out;
}

export function prependUniqueMempoolTxs(account: AccountReplica, txs: AccountTx[]): number {
  if (txs.length === 0) return 0;
  const existing = new Set(account.mempool.map(txFingerprint));
  const missing: AccountTx[] = [];
  for (const tx of txs) {
    // Each direct payment is one separately authorized intent even when its
    // projected Account bytes match another payment exactly. Same-frame
    // rollback is already idempotent by the authenticated frame hash.
    if (tx.type === 'direct_payment') {
      missing.push(tx);
      continue;
    }
    const fp = txFingerprint(tx);
    if (existing.has(fp)) continue;
    existing.add(fp);
    missing.push(tx);
  }
  if (missing.length > 0) {
    // These txs move out of pendingFrame rather than entering from outside, so
    // validate the resulting queue itself. The caller clears pendingFrame only
    // after this atomic prepend succeeds.
    const nextMempool = [...missing, ...account.mempool];
    assertAccountMempoolWithinLimit(
      { mempool: nextMempool },
      'accountConsensus:rollbackRestore',
    );
    account.mempool = nextMempool;
  }
  return missing.length;
}

export function assertNoUnilateralSettlementMutation(
  account: AccountReplica,
  before: SettlementVector,
  tx: AccountTx,
  phase: string,
): void {
  if (tx.type === 'j_event_claim') return;
  for (const [tokenId, delta] of account.deltas.entries()) {
    const prev = before.get(tokenId);
    const prevCollateral = prev?.collateral ?? 0n;
    const prevOndelta = prev?.ondelta ?? 0n;
    if (!prev && delta.collateral === 0n && delta.ondelta === 0n) continue;
    if (delta.collateral !== prevCollateral || delta.ondelta !== prevOndelta) {
      throw new Error(
        `INVARIANT_VIOLATION[${phase}]: tx=${tx.type} mutated collateral/ondelta ` +
          `token=${tokenId} collateral ${prevCollateral}->${delta.collateral} ondelta ${prevOndelta}->${delta.ondelta}`,
      );
    }
  }
}

type TokenizedAccountTx = AccountTx & {
  data?: {
    tokenId?: unknown;
  };
};

export { resolveAutoRebalanceFeePolicy };

export async function runPostFrameAutoRebalanceCheck(
  account: AccountReplica,
  ourEntityId: string,
  counterpartyEntityId: string,
  frameHeight: number,
  owningEntityIsHub: boolean,
  candidateEffects: AccountOutput[] = [],
): Promise<AccountTx[]> {
  try {
    const emitRebalanceDebug = (payload: Record<string, unknown>) => {
      candidateEffects.push({
        kind: 'debug',
        payload: {
          level: 'info',
          code: 'REB_STEP',
          step: 1,
          accountId: counterpartyEntityId,
          frameHeight,
          ...payload,
        },
      });
    };
    const emitSkip = (reason: string) => {
      emitRebalanceDebug({
        status: 'skipped',
        event: 'request_not_queued',
        reason,
        policyCount: account.shadow.rebalance.policy.size,
        hasPendingFrame: !!account.pendingFrame,
      });
    };

    if (owningEntityIsHub) {
      emitSkip('our-entity-is-hub');
      return [];
    }

    const hasCounterpartyPolicy = Array.from(account.shadow.rebalance.policy.keys())
      .some((tokenId) => resolveAutoRebalanceFeePolicy(account, ourEntityId, tokenId));
    if (!hasCounterpartyPolicy) {
      emitSkip('counterparty-fee-policy-missing');
      return [];
    }

    const rebalanceTxs = checkAutoRebalance(
      account,
      ourEntityId,
      counterpartyEntityId,
    );
    if (rebalanceTxs.length > 0) {
      emitRebalanceDebug({
        status: 'ok',
        event: 'request_queued',
        txCount: rebalanceTxs.length,
        tokenIds: rebalanceTxs
          .map((tx: TokenizedAccountTx) => tx.data?.tokenId)
          .filter((v: unknown) => typeof v === 'number'),
      });
      return rebalanceTxs;
    }
    emitSkip('fee-policy-or-threshold');
    return [];
  } catch (rebalanceErr) {
    accountConsensusHelperLog.error('auto_rebalance_check.failed', {
      error: rebalanceErr instanceof Error ? rebalanceErr.message : String(rebalanceErr),
    });
    throw rebalanceErr;
  }
}
