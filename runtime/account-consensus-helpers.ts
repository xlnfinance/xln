import type { AccountMachine, AccountTx, Delta, Env } from './types';
import { txFingerprint } from './state-helpers';

export const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS_HEX_20_RE = /^0x[0-9a-fA-F]{40}$/;

export const isEntityId32 = (value: unknown): value is string =>
  typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);

export const isAddress20 = (value: unknown): value is string =>
  typeof value === 'string' && ADDRESS_HEX_20_RE.test(value);

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

/**
 * Resolve the J-layer depository used in account-frame signatures.
 * Active live jurisdiction wins; BrowserVM is only a fallback for pure local sims.
 */
export function getDepositoryAddress(env: Env): string {
  const browserVMProvider = env.browserVM as
    | (typeof env.browserVM & { browserVM?: { getDepositoryAddress?: () => string } })
    | undefined;
  const browserVMAddress =
    browserVMProvider?.getDepositoryAddress?.() ||
    browserVMProvider?.browserVM?.getDepositoryAddress?.();

  if (env.activeJurisdiction) {
    const jReplica = env.jReplicas.get(env.activeJurisdiction);
    if (jReplica?.jadapter?.addresses?.depository) {
      if (browserVMAddress && browserVMAddress !== jReplica.jadapter.addresses.depository) {
        console.warn(
          `[account-consensus] browserVM depository ${browserVMAddress} ignored in favor of active jurisdiction ` +
            `${env.activeJurisdiction}=${jReplica.jadapter.addresses.depository}`,
        );
      }
      return jReplica.jadapter.addresses.depository;
    }
    if (jReplica?.depositoryAddress) {
      if (browserVMAddress && browserVMAddress !== jReplica.depositoryAddress) {
        console.warn(
          `[account-consensus] browserVM depository ${browserVMAddress} ignored in favor of active jurisdiction ` +
            `${env.activeJurisdiction}=${jReplica.depositoryAddress}`,
        );
      }
      return jReplica.depositoryAddress;
    }
  }

  for (const jReplica of env.jReplicas.values()) {
    if (jReplica.jadapter?.addresses?.depository) {
      return jReplica.jadapter.addresses.depository;
    }
    if (jReplica.depositoryAddress) {
      return jReplica.depositoryAddress;
    }
  }

  if (browserVMAddress && browserVMAddress !== '0x0000000000000000000000000000000000000000') {
    return browserVMAddress;
  }

  console.warn('[account-consensus] ❌ No depositoryAddress found in env');
  return '';
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

export async function runPostFrameAutoRebalanceCheck(
  env: Env,
  accountMachine: AccountMachine,
  ourEntityId: string,
  counterpartyEntityId: string,
  frameHeight: number,
): Promise<AccountTx[]> {
  try {
    const { checkAutoRebalance } = await import('./account-tx/handlers/request-collateral');
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
    const ourReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ourEntityId);
    const counterpartyReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === counterpartyEntityId);
    const ourIsHub = !!ourReplica?.state?.hubRebalanceConfig;
    const emitSkip = (reason: string) => {
      emitRebalanceDebug({
        status: 'skipped',
        event: 'request_not_queued',
        reason,
        policyCount: accountMachine.rebalancePolicy?.size || 0,
        hasPendingFrame: !!accountMachine.pendingFrame,
      });
    };

    if (ourIsHub) {
      emitSkip('our-entity-is-hub');
      return [];
    }

    const hubConfig = counterpartyReplica?.state?.hubRebalanceConfig;
    const accountPolicy = accountMachine.counterpartyRebalanceFeePolicy;
    const DEFAULT_REBALANCE_BASE_FEE = 10n ** 17n; // 0.1 token (18 decimals)
    const DEFAULT_REBALANCE_LIQUIDITY_FEE_BPS = 1n; // 0.01%
    const DEFAULT_REBALANCE_GAS_FEE = 0n;
    const DEFAULT_REBALANCE_POLICY_VERSION = 1;
    const baseFee =
      accountPolicy?.baseFee ??
      parseBigIntMaybe(hubConfig?.rebalanceBaseFee) ??
      DEFAULT_REBALANCE_BASE_FEE;
    const liquidityFeeBps =
      accountPolicy?.liquidityFeeBps ??
      parseBigIntMaybe(hubConfig?.rebalanceLiquidityFeeBps) ??
      parseBigIntMaybe(hubConfig?.minFeeBps) ??
      DEFAULT_REBALANCE_LIQUIDITY_FEE_BPS;
    const gasFee =
      accountPolicy?.gasFee ??
      parseBigIntMaybe(hubConfig?.rebalanceGasFee) ??
      DEFAULT_REBALANCE_GAS_FEE;
    const policyVersion =
      accountPolicy?.policyVersion ??
      parseNumberMaybe(hubConfig?.policyVersion) ??
      DEFAULT_REBALANCE_POLICY_VERSION;

    const rebalanceTxs = checkAutoRebalance(accountMachine, ourEntityId, counterpartyEntityId, {
      policyVersion,
      baseFee,
      liquidityFeeBps,
      gasFee,
    });
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
    console.warn(`⚠️ Auto-rebalance check failed (non-fatal):`, (rebalanceErr as Error).message);
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
