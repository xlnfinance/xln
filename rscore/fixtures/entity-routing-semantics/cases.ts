import { createHash } from 'node:crypto';

import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { encodeAccountStateValue } from '../../../core/account/commitment/state-root';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import { computeCanonicalEntityConsensusStateHashCold, computeEntityAccountValueHash } from '../../../core/entity/consensus/state-root';
import { readEntityFrameEvents } from '../../../core/entity/frame-events';
import type { EntityRuntimeContext } from '../../../core/entity/runtime-context';
import { PersistentEntityAccountMap } from '../../../core/entity/state/persistent-account-map';
import { initCrontab } from '../../../core/entity/scheduler';
import { applyEntityTx } from '../../../core/entity/tx/apply';
import { applyEntityFrame } from '../../../core/entity/consensus/frame/application';
import type { EntityCandidateEffect, EntityState } from '../../../core/entity/types';
import { canonicalAccountTxForFrameHash } from '../../../core/account/consensus/frame/hash';
import type { EntityTx } from '../../../core/types/entity-tx';
import { createEmptyEnv } from '../../../core/runtime';
import { buildJEventRangeData } from '../../../core/__tests__/helpers/j-history';
import { installJurisdictions, makeJurisdiction, makeState, registerTestSigner } from '../../../core/__tests__/helpers/cross-j';

const HUB = `0x${'11'.repeat(32)}`;
const PEER = `0x${'22'.repeat(32)}`;
const EXTERNAL = `0x${'33'.repeat(32)}`;
const CONTRACT = `0x${'44'.repeat(20)}`;

const digest = (value: unknown): string =>
  `0x${createHash('sha256').update(encodeAccountStateValue(value)).digest('hex')}`;

