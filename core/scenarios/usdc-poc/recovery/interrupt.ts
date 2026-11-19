import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerRuntimeFrameCommitCallback } from '../../../runtime';
import { safeStringify } from '../../../protocol/serialization';
import { type PocUser } from '../user';
import { runtimeProof } from './evidence';

export const installInterruption = (user: PocUser, point: string): void => {
  registerRuntimeFrameCommitCallback(user.env, ({ height }) => {
    const source = [...user.env.state.eReplicas.values()].find(replica => replica.entityId === user.entityId);
    if (!source) return;
    const batch = source.state.jBatchState?.sentBatch;
    const route = [...(source.state.crossJurisdictionSwaps?.values() ?? [])].find(
      item => item.orderId === user.orderId,
    );
    const target = [...user.env.state.eReplicas.values()].find(
      replica => replica.entityId === route?.target.counterpartyEntityId,
    );
    const targetAccount = target?.state.accounts.get(route?.target.entityId ?? '');
    const matches =
      point === 'deposit'
        ? Boolean(batch?.batch.externalTokenToReserve.length)
        : point === 'cross-prepared'
          ? Boolean(route?.sourcePull && route.targetPull && route.status !== 'settled')
          : point === 'cross-closed'
            ? Boolean(
                route?.sourceCloseProof &&
                route.targetCloseProof &&
                ['settled', 'cancelled', 'expired'].includes(route.status),
              )
            : point === 'cover-fee'
              ? Boolean(targetAccount?.state.requestedRebalanceFeeState.size)
              : point === 'withdrawal'
                ? Boolean(target?.state.jBatchState?.sentBatch?.batch.reserveToExternalToken.length)
                : false;
    if (!matches && point !== 'observe') return;
    writeFileSync(
      join(user.directory, point === 'observe' ? 'latest-commit.json' : 'interruption.json'),
      safeStringify(
        {
          ...runtimeProof(user),
          point,
          height,
          entityId: user.entityId,
          depositedAmount: batch?.batch.externalTokenToReserve[0]?.amount,
          batchHash: batch?.batchHash,
          pendingNetworkOutputs: user.env.pendingNetworkOutputs?.length ?? 0,
          route: route
            ? {
                orderId: route.orderId,
                status: route.status,
                expiresAt: route.expiresAt,
                sourcePull: route.sourcePull,
                targetPull: route.targetPull,
                sourceAmount: route.source.amount,
                targetAmount: route.target.amount,
                executionSourceAmount: route.executionSourceAmount,
                executionTargetAmount: route.executionTargetAmount,
              }
            : null,
          feeState: targetAccount?.state.requestedRebalanceFeeState.get(1),
        },
        2,
      ),
    );
    if (point !== 'observe') process.kill(process.pid, 'SIGKILL');
  });
};
