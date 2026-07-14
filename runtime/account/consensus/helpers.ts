import type { AccountMachine, AccountTx, Delta, Env } from '../../types';
import { createStructuredLogger } from '../../infra/logger';
import { txFingerprint } from '../../state-helpers';
import { getReplicaByEntityId } from '../../entity/replica';
import { checkAutoRebalance } from '../tx/handlers/request-collateral';
import { accountStateDomainFromJurisdiction, type AccountStateDomain } from '../state-root';

const accountConsensusHelperLog = createStructuredLogger('account.consensus');

export const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

export const isEntityId32 = (value: unknown): value is string =>
  typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);

type DebugEventEmitter = {
  sendDebugEvent(payload: Record<string, unknown>): void;
};

const isDebugEventEmitter = (value: unknown): value is DebugEventEmitter =>
  typeof value === 'object' &&
  value !== null &&
  'sendDebugEvent' in value &&
  typeof value.sendDebugEvent === 'function';

export const summarizeDeltasForLog = (deltas: Map<number, Delta>) =>
  Array.from(deltas.entries()).map(([tokenId, delta]) => ({
    tokenId,
    collateral: delta.collateral?.toString(),
    ondelta: delta.ondelta?.toString(),
    offdelta: delta.offdelta?.toString(),
    leftCreditLimit: delta.leftCreditLimit?.toString(),
    rightCreditLimit: delta.rightCreditLimit?.toString(),
    leftHold: delta.leftHold?.toString(),
    rightHold: delta.rightHold?.toString(),
  }));

const normalizeEntityRef = (value: unknown): string => String(value || '').toLowerCase();

type AccountDomainSubject = Readonly<{
  proofHeader: Pick<AccountMachine['proofHeader'], 'fromEntity' | 'toEntity'>;
}>;

const trustedAccountDomains = (env: Env, accountMachine: AccountDomainSubject): AccountStateDomain[] => {
  const accountEntities = new Set([
    normalizeEntityRef(accountMachine.proofHeader.fromEntity),
    normalizeEntityRef(accountMachine.proofHeader.toEntity),
  ]);
  const domains: AccountStateDomain[] = [];
  for (const replica of env.eReplicas.values()) {
    const entityId = normalizeEntityRef(replica.state.entityId || replica.entityId);
    if (!accountEntities.has(entityId)) continue;
    const jurisdiction = replica.state.config?.jurisdiction;
    if (!jurisdiction) throw new Error(`ACCOUNT_STATE_DOMAIN_REPLICA_MISSING:${entityId}`);
    domains.push(accountStateDomainFromJurisdiction(jurisdiction));
  }
  return domains;
};

export function getAccountStateDomain(env: Env, accountMachine: AccountDomainSubject): AccountStateDomain {
  const domains = trustedAccountDomains(env, accountMachine);
  if (domains.length === 0) throw new Error('ACCOUNT_STATE_DOMAIN_TRUSTED_CONFIG_MISSING');
  const first = domains[0]!;
  const firstKey = `${first.chainId}:${first.depositoryAddress.toLowerCase()}`;
  const conflict = domains.find((domain) =>
    `${domain.chainId}:${domain.depositoryAddress.toLowerCase()}` !== firstKey,
  );
  if (conflict) {
    throw new Error(
      `ACCOUNT_STATE_DOMAIN_CONFLICT:${firstKey}:${conflict.chainId}:${conflict.depositoryAddress.toLowerCase()}`,
    );
  }
  return first;
}

export function shouldIncludeToken(delta: Delta, totalDelta: bigint): boolean {
  const hasHolds =
    (delta.leftHold || 0n) !== 0n ||
    (delta.rightHold || 0n) !== 0n;

  return !(totalDelta === 0n && delta.leftCreditLimit === 0n && delta.rightCreditLimit === 0n && !hasHolds);
}

type SettlementVector = Map<number, { collateral: bigint; ondelta: bigint }>;

export function captureSettlementVector(accountMachine: AccountMachine): SettlementVector {
  const out: SettlementVector = new Map();
  for (const [tokenId, delta] of accountMachine.deltas.entries()) {
    out.set(tokenId, { collateral: delta.collateral, ondelta: delta.ondelta });
  }
  return out;
}

