import { expect, test } from 'bun:test';
import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';
import { accountStateDomainFromJurisdiction } from '../../../account/commitment/state-root';
import { AccountInputEvidenceError } from '../../../account/input/input-rejection';
import { runAccountAuthorityEntityStage } from '../../../entity/consensus/account/execution-stage';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import {
  inboundAccountEvidenceFrameRejection,
  resolveInboundAccount,
} from '../../../entity/tx/handlers/account/inbound-account';
import { MalformedEntityFrameInputError } from '../../../entity/tx/processing/invariant-errors';
import { createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerAuthority } from '../../../runtime/workers/account';
import type { AccountInput } from '../../../types/account';
import { addr, entity, makeJurisdiction, makeState } from '../../helpers/cross-j';

const owner = entity('11'); // left
const peer = entity('22'); // right
const jurisdiction = makeJurisdiction('inbound-dispute-config', 31337, '44', '55');

const genesisInput = (leftResponseSeconds: number, rightResponseSeconds: number): AccountInput => ({
  kind: 'ack_frame',
  fromEntityId: peer,
  toEntityId: owner,
  domain: accountStateDomainFromJurisdiction(jurisdiction),
  watchSeed: `0x${'33'.repeat(32)}`,
  disputeConfig: { leftResponseSeconds, rightResponseSeconds },
  proposal: { frame: { height: 1 } },
} as unknown as AccountInput);

const resolve = (input: AccountInput) => resolveInboundAccount(
  makeState(owner, addr('66'), jurisdiction),
  input,
  Boolean(accountInputAck(input)),
  Boolean(accountInputProposal(input)),
);

test('inbound genesis rejects a peer-chosen zero window for the receiver side', () => {
  for (const [left, right] of [[0, 0], [0, 86_400]] as const) {
    let caught: unknown;
    try {
      resolve(genesisInput(left, right));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AccountInputEvidenceError);
    expect((caught as AccountInputEvidenceError).code).toBe('ACCOUNT_INPUT_DISPUTE_CONFIG_INVALID');
    expect((caught as Error).message).toContain('ACCOUNT_INPUT_DISPUTE_CONFIG_OWN_WINDOW_ZERO');
  }
});

test('inbound genesis rejects a malformed dispute config as typed evidence', () => {
  expect(() => resolve(genesisInput(-1, 10))).toThrow(AccountInputEvidenceError);
});

test('inbound genesis adopts a config with a non-zero receiver window; the peer may waive its own', () => {
  for (const [left, right] of [[10, 10], [3_600, 0]] as const) {
    const { account, createdAccount } = resolve(genesisInput(left, right));
    expect(createdAccount).toBe(true);
    expect(account.state.disputeConfig).toEqual({ leftResponseSeconds: left, rightResponseSeconds: right });
  }
});

test('worker stage binds an inbound genesis evidence reject to its accountInput tx, not a halt', async () => {
  const env = createEmptyEnv('inbound-dispute-config-worker-stage');
  const signerId = addr('66');
  const state = makeState(owner, signerId, jurisdiction);
  const input = genesisInput(0, 0);
  const frameTx = { type: 'accountInput', data: input } as never;
  const authority = new TsAccountWorkerAuthority(env, 1);
  let caught: unknown;
  try {
    await runAccountAuthorityEntityStage(env, {
      ownerEntityId: owner, ownerSignerId: signerId, provider: authority.provider,
      occurrence: { kind: 'runtime-input', inputIndex: 0 }, deferProposal: false,
    }, async () => {
      const stage = env.accountAuthorityEntityStage;
      if (!stage) throw new Error('ACCOUNT_AUTHORITY_STAGE_MISSING');
      await stage.beginEntityAccountFrame({
        ownerEntityId: owner, expectedAccountsRoot: state.accounts.rootHash(), entityState: state,
        entityContext: { version: 1, entityId: owner, proposerSignerId: signerId,
          proposerReplicaId: `${owner}:${signerId}`, parentFrameHash: state.prevFrameHash,
          height: 1, gossipProfiles: [], peerAssertions: [], htlc: { version: 1, entries: [], originated: [] } },
        entityTxs: [frameTx], accounts: state.accounts,
        accountForWrite: id => getEntityAccountForWrite(state.accounts, id),
        createInboundAccount: arrival => {
          try {
            resolve(arrival);
          } catch (error) {
            throw inboundAccountEvidenceFrameRejection(error, arrival, [frameTx]);
          }
          throw new Error('EXPECTED_INBOUND_REJECT');
        },
        entityTimestamp: state.timestamp, finalizedJHeight: 0,
      });
    });
  } catch (error) {
    caught = error;
  } finally {
    await authority.close();
  }
  expect(caught).toBeInstanceOf(MalformedEntityFrameInputError);
  expect((caught as MalformedEntityFrameInputError).frameTx).toBe(frameTx);
  expect((caught as Error).message).toContain('ACCOUNT_INPUT_DISPUTE_CONFIG_OWN_WINDOW_ZERO');
});