const state = (): EntityState => ({
  entityId: HUB,
  entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
  height: 0,
  timestamp: 2_000,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [HUB],
    shares: { [HUB]: 1n },
  },
  leaderState: { activeValidatorId: HUB, view: 0, changedAtHeight: 0 },
  reserves: new Map([[1, 100n]]),
  accounts: PersistentEntityAccountMap.empty(HUB, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: { name: 'entity-kernel-fixture', isHub: true, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
  crontabState: initCrontab(),
  hubRebalanceConfig: {
    matchingStrategy: 'amount',
    policyVersion: 1,
    routingFeePPM: 1,
    baseFee: 0n,
    swapTakerFeeBps: 1,
    rebalanceLiquidityFeeBps: 1n,
  },
});

const env: EntityRuntimeContext = {
  state: { eReplicas: new Map(), jReplicas: new Map(), height: 0, timestamp: 2_000 },
  activeJurisdiction: 'fixture',
  error: () => undefined,
  info: () => undefined,
};

const CASES: readonly Readonly<{ name: string; tx: EntityTx }>[] = [
  {
    name: 'e2r-queues-external-token-deposit',
    tx: { type: 'e2r', data: { contractAddress: CONTRACT, tokenType: 1, externalTokenId: 7n, internalTokenId: 1, amount: 9n } },
  },
  {
    name: 'r2e-queues-external-withdrawal',
    tx: { type: 'r2e', data: { receivingEntity: EXTERNAL, tokenId: 1, amount: 8n } },
  },
  {
    name: 'r2r-queues-reserve-transfer',
    tx: { type: 'r2r', data: { toEntityId: PEER, tokenId: 1, amount: 7n } },
  },
  {
    name: 'r2c-queues-remote-collateral',
    tx: { type: 'r2c', data: { receivingEntityId: PEER, counterpartyId: EXTERNAL, tokenId: 1, amount: 6n } },
  },
  { name: 'j-rebroadcast-without-sent-batch-is-a-signed-warning', tx: { type: 'j_rebroadcast', data: { gasBumpBps: 1250 } } },
  { name: 'j-abort-without-sent-batch-is-a-signed-warning', tx: { type: 'j_abort_sent_batch', data: { reason: 'fixture', requeueToCurrent: true } } },
  { name: 'j-clear-without-batch-is-a-signed-warning', tx: { type: 'j_clear_batch', data: { reason: 'fixture' } } },
  {
    name: 'runtime-output-reenters-the-canonical-reducer',
    tx: {
      type: 'runtimeOutput',
      data: {
        protocol: 'cross-j',
        sourceEntityId: HUB,
        sourceSignerId: HUB,
        targetEntityId: HUB,
        entityTxs: [{ type: 'j_abort_sent_batch', data: { reason: 'runtime-output', requeueToCurrent: true } }],
      },
    },
  },
  {
    name: 'process-htlc-timeouts-preserves-input-order',
    tx: {
      type: 'processHtlcTimeouts',
      data: { expiredLocks: [{ accountId: PEER, lockId: `0x${'66'.repeat(32)}` }, { accountId: EXTERNAL, lockId: `0x${'77'.repeat(32)}` }] },
    },
  },
];

const projectEffects = (effects: readonly EntityCandidateEffect[]) => effects.map(effect => ({
  kind: effect.kind,
  ...(effect.kind === 'runtimeEvent' ? { eventName: effect.eventName, data: effect.data } : {}),
}));

export const executeEntityRoutingSemanticVectors = async () => {
  const cases = [];
  for (const spec of CASES) {
    const initial = state();
    const result = spec.tx.type === 'runtimeOutput'
      ? await applyEntityFrame(env, initial, {
          version: 1,
          proposerReplicaId: `${HUB}:${HUB}`,
          entityId: HUB,
          proposerSignerId: HUB,
          parentFrameHash: 'genesis',
          height: 1,
          gossipProfiles: [],
          peerAssertions: [],
          htlc: { version: 1, entries: [], originated: [] },
        }, [spec.tx], 2_000, true)
      : await applyEntityTx(env, initial, spec.tx);
    const outbox = {
      outputs: result.outputs,
      jOutputs: result.jOutputs ?? [],
      accountTxs: (result.accountTxs ?? []).map(row => ({
        accountId: row.accountId,
        txType: row.tx.type,
        txDigest: digest(canonicalAccountTxForFrameHash(row.tx)),
      })),
      hashesToSign: result.hashesToSign ?? [],
    };
    cases.push({
      name: spec.name,
      txType: spec.tx.type,
      stateRoot: computeCanonicalEntityConsensusStateHashCold(result.newState),
      accountsRoot: result.newState.accounts.rootHash(),
      events: readEntityFrameEvents(result.newState),
      effects: projectEffects(result.candidateEffects),
      outbox,
      outboxDigest: digest(outbox),
    });
  }
  const jEnv = createEmptyEnv('entity-routing-j-event');
  const signerId = registerTestSigner(jEnv, 'entity-routing-j-event');
  const jurisdiction = makeJurisdiction('fixture-j', 31_337, '88', '99');
  installJurisdictions(jEnv, jurisdiction);
  const jState = makeState(HUB, signerId, jurisdiction);
  const event = {
    type: 'ReserveUpdated' as const,
    data: { entity: HUB, tokenId: 1, newBalance: '91' },
  };
  const jTx: Extract<EntityTx, { type: 'j_event' }> = {
    type: 'j_event',
    data: buildJEventRangeData(jState, {
      from: signerId,
      jurisdictionRef: jurisdiction.name,
      event,
      observedAt: 2_000,
      blockNumber: 43,
      blockHash: `0x${'aa'.repeat(32)}`,
      transactionHash: `0x${'bb'.repeat(32)}`,
    }, jEnv),
  };
  const jResult = await applyEntityTx(jEnv, jState, jTx);
  const jOutbox = {
    outputs: jResult.outputs,
    jOutputs: jResult.jOutputs ?? [],
    accountTxs: (jResult.accountTxs ?? []).map(row => ({
      accountId: row.accountId,
      txType: row.tx.type,
      txDigest: digest(canonicalAccountTxForFrameHash(row.tx)),
    })),
    hashesToSign: jResult.hashesToSign ?? [],
  };
  cases.push({
    name: 'j-event-applies-authenticated-reserve-finality',
    txType: 'j_event',
    stateRoot: computeCanonicalEntityConsensusStateHashCold(jResult.newState),
    accountsRoot: jResult.newState.accounts.rootHash(),
    events: readEntityFrameEvents(jResult.newState),
    effects: projectEffects(jResult.candidateEffects),
    outbox: jOutbox,
    outboxDigest: digest(jOutbox),
  });
  return { version: 1, canonicalSource: 'TypeScript production EntityTx reducers', cases };
};
