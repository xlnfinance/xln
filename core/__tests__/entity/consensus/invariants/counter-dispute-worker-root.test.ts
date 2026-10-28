import { proposeAccountFrame } from '../../../../account/consensus';
import { createAccountConsensusContext } from '../../../../entity/account/account-consensus-context';
import { decodeInt512, encodeInt512 } from '../../../../protocol/crypto/abi-money';
import type { JurisdictionEvent } from '../../../../types/jurisdiction-events';
import { expect, test } from 'bun:test';
import { computeAddress, SigningKey, ZeroHash } from 'ethers';
import { deriveSignerKeySync, registerSignerKey } from '../../../../account/crypto';
import { computeCanonicalEntityConsensusStateHash } from '../../../../entity/consensus/state-root';
import { buildAccountProofBody } from '../../../../protocol/dispute/proof-builder';
import { runAccountAuthorityEntityStage } from '../../../../entity/consensus/account/execution-stage';
import { TsAccountWorkerAuthority } from '../../../../runtime/workers/account';
import { createEmptyEnv } from '../../../../runtime';
import { createJReplica } from '../../../../scenarios/harness/boot';
import { addr, entity, makeJurisdiction, makeState, openWritableEntityAccounts } from '../../../helpers/cross-j';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../../helpers/entity-frame';
import { buildJEventRangeData } from '../../../helpers/j-history';

async function counterRoot(workers: number, pendingStart = false) {
  const env = createEmptyEnv('counter-dispute-worker-root');
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_700_000_000_000;
  const owner = entity('11'),
    peer = entity('22');
  const key = deriveSignerKeySync('counter-dispute-worker-root', '1');
  const signer = computeAddress(new SigningKey(key).compressedPublicKey).toLowerCase();
  registerSignerKey(env.runtimeId!, signer, key);
  const jurisdiction = makeJurisdiction('counter-worker', 31337, '44', '55');
  const j = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
  j.chainId = jurisdiction.chainId;
  j.contracts = {
    ...j.contracts,
    entityProvider: jurisdiction.entityProviderAddress,
    account: addr('98'),
    deltaTransformer: addr('99'),
  };
  const state = makeState(owner, signer, jurisdiction, peer);
  state.timestamp = env.state.timestamp;
  const account = openWritableEntityAccounts(state).getForWrite(peer)!;
  const proof = buildAccountProofBody(account, '');
  if (!pendingStart) {
    account.status = 'disputed';
    account.activeDispute = {
      startedByLeft: true,
      initialNonce: 1,
      initialProposerIsLeft: true,
      initialProofbodyHash: proof.proofBodyHash,
      jNonce: 1,
      disputeTimeout: 1_700_086_400,
      disputeStartTimestamp: 1_700_000_000,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
      starterCounterProofCommitment: `0x${'00'.repeat(32)}`,
      observedOnChain: true,
      finalizeQueued: false,
    };
  }
  let event: JurisdictionEvent = {
    type: 'CounterDisputeRegistered', data: {
      sender: owner, counterentity: peer, nonce: 2, proposerIsLeft: true,
      proofbodyHash: proof.proofBodyHash, counterProofbody: proof.proofBodyStruct,
    },
  };
  if (pendingStart) {
    account.proofHeader.nextProofNonce = 8;
    account.mempool = [{ type: 'direct_payment', data: {
      tokenId: 1, amount: 1n, route: [peer], fromEntityId: owner, toEntityId: peer, deliveryMode: 'direct',
    } }];
    await proposeAccountFrame(createAccountConsensusContext(env), account, state.timestamp);
    const pending = account.pendingAccountInput!.proposal.disputeHanko!;
    event = { type: 'DisputeStarted', data: {
      sender: peer, counterentity: owner, nonce: '8', proposerIsLeft: true,
      proofbodyHash: pending.proofBodyHash,
      initialProofbody: { ...proof.proofBodyStruct,
        offdeltas: proof.proofBodyStruct.offdeltas.map(value => encodeInt512(decodeInt512(value) - 1n)),
      },
      watchSeed: account.state.watchSeed,
      starterInitialArguments: '0x', starterCounterArguments: '0x', starterCounterProofCommitment: ZeroHash,
      disputeStartTimestamp: 1_700_000_000, disputeTimeout: 1_700_000_020,
      leftResponseSeconds: 10, rightResponseSeconds: 10,
    } };
  }
  const tx = {
    type: 'j_event' as const,
    data: buildJEventRangeData(
      state,
      {
        from: signer,
        jurisdictionRef: jurisdiction.name,
        observedAt: env.state.timestamp,
        blockNumber: state.lastFinalizedJHeight + 1,
        blockHash: `0x${'77'.repeat(32)}`,
        event,
      },
      env,
    ),
  };
  const apply = () => applyEntityFrameWithMaterializedTestInfraContext(env, state, [tx]);
  const authority = workers ? new TsAccountWorkerAuthority(env, workers) : null;
  try {
    const result = authority
      ? await runAccountAuthorityEntityStage(
          env,
          {
            ownerEntityId: owner,
            ownerSignerId: signer,
            provider: authority.provider,
            occurrence: { kind: 'runtime-input', inputIndex: 0 },
            deferProposal: false,
          },
          apply,
        )
      : await apply();
    if (pendingStart) {
      expect(result.newState.accounts.get(peer)?.pendingFrame).toBeUndefined();
      expect(result.newState.jBatchState!.batch.disputeFinalizations).toHaveLength(1);
      expect(result.newState.jBatchState!.batch.disputeFinalizations[0]!.finalNonce).toBe(8);
    } else {
      expect(result.newState.accounts.get(peer)?.activeDispute).toMatchObject({
        selectedCounterNonce: 2,
        selectedCounterProposerIsLeft: true,
        selectedCounterProofbodyHash: proof.proofBodyHash,
      });
    }
    return computeCanonicalEntityConsensusStateHash(result.newState);
  } finally {
    if (authority) await authority.close();
  }
}

test('CounterDisputeRegistered commits identical Entity roots inline and with resident W1/W4', async () => {
  const inline = await counterRoot(0);
  expect(await counterRoot(1)).toBe(inline);
  expect(await counterRoot(4)).toBe(inline);
}, 15_000);

test('certified own pending exit commits identical Entity roots inline and with resident W1/W4', async () => {
  const inline = await counterRoot(0, true);
  expect(await counterRoot(1, true)).toBe(inline);
  expect(await counterRoot(4, true)).toBe(inline);
}, 15_000);
