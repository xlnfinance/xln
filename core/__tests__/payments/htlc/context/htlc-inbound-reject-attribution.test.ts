import { expect, test } from 'bun:test';
import { hexlify } from 'ethers';
import { deriveSignerKeySync } from '../../../../account/crypto';
import { decodeAccountTx } from '../../../../account/tx-validation';
import { MalformedEntityFrameInputError } from '../../../../entity/tx/processing/invariant-errors';
import { applyEntityInput } from '../../../../entity/consensus';
import { materializeHtlcPreparedInfraContext } from '../../../../paybook/materialize-context';
import { validateHtlcPreparedInfraContext } from '../../../../paybook/prepared-context-validation';
import type { EntityTx } from '../../../../types/entity-tx';
import { entity, makeJurisdiction, makeState, secret } from '../../../helpers/cross-j';
import { createEntityProposalFixture } from '../../../helpers/entity-proposal-fixture';
import { enableStrictScenario } from '../../../../scenarios/harness/helpers';

const fixture = (override: Record<string, bigint | number>) => {
  const source = entity('11'),
    hub = entity('22');
  const jurisdiction = makeJurisdiction('inbound-reject', 31337, '44', '55');
  const state = makeState(hub, entity('66'), jurisdiction, source);
  const hashlock = secret('81');
  const lock = decodeAccountTx(
    {
      type: 'htlc_lock',
      data: {
        lockId: hashlock,
        hashlock,
        tokenId: 1,
        amount: 10n,
        timelock: 100000n,
        revealBeforeHeight: 100,
        ...override,
        envelope: {
          version: 'xln:htlc-opaque:aes-gcm',
          ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      },
    },
    'INBOUND_REJECT',
  );
  // A peer controls the proposal and its unverified Hanko. Context preparation
  // precedes Account verification, so invalid terms must identify this input.
  const owner: EntityTx = {
    type: 'accountInput',
    data: {
      kind: 'ack_frame',
      fromEntityId: source,
      toEntityId: hub,
      domain: { chainId: jurisdiction.chainId!, depositoryAddress: jurisdiction.depositoryAddress! },
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      proposal: {
        frameHanko: secret('93'),
        frame: {
          height: 1,
          timestamp: state.timestamp,
          jHeight: 0,
          accountTxs: [lock],
          prevFrameHash: '',
          accountStateRoot: secret('91'),
          stateHash: secret('92'),
        },
      },
    },
  };
  const materialize = () =>
    materializeHtlcPreparedInfraContext({
      state,
      proposalTxs: [owner],
      entityEncryptionPublicKey: state.entityEncryptionPublicKey!,
      entityEncryptionPrivateKey: hexlify(deriveSignerKeySync(hub, 'entity-encryption')),
      isEntityOnline: () => true,
      profiles: [],
      parentFrameHash: state.prevFrameHash,
      height: state.height + 1,
      resolveRoute: async () => {
        throw new Error('Inbound preparation never resolves an origin route');
      },
    });
  return { owner, materialize };
};

test.each([
  ['zero amount', { amount: 0n }],
  ['negative amount', { amount: -1n }],
  ['zero timelock', { timelock: 0n }],
  ['negative timelock', { timelock: -1n }],
  ['zero reveal height', { revealBeforeHeight: 0 }],
] as const)('inbound HTLC %s rejects its exact input before preparing context', async (_name, override) => {
  const { owner, materialize } = fixture(override);
  let failure: unknown;
  try {
    await materialize();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(MalformedEntityFrameInputError);
  expect((failure as MalformedEntityFrameInputError).frameTx).toBe(owner);
});

test('valid binding with unauthenticated ciphertext remains a valid deterministic reject context', async () => {
  const prepared = await fixture({}).materialize();
  expect(prepared.entries[0]?.outcome).toEqual({ kind: 'reject', reason: 'decrypt_failed' });
  expect(() => validateHtlcPreparedInfraContext(prepared)).not.toThrow();
});

test('Entity consensus evicts the invalid peer input and certifies the honest sibling', async () => {
  const board = createEntityProposalFixture('inbound-htlc-reject-consensus', 1n, ['1']);
  const proposer = board.createValidator('1');
  const restoreStrict = enableStrictScenario(proposer.env, 'INBOUND HTLC REJECT');
  const { owner } = fixture({ amount: 0n });
  if (owner.type !== 'accountInput') throw new Error('Peer Account input required');
  owner.data.toEntityId = board.entityId;
  try {
    const result = await applyEntityInput(proposer.env, proposer.replica, {
      entityId: board.entityId,
      signerId: proposer.signerId,
      entityTxs: [owner, { type: 'chat', data: { from: proposer.signerId, message: 'honest sibling' } }],
    });
    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.mempool).toHaveLength(0);
    expect(result.workingReplica.state.entityCommandNonces?.bySigner.get(proposer.signerId)?.nonce).toBe(1n);
  } finally {
    restoreStrict();
  }
});
