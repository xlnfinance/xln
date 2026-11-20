import { readPersistedAccountFrameHistoryRecords, readPersistedStorageFrameRecord } from '../../../../../core/runtime';
import type { RuntimeReplica } from '../../../../../core/runtime/types';
import { assertStorageFrameHash } from '../../../../../core/storage/read/integrity/native-authority';
import type { CrossJurisdictionSwapRoute } from '../../../../../core/types/cross-jurisdiction';
import type { ChainAuthority } from '../authority';

const readClose = async (
  env: RuntimeReplica,
  chain: ChainAuthority,
  route: CrossJurisdictionSwapRoute,
  pullId: string,
  maxRuntimeHeight: number,
) => {
  const history = await readPersistedAccountFrameHistoryRecords(env, chain.userEntity, chain.hubEntity, 10_000, {
    maxRuntimeHeight,
    requireLazyCertificate: true,
  });
  const close = history.findLast(({ frame }) =>
    frame.accountTxs.some(
      tx =>
        tx.type === 'cross_pull_close' &&
        tx.data.pullId === pullId &&
        tx.data.proof.orderId === route.orderId &&
        tx.data.proof.routeHash === route.routeHash &&
        tx.data.proof.closeMode === 'full',
    ),
  );
  if (!close?.certificate) throw new Error(`USDC_EXECUTION_CROSS_J_CLOSE_EVIDENCE_MISSING:${chain.chainId}`);
  const { height, stateHash, accountStateRoot } = close.frame;
  return { height, runtimeHeight: close.runtimeHeight, stateHash, accountStateRoot, ...close.certificate, pullId };
};

const readAuthorization = async (env: RuntimeReplica, route: CrossJurisdictionSwapRoute, before: number) => {
  for (let height = before; height > 0; height--) {
    const frame = await readPersistedStorageFrameRecord(env, height);
    if (!frame) continue;
    assertStorageFrameHash(frame);
    for (const input of frame.runtimeInput.entityInputs) {
      for (const tx of input.entityTxs ?? []) {
        if (
          tx.type === 'prepareCrossJurisdictionSwap' &&
          tx.data.route.orderId === route.orderId &&
          tx.data.route.routeHash === route.routeHash
        )
          return { route: tx.data.route, runtimeHeight: height };
      }
    }
  }
  throw new Error('USDC_EXECUTION_CROSS_J_AUTHORIZATION_MISSING');
};

export const readCrossJProof = async (
  env: RuntimeReplica,
  source: ChainAuthority,
  target: ChainAuthority,
  route: CrossJurisdictionSwapRoute,
) => {
  if (!route.sourcePull || !route.targetPull) throw new Error('USDC_EXECUTION_CROSS_J_PULLS_MISSING');
  const head = env.state.height;
  const sourceProof = await readClose(env, source, route, route.sourcePull.pullId, head);
  const targetProof = await readClose(env, target, route, route.targetPull.pullId, head);
  const authorization = await readAuthorization(
    env,
    route,
    Math.min(sourceProof.runtimeHeight, targetProof.runtimeHeight),
  );
  return {
    authorization: authorization.route,
    authorizedAtRuntimeHeight: authorization.runtimeHeight,
    sourceProof,
    targetProof,
  };
};
