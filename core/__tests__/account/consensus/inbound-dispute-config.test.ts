import { expect, test } from 'bun:test';
import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';
import { accountStateDomainFromJurisdiction } from '../../../account/commitment/state-root';
import { AccountInputEvidenceError } from '../../../account/input/input-rejection';
import { resolveInboundAccount } from '../../../entity/tx/handlers/account/inbound-account';
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
