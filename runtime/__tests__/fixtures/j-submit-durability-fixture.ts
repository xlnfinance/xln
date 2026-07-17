import { createEmptyEnv } from '../../runtime';
import { applyRuntimeTx } from '../../machine/tx-handlers';
import {
  registerPendingCommittedJOutbox,
} from '../../machine/j-submit-state';
import { collectDueJSubmitRuntimeTxs } from '../../machine/j-submit-scheduler';
import { createEmptyBatch } from '../../jurisdiction/batch';
import type { EntityReplica, EntityState } from '../../types';

export const entityId = `0x${'31'.repeat(32)}`;
export const signerId = `0x${'41'.repeat(20)}`;
export const jurisdictionName = 'j-submit-durability';
export const batchHash = `0x${'51'.repeat(32)}`;

const makeState = (): EntityState => {
  const batch = createEmptyBatch();
  batch.reserveToReserve.push({ receivingEntity: `0x${'61'.repeat(32)}`, tokenId: 1, amount: 10n });
  return {
    entityId,
    height: 1,
    timestamp: 1_000,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      jurisdiction: {
        name: jurisdictionName,
        chainId: 31337,
        depositoryAddress: '0x000000000000000000000000000000000000dead',
        entityProviderAddress: '0x000000000000000000000000000000000000beef',
      },
    },
    reserves: new Map(),
    accounts: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    profile: { name: 'j-submit', isHub: false, avatar: '', bio: '', website: '' },
    entityEncPubKey: '',
    entityEncPrivKey: '',
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    jBatchState: {
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
    },
  } as EntityState;
};

export const makeJSubmitDurabilityFixture = () => {
  const env = createEmptyEnv('j-submit-durability-seed');
  env.runtimeId = signerId;
  env.timestamp = 2_000;
  env.eReplicas.clear();
  const replica: EntityReplica = {
    entityId,
    signerId,
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
  env.eReplicas.set(`${entityId}:${signerId}`, replica);
  return { env, replica };
};

export const commitJSubmitAttempt = async () => {
  const fixture = makeJSubmitDurabilityFixture();
  const [retry] = collectDueJSubmitRuntimeTxs(fixture.env, fixture.env.timestamp);
  if (!retry) throw new Error('retry fixture missing');
  const jOutbox = await applyRuntimeTx(fixture.env, retry, { isReplay: true });
  registerPendingCommittedJOutbox(fixture.env, jOutbox);
  return { ...fixture, retry, jOutbox };
};
