import { expect, test } from 'bun:test';
import { signAccountFrame } from '../../../../account/crypto';
import { generateLazyEntityId } from '../../../../entity/factory';
import {
  computeCanonicalEntityConsensusStateHash,
  computeEntityAccountValueHash,
} from '../../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../../entity/state/persistent-account-map';
import { buildQuorumHanko, verifyHankoForHash } from '../../../../hanko/signing';
import { createEmptyEnv } from '../../../../runtime';
import {
  areStorageCheckpointReplicasConverged,
  areStorageCheckpointReplicasQuiescent,
} from '../../../../storage/replica/replicas';
import type { AccountReplica } from '../../../../types/account';
import {
  addReplica,
  entity,
  makeAccount,
  makeJurisdiction,
  makeState,
  registerTestSigner,
} from '../../../helpers/cross-j';

const fixture = async () => {
  const seed = 'checkpoint-exact-local-quorum-evidence';
  const env = createEmptyEnv(seed);
  const validators = ['1', '2', '3'].map(slot => registerTestSigner(env, seed, slot));
  const [first, second, third] = validators;
  if (!first || !second || !third) throw new Error('VALIDATORS_REQUIRED');
  const entityId = generateLazyEntityId(validators, 2n).toLowerCase();
  const counterpartyId = entity('ee');
  const jurisdiction = makeJurisdiction('checkpoint', 31_337, 'dd', 'cc');
  const state = makeState(entityId, first, jurisdiction);
  state.config = {
    ...state.config,
    validators,
    threshold: 2n,
    shares: Object.fromEntries(validators.map(id => [id, 1n])),
  };
  const account = makeAccount(entityId, counterpartyId);
  const hash = entity('ab');
  const quorum = (signers: string[]) =>
    buildQuorumHanko(
      env,
      entityId,
      hash,
      signers.map(signerId => ({ signerId, signature: signAccountFrame(env, signerId, hash) })),
      state.config,
    );
  const left = await quorum([first, second]);
  const right = await quorum([first, third]);
  expect(left).not.toBe(right);
  expect((await verifyHankoForHash(left, hash, entityId, env)).valid).toBe(true);
  expect((await verifyHankoForHash(right, hash, entityId, env)).valid).toBe(true);
  const install = (leftAccount: AccountReplica, rightAccount: AccountReplica) => {
    const withAccount = (value: AccountReplica) => ({
      ...state,
      accounts: PersistentEntityAccountMap.fromEntries(
        [[counterpartyId, value]],
        entityId,
        computeEntityAccountValueHash,
      ),
    });
    const leftState = withAccount(leftAccount);
    const rightState = withAccount(rightAccount);
    expect(computeCanonicalEntityConsensusStateHash(leftState)).toBe(
      computeCanonicalEntityConsensusStateHash(rightState),
    );
    addReplica(env, leftState, first);
    addReplica(env, rightState, second, false);
  };
  return { env, account, left, right, hash, entityId, counterpartyId, install };
};

for (const field of ['currentFrameHanko', 'currentDisputeProofHanko'] as const) {
  test(`checkpoint cannot erase validator-local ${field} despite equal consensus roots`, async () => {
    const { env, account, left, right, install } = await fixture();
    install({ ...account, [field]: left }, { ...account, [field]: right });
    expect(areStorageCheckpointReplicasConverged(env)).toBe(false);
    expect(areStorageCheckpointReplicasQuiescent(env)).toBe(false);
    install({ ...account, [field]: left }, { ...account, [field]: left });
    expect(areStorageCheckpointReplicasQuiescent(env)).toBe(true);
  });
}

test('checkpoint preserves the exact cached ACK certificate, not just its signed hash', async () => {
  const { env, account, left, right, hash, entityId, counterpartyId, install } = await fixture();
  const cached = (hanko: string): AccountReplica => ({
    ...account,
    lastOutboundAckFrame: {
      height: 1,
      counterpartyEntityId: counterpartyId,
      response: {
        kind: 'ack',
        fromEntityId: entityId,
        toEntityId: counterpartyId,
        domain: account.state.domain,
        disputeConfig: account.state.disputeConfig,
        ack: { height: 1, frameHash: hash, frameHanko: hanko },
      },
    },
  });
  install(cached(left), cached(right));
  expect(areStorageCheckpointReplicasQuiescent(env)).toBe(false);
  install(cached(left), cached(left));
  expect(areStorageCheckpointReplicasQuiescent(env)).toBe(true);
});
