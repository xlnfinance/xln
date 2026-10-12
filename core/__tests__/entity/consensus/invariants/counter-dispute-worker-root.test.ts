import { expect, test } from 'bun:test';
import { computeAddress, SigningKey } from 'ethers';
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

async function counterRoot(workers: number) {
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
        event: {
          type: 'CounterDisputeRegistered',
          data: {
            sender: owner,
            counterentity: peer,
            nonce: 2,
            proposerIsLeft: true,
            proofbodyHash: proof.proofBodyHash,
            counterProofbody: proof.proofBodyStruct,
          },
        },
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
    expect(result.newState.accounts.get(peer)?.activeDispute).toMatchObject({
      selectedCounterNonce: 2,
      selectedCounterProposerIsLeft: true,
      selectedCounterProofbodyHash: proof.proofBodyHash,
    });
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