export function prependUniqueMempoolTxs(accountMachine: AccountMachine, txs: AccountTx[]): number {
  if (txs.length === 0) return 0;
  const existing = new Set(accountMachine.mempool.map(txFingerprint));
  const missing: AccountTx[] = [];
  for (const tx of txs) {
    const fp = txFingerprint(tx);
    if (existing.has(fp)) continue;
    existing.add(fp);
    missing.push(tx);
  }
  if (missing.length > 0) {
    accountMachine.mempool.unshift(...missing);
  }
  return missing.length;
}

export function assertNoUnilateralSettlementMutation(
  accountMachine: AccountMachine,
  before: SettlementVector,
  tx: AccountTx,
  phase: string,
): void {
  if (tx.type === 'j_event_claim') return;
  for (const [tokenId, delta] of accountMachine.deltas.entries()) {
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

const parseBigIntMaybe = (value: unknown): bigint | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
    return undefined;
  } catch {
    return undefined;
  }
};

const parseNumberMaybe = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function resolveAutoRebalanceFeePolicy(
  env: Env,
  accountMachine: AccountMachine,
  counterpartyEntityId: string,
) {
  const hubConfig = getReplicaByEntityId(env, counterpartyEntityId)?.state?.hubRebalanceConfig;
  const accountPolicy = accountMachine.counterpartyRebalanceFeePolicy;
  return {
    policyVersion:
      accountPolicy?.policyVersion ??
      parseNumberMaybe(hubConfig?.policyVersion) ??
      1,
    baseFee:
      accountPolicy?.baseFee ??
      parseBigIntMaybe(hubConfig?.rebalanceBaseFee) ??
      10n ** 17n,
    liquidityFeeBps:
      accountPolicy?.liquidityFeeBps ??
      parseBigIntMaybe(hubConfig?.rebalanceLiquidityFeeBps) ??
      parseBigIntMaybe(hubConfig?.minFeeBps) ??
      1n,
    gasFee:
      accountPolicy?.gasFee ??
      parseBigIntMaybe(hubConfig?.rebalanceGasFee) ??
      0n,
  };
}

export async function runPostFrameAutoRebalanceCheck(
  env: Env,
  accountMachine: AccountMachine,
  ourEntityId: string,
  counterpartyEntityId: string,
  frameHeight: number,
): Promise<AccountTx[]> {
  try {
    const p2p = env.runtimeState?.p2p;
    const emitRebalanceDebug = (payload: Record<string, unknown>) => {
      if (isDebugEventEmitter(p2p)) {
        p2p.sendDebugEvent({
          level: 'info',
          code: 'REB_STEP',
          step: 1,
          accountId: counterpartyEntityId,
          frameHeight,
          ...payload,
        });
      }
    };
    const ourReplica = getReplicaByEntityId(env, ourEntityId);
    const ourIsHub = !!ourReplica?.state?.hubRebalanceConfig;
    const emitSkip = (reason: string) => {
      emitRebalanceDebug({
        status: 'skipped',
        event: 'request_not_queued',
        reason,
        policyCount: accountMachine.shadow.rebalance.policy.size,
        hasPendingFrame: !!accountMachine.pendingFrame,
      });
    };

    if (ourIsHub) {
      emitSkip('our-entity-is-hub');
      return [];
    }

    const rebalanceTxs = checkAutoRebalance(
      accountMachine,
      ourEntityId,
      counterpartyEntityId,
      resolveAutoRebalanceFeePolicy(env, accountMachine, counterpartyEntityId),
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
    accountConsensusHelperLog.debug('auto_rebalance_check.failed', { error: (rebalanceErr as Error).message });
    return [];
  }
}

export function kickHubRebalanceAfterFrameFinalize(env: Env, hubEntityId: string): void {
  for (const replica of env.eReplicas.values()) {
    if (String(replica?.state?.entityId || '').toLowerCase() !== String(hubEntityId || '').toLowerCase()) continue;
    const task = replica.state?.crontabState?.tasks?.get?.('hubRebalance');
    if (!task) continue;
    task.lastRun = 0;
  }
}
