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

const low = entity('11');
const high = entity('22');
const owner = low;
const peer = high;
const jurisdiction = makeJurisdiction('inbound-dispute-config', 31337, '44', '55');

type Floor = Readonly<{ label: string; isHub: boolean; configured?: number; seconds: number }>;
const FLOORS: readonly Floor[] = [
  { label: 'user role default', isHub: false, seconds: 86_400 },
  { label: 'hub role default', isHub: true, seconds: 3_600 },
  { label: 'explicit committed floor', isHub: true, configured: 10, seconds: 10 },
];

/** `own` is the receiver's window and `other` the proposer's, in either orientation. */
const genesisFor = (receiver: string, sender: string, own: number, other: number): AccountInput => {
  const receiverIsLeft = receiver < sender;
  return {
    kind: 'ack_frame',
    fromEntityId: sender,
    toEntityId: receiver,
    domain: accountStateDomainFromJurisdiction(jurisdiction),
    watchSeed: `0x${'33'.repeat(32)}`,
    disputeConfig: receiverIsLeft
      ? { leftResponseSeconds: own, rightResponseSeconds: other }
      : { leftResponseSeconds: other, rightResponseSeconds: own },
    proposal: { frame: { height: 1 } },
  } as unknown as AccountInput;
};
const genesisInput = (own: number, other: number): AccountInput => genesisFor(owner, peer, own, other);

const receiverState = (receiver: string, floor?: Floor) => {
  const state = makeState(receiver, addr('66'), {
    ...jurisdiction,
    ...(floor?.configured === undefined ? {} : { accountDisputeFloorSeconds: floor.configured }),
  });
  state.profile = { ...state.profile, isHub: floor?.isHub ?? false };
  return state;
};

const resolveAt = (receiver: string, input: AccountInput, floor?: Floor) => resolveInboundAccount(
  receiverState(receiver, floor),
  input,
  Boolean(accountInputAck(input)),
  Boolean(accountInputProposal(input)),
);
const resolve = (input: AccountInput) => resolveAt(owner, input);

const rejection = (run: () => unknown): AccountInputEvidenceError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountInputEvidenceError) return error;
    throw error;
  }
  throw new Error('EXPECTED_INBOUND_REJECT');
};

for (const floor of FLOORS) {
  for (const [receiver, sender] of [[low, high], [high, low]] as const) {
    const side = receiver === low ? 'left' : 'right';
    test(`inbound genesis rejects an own window below the ${floor.label} (receiver ${side})`, () => {
      for (const own of [0, 1, floor.seconds - 1]) {
        const error = rejection(() => resolveAt(receiver, genesisFor(receiver, sender, own, 86_400), floor));
        expect(error.code).toBe('ACCOUNT_INPUT_DISPUTE_CONFIG_INVALID');
        expect(error.message).toContain(`OWN_WINDOW_BELOW_FLOOR:${sender}:${own}:${floor.seconds}`);
      }
    });
    test(`inbound genesis accepts an own window at the ${floor.label} with a waived peer window (receiver ${side})`, () => {
      const input = genesisFor(receiver, sender, floor.seconds, 0);
      const { account, createdAccount } = resolveAt(receiver, input, floor);
      expect(createdAccount).toBe(true);
      expect(account.state.disputeConfig).toEqual(input.disputeConfig);
    });
  }
}

test('inbound genesis rejects a malformed dispute config as typed evidence', () => {
  expect(rejection(() => resolve(genesisInput(-1, 86_400))).code).toBe('ACCOUNT_INPUT_DISPUTE_CONFIG_INVALID');
});

test('a committed floor below one second is never valid', () => {
  expect(() => resolveAt(owner, genesisInput(86_400, 0), { label: 'zero', isHub: false, configured: 0, seconds: 0 }))
    .toThrow('ACCOUNT_DISPUTE_FLOOR_SECONDS_INVALID:0');
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
  expect((caught as Error).message).toContain('ACCOUNT_INPUT_DISPUTE_CONFIG_OWN_WINDOW_BELOW_FLOOR');
});
