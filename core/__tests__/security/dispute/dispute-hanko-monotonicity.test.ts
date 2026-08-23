import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../../../account/consensus';
import { getDisputeHankoRequirementError } from '../../../account/consensus/dispute/hanko';
import { accountInputPeerRejectionCode } from '../../../account/consensus/result';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { createEmptyEnv } from '../../../runtime';
import { entity, makeAccount } from '../../helpers/cross-j';

const body = `0x${'11'.repeat(32)}`;
const otherBody = `0x${'22'.repeat(32)}`;
const disputeHanko = (nonce: number, proofBodyHash = body) => ({
  hanko: '0x01',
  nonce,
  hash: `0x${'33'.repeat(32)}`,
  proofBodyHash,
  proposerIsLeft: true,
});

describe('counterparty dispute Hanko monotonicity', () => {
  test('accepts a fresh Hanko and an exact unconsumed retry', () => {
    expect(getDisputeHankoRequirementError(body, undefined, undefined, 4, disputeHanko(5))).toBeUndefined();
    expect(getDisputeHankoRequirementError(body, body, 5, 4, disputeHanko(5))).toBeUndefined();
  });

  test('rejects finalized, regressing, and same-nonce retargeted Hankos', () => {
    expect(getDisputeHankoRequirementError(body, body, 5, 5, disputeHanko(5)))
      .toContain('DISPUTE_HANKO_NONCE_ALREADY_FINALIZED');
    expect(getDisputeHankoRequirementError(body, body, 7, 4, disputeHanko(6)))
      .toContain('DISPUTE_HANKO_NONCE_REGRESSION');
    expect(getDisputeHankoRequirementError(otherBody, body, 5, 4, disputeHanko(5, otherBody)))
      .toContain('DISPUTE_HANKO_NONCE_REUSE');
  });

  test('routes the heightless peer lane by proof nonce without halting Runtime', async () => {
    const leftEntity = entity('aa');
    const rightEntity = entity('bb');
    const account = makeAccount(leftEntity, rightEntity);
    account.state.jNonce = 4;
    account.currentDisputeProofBodyHash = body;
    const proofNonce = 5;
    const hash = createDisputeProofHashWithNonce(
      account.state,
      body,
      account.state.domain,
      proofNonce,
      true,
    );
    const env = createEmptyEnv('standalone-dispute-heightless-lane');
    const baseContext = createAccountConsensusContext(env);
    const context = {
      ...baseContext,
      verifyHanko: async (_hanko: string, _hash: string, expectedEntityId: string) => ({
        valid: true,
        entityId: expectedEntityId,
      }),
    };
    const result = await applyAccountInput(context, account, {
      kind: 'dispute',
      fromEntityId: rightEntity,
      toEntityId: leftEntity,
      domain: account.state.domain,
      disputeConfig: account.state.disputeConfig,
      watchSeed: account.state.watchSeed,
      disputeHanko: {
        hanko: '0x01',
        hash,
        proofBodyHash: body,
        proofNonce,
        proposerIsLeft: true,
      },
    });

    expect(accountInputPeerRejectionCode(result)).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(account.counterpartyDisputeProofNonce).toBe(proofNonce);
    expect(account.counterpartyDisputeProofBodyHash).toBe(body);
  });
});
