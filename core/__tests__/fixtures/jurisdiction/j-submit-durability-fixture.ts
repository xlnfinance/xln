import { createEmptyEnv } from '../../../runtime';
import { applyRuntimeTx } from '../../../runtime/tx/tx-handlers';
import {
  registerPendingCommittedJOutbox,
} from '../../../runtime/j-submit/j-submit-state';
import { collectDueJSubmitRuntimeTxs } from '../../../runtime/j-submit/j-submit-scheduler';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import type { EntityReplica, EntityState } from '../../../entity/types';
import { makeState as makeCanonicalEntityState } from '../../helpers/cross-j';

export const entityId = `0x${'31'.repeat(32)}`;
export const signerId = `0x${'41'.repeat(20)}`;
export const jurisdictionName = 'j-submit-durability';
export const batchHash = `0x${'51'.repeat(32)}`;

const makeState = (): EntityState => {
  const batch = createEmptyBatch();
  batch.reserveToReserve.push({ receivingEntity: `0x${'61'.repeat(32)}`, tokenId: 1, amount: 10n });
  const state = makeCanonicalEntityState(entityId, signerId, {
    name: jurisdictionName,
    address: `rpc://${jurisdictionName}`,
    chainId: 31_337,
    blockTimeMs: 1_000,
    depositoryAddress: '0x000000000000000000000000000000000000dead',
    entityProviderAddress: '0x000000000000000000000000000000000000beef',
  });
  state.profile = { name: 'j-submit', isHub: false, avatar: '', bio: '', website: '' };
  state.jBatchState = {
    batch: createEmptyBatch(),
    jurisdiction: null,
    lastBroadcast: 1_000,
    broadcastCount: 1,
    failedAttempts: 0,
    status: 'sent',
    sentBatch: {
      batch,
      batchHash,
      encodedBatch: '0x1234',
      entityNonce: 1,
      firstSubmittedAt: 1_000,
      lastSubmittedAt: 0,
      submitAttempts: 0,
    },
  };
  return state;
};

export const makeJSubmitDurabilityFixture = () => {
  const env = createEmptyEnv('j-submit-durability-seed');
  env.runtimeId = signerId;
  env.state.timestamp = 2_000;
  env.state.eReplicas.clear();
  const replica: EntityReplica = {
    entityId,
    signerId,
    entityEncPubKey: `0x${'71'.repeat(32)}`,
    state: makeState(),
    mempool: [],
    isProposer: true,
    hankoWitness: new Map([[batchHash, {
      hanko: '0x1234',
      type: 'jBatch',
      entityHeight: 1,
      createdAt: 1_000,
    }]]),
  };
  env.state.eReplicas.set(`${entityId}:${signerId}`, replica);
  return { env, replica };
};

export const commitJSubmitAttempt = async () => {
  const fixture = makeJSubmitDurabilityFixture();
  const [retry] = collectDueJSubmitRuntimeTxs(fixture.env, fixture.env.state.timestamp);
  if (!retry) throw new Error('retry fixture missing');
  const jOutbox = await applyRuntimeTx(fixture.env, retry, { isReplay: true });
  registerPendingCommittedJOutbox(fixture.env, jOutbox);
  return { ...fixture, retry, jOutbox };
};
