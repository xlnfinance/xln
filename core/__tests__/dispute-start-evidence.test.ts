import { describe, expect, test } from 'bun:test';
import type { AccountReplica } from '../types/account';
import { resolveStoredDisputeStartNonce } from '../entity/tx/handlers/dispute/start-evidence';

const proofBodyHash = `0x${'11'.repeat(32)}`;

const hankoAccount = (overrides: Partial<AccountReplica> = {}): AccountReplica => ({
  counterpartyDisputeProofBodyHash: proofBodyHash,
  counterpartyDisputeProofNonce: 2,
  ...overrides,
} as AccountReplica);

describe('dispute start evidence identity', () => {
  test('uses the nonce bound to the peer Hanko when a local Hanko reused the ProofBody at a newer nonce', () => {
    expect(resolveStoredDisputeStartNonce(hankoAccount(), proofBodyHash)).toEqual({
      signedNonce: 2,
      nonceSource: 'counterpartyHanko',
    });
  });

  test('rejects a ProofBody that is not the one bound to the peer Hanko', () => {
    const otherHash = `0x${'22'.repeat(32)}`;
    expect(() => resolveStoredDisputeStartNonce(hankoAccount(), otherHash)).toThrow(
      'DISPUTE_START_HANKO_PROOFBODY_MISMATCH',
    );
  });

  test('rejects a peer Hanko without its exact positive nonce', () => {
    expect(() => resolveStoredDisputeStartNonce(
      hankoAccount({ counterpartyDisputeProofNonce: undefined }),
      proofBodyHash,
    )).toThrow('DISPUTE_START_HANKO_NONCE_INVALID');
  });
});
