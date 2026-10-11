import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../../../account/consensus';
import {
  getDisputeHankoRequirementError,
  validateCounterpartyDisputeHanko,
} from '../../../account/consensus/dispute/hanko';
import { prepareProposalProof } from '../../../account/consensus/proposal/proof';
import { accountInputPeerRejectionCode } from '../../../account/consensus/result';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { getMinimumSafeSettlementNonce } from '../../../protocol/settlement/operations';
import { createEmptyEnv } from '../../../runtime';
import { entity, installJurisdictions, makeAccount, makeJurisdiction } from '../../helpers/cross-j';

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
  test.each([5, Number.MAX_SAFE_INTEGER - 1])(
    'restored peer nonce %s governs the next actual proposal',
    async nonce => {
      const account = makeAccount(entity('aa'), entity('bb'));
      account.counterpartyDisputeProofNonce = nonce;
      const env = createEmptyEnv(`restored-peer-proof-${nonce}`);
      installJurisdictions(env, makeJurisdiction('proof', 31_337, 'dd', 'ee'));
      const result = await prepareProposalProof(env.state, account, { ...account }, [], () => {});
      if (nonce === Number.MAX_SAFE_INTEGER - 1) {
        expect(result).toMatchObject({
          ok: false,
          result: {
            ok: false,
            rejection: { message: `SETTLEMENT_NONCE_EXHAUSTED:${Number.MAX_SAFE_INTEGER}` },
          },
        });
        expect(account.currentDisputeHash).toBeUndefined();
      } else {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('EXPECTED_FRESH_PROPOSAL_PROOF');
        expect(result.signedProofNonce).toBe(nonce + 1);
      }
    },
  );

  test('accepts a fresh Hanko and an exact unconsumed retry', () => {
    expect(getDisputeHankoRequirementError(body, undefined, undefined, 4, disputeHanko(5))).toBeUndefined();
    expect(getDisputeHankoRequirementError(body, body, 5, 4, disputeHanko(5))).toBeUndefined();
  });

  test('rejects finalized, regressing, and same-nonce retargeted Hankos', () => {
    expect(getDisputeHankoRequirementError(body, body, 5, 5, disputeHanko(5))).toContain(
      'DISPUTE_HANKO_NONCE_ALREADY_FINALIZED',
    );
    expect(getDisputeHankoRequirementError(body, body, 7, 4, disputeHanko(6))).toContain(
      'DISPUTE_HANKO_NONCE_REGRESSION',
    );
    expect(getDisputeHankoRequirementError(otherBody, body, 5, 4, disputeHanko(5, otherBody))).toContain(
      'DISPUTE_HANKO_NONCE_REUSE',
    );
  });

  test('routes the heightless peer lane by proof nonce without halting Runtime', async () => {
    const leftEntity = entity('aa');
    const rightEntity = entity('bb');
    const account = makeAccount(leftEntity, rightEntity);
    account.state.jNonce = 4;
    account.currentDisputeProofBodyHash = body;
    const proofNonce = 5;
    const hash = createDisputeProofHashWithNonce(account.state, body, account.state.domain, proofNonce, true);
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
    // A restored signing cursor can lag an already-accepted peer witness.
    // Fresh proposals and ACKs must still supersede that witness on-chain.
    expect(getMinimumSafeSettlementNonce(account)).toBeGreaterThan(proofNonce);
  });

  test('rejects the contract-reserved nonce before advancing the local reservation', async () => {
    const leftEntity = entity('aa');
    const rightEntity = entity('bb');
    const account = makeAccount(leftEntity, rightEntity);
    const before = { ...account, proofHeader: { ...account.proofHeader } };
    const result = await applyAccountInput(
      createAccountConsensusContext(createEmptyEnv('reserved-dispute-nonce')),
      account,
      {
        kind: 'dispute',
        fromEntityId: rightEntity,
        toEntityId: leftEntity,
        domain: account.state.domain,
        disputeConfig: account.state.disputeConfig,
        watchSeed: account.state.watchSeed,
        disputeHanko: {
          hanko: '0x01',
          hash: body,
          proofBodyHash: body,
          proofNonce: Number.MAX_SAFE_INTEGER,
          proposerIsLeft: true,
        },
      },
    );
    expect(accountInputPeerRejectionCode(result)).toBe('ACCOUNT_INPUT_DISPUTE_HANKO_INVALID');
    expect(account).toEqual(before);
  });

  test('rejects a peer proposal before commit when its ACK nonce would be exhausted', async () => {
    const account = makeAccount(entity('aa'), entity('bb'));
    const witness = {
      hanko: '0x01',
      hash: body,
      proofBodyHash: body,
      proofNonce: Number.MAX_SAFE_INTEGER - 1,
      proposerIsLeft: false,
    };
    await expect(
      validateCounterpartyDisputeHanko(
        account,
        {
          kind: 'ack_frame',
          fromEntityId: account.state.rightEntity,
          toEntityId: account.state.leftEntity,
          domain: account.state.domain,
          disputeConfig: account.state.disputeConfig,
          watchSeed: account.state.watchSeed,
          proposal: { frame: account.currentFrame, frameHanko: '0x01', disputeHanko: witness },
        },
        witness,
        'PEER_PROPOSAL',
        createAccountConsensusContext(createEmptyEnv('peer-exhausted-ack')),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_INPUT_DISPUTE_HANKO_INVALID' });
    expect(account.counterpartyDisputeProofNonce).toBeUndefined();
  });
});
