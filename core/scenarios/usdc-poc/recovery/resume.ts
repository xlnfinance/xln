import * as runtime from '../../../runtime';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { runtimeProof } from './evidence';
import { verifyPersistedFrameState } from '../../../storage/recovery/verify';
import { readRuntimeMetadata } from '../../../runtime/loop/loop-environment';
import { deriveDelta, isLeftEntity } from '../../../account/utils';
import { bootUser, closeUser, userReplica, waitFor, send } from '../user';
import { executeCrossSwap, resumeCrossSwap } from '../cross-swap';
import { executeLocalPayout } from '../journey/local-payout';
import { resumePayout } from './payout';
import { installInterruption } from './interrupt';

export const resumeJourney = async (
  apiBase: string,
  directory: string,
  workDir: string,
  interruptPoint = '',
  clearRemainder = false,
) => {
  const user = await bootUser(apiBase, directory, true);
  const { installDuplicateAccountDelivery } = await import('./duplicate');
  installDuplicateAccountDelivery(user);
  try {
    const frame = await runtime.readPersistedStorageFrameRecord(user.env, user.env.state.height);
    if (!frame) throw new Error('USDC_POC_RESTORED_WAL_HEAD_MISSING');
    const verification = verifyPersistedFrameState(user.env, frame);
    if (!verification.ok) throw new Error('USDC_POC_RESTORED_POST_STATE_MISMATCH');
    const restored = { ...runtimeProof(user), verification, replay: readRuntimeMetadata(user.env, '__replayMeta') };
    writeFileSync(join(directory, 'restored.json'), safeStringify(restored, 2));
    console.log(
      `USDC_POC_RESTORED:${safeStringify({
        pid: restored.pid,
        height: restored.height,
        canonicalStateHash: restored.canonicalStateHash,
        replay: restored.replay,
      })}`,
    );
    const hubs = [...userReplica(user).state.accounts.keys()];
    if (hubs.length !== 1 || !hubs[0]) throw new Error('USDC_POC_RESTORE_SOURCE_HUB_NOT_UNIQUE');
    const hub = hubs[0];
    if (interruptPoint) installInterruption(user, interruptPoint);
    runtime.startRuntimeLoop(user.env, {
      onFatal: ({ message }) => {
        console.error(message);
        process.exit(1);
      },
    });
    runtime.startP2P(user.env, { relayUrls: [apiBase.replace('http', 'ws') + '/relay'], gossipSet: 'hubs' });
    runtime.startJurisdictionWatchers(user.env);
    if (clearRemainder) {
      const { recoverPartialClear } = await import('./clear');
      const cleared = await recoverPartialClear(user, hub, apiBase, workDir);
      writeFileSync(join(directory, 'recovered-clear.json'), safeStringify({ restored, cleared }, 2));
      console.log(`USDC_POC_PARTIAL_CLEAR:${cleared.sourceCloseProof.cumulativeSourceAmount}`);
      return;
    }
    const route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
    if (!route) {
      const account = userReplica(user).state.accounts.get(hub);
      const delta = account?.state.deltas.get(1);
      if (!delta || deriveDelta(delta, isLeftEntity(user.entityId, hub)).outCollateral !== 1_000_000n) {
        await waitFor('restored-source-deposit-observed', () => userReplica(user).state.reserves.get(1) === 1_000_000n);
        send(user, [
          { type: 'r2c', data: { counterpartyId: hub, tokenId: 1, amount: 1_000_000n } },
          { type: 'j_broadcast', data: {} },
        ]);
        await waitFor('restored-source-collateral', () => {
          const current = userReplica(user).state.accounts.get(hub);
          const value = current?.state.deltas.get(1);
          return Boolean(
            current &&
            value &&
            !current.pendingFrame &&
            !current.mempool.length &&
            deriveDelta(value, isLeftEntity(user.entityId, hub)).outCollateral === 1_000_000n,
          );
        });
      }
    }
    const target = [...user.env.state.eReplicas.values()].find(
      replica => replica.entityId === route?.target.counterpartyEntityId,
    );
    const account = target?.state.accounts.get(route?.target.entityId ?? '');
    const coverStarted = Boolean(
      account &&
      (account.state.requestedRebalance.size ||
        account.state.settlementWorkspace ||
        target?.state.settlementContinuations?.size ||
        account.state.deltas.get(1)?.collateral),
    );
    const swap = coverStarted
      ? null
      : route
        ? await resumeCrossSwap(user, hub, apiBase, workDir)
        : await executeCrossSwap(user, hub, apiBase, workDir);
    if (swap) {
      const { fundLocalTarget } = await import('../journey/local-funding');
      await fundLocalTarget(user, swap.targetHubEntityId, swap.grossTargetAmount, apiBase);
    }
    const payout = swap
      ? await executeLocalPayout(user, hub, swap, apiBase, workDir)
      : await resumePayout(user, apiBase, workDir);
    writeFileSync(join(directory, 'recovered-payout.json'), safeStringify({ restored, swap, payout }, 2));
    console.log(`USDC_POC_RECOVERED_PAYOUT:${payout.paid}`);
  } finally {
    await closeUser(user);
  }
};
