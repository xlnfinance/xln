import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import type { EntityState } from '../../../entity/types';
import { buildProvenValuesRoot } from '../../../jurisdiction/adapter/rpc/state-anchor/rpc-proven-values-root';
import {
  buildJHistoryAnchorClaimDigest,
  buildJHistoryAnchorRoot,
} from '../../../jurisdiction/machine/history-consensus';
import {
  type JHistoryAnchorClaimData,
  validateJHistoryAnchorClaim,
} from '../../../jurisdiction/machine/j-event-range-validation';

const proposer = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('anchor-claim-proposer')));
const forger = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('anchor-claim-forger')));
const proposerId = proposer.address.toLowerCase();
const entityId = `0x${'00'.repeat(31)}2a`;
const jurisdictionRef = 'eip155:31337:0x5fbdb2315678afecb367f032d93f642f64180aa3';
const jurisdiction = {
  chainId: 31337,
  depositoryAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  entityProviderAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  entityProviderDeploymentBlock: 10,
};
const registrationBase = 9;
const anchorHeight = 2049;
const anchorBlockHash = ethers.keccak256(ethers.toUtf8Bytes('anchor-block'));
const stateRoot = ethers.keccak256(ethers.toUtf8Bytes('anchor-state-root'));

// Real canonical root over the carried families, as the storage reader builds it.
const carried = buildProvenValuesRoot({
  jurisdiction,
  entityId,
  blockNumber: anchorHeight,
  blockHash: anchorBlockHash,
  boardRegistryRoot: ethers.keccak256(ethers.toUtf8Bytes('board')),
  reserveRoot: ethers.keccak256(ethers.toUtf8Bytes('reserves')),
  debtRoot: ethers.keccak256(ethers.toUtf8Bytes('debts')),
  nonceRoot: ethers.keccak256(ethers.toUtf8Bytes('nonces')),
});

type AnchorState = Pick<EntityState, 'jHistoryFinality' | 'lastFinalizedJHeight' | 'config'>;
const genesisState = (overrides: Partial<AnchorState> = {}): AnchorState => ({
  lastFinalizedJHeight: registrationBase,
  config: { jurisdiction } as AnchorState['config'],
  ...overrides,
});

const verifySignature = (signerId: string, digest: string, signature: string): boolean => {
  try {
    return ethers.recoverAddress(digest, signature).toLowerCase() === signerId;
  } catch {
    return false;
  }
};

const sign = (wallet: ethers.Wallet, data: Omit<JHistoryAnchorClaimData, 'signature'>): string =>
  wallet.signingKey.sign(buildJHistoryAnchorClaimDigest({ ...data, entityId, signerId: data.from })).serialized;

const unsignedClaim = (): Omit<JHistoryAnchorClaimData, 'signature'> => ({
  from: proposerId,
  jurisdictionRef,
  baseHeight: registrationBase,
  anchorHeight,
  anchorBlockHash,
  stateRoot,
  provenValuesRoot: carried.root,
});

const validate = (
  data: JHistoryAnchorClaimData,
  overrides: { state?: AnchorState; recomputedValuesRoot?: string; activeProposerId?: string } = {},
) => validateJHistoryAnchorClaim({
  entityId,
  state: overrides.state ?? genesisState(),
  expectedJurisdictionRef: jurisdictionRef,
  activeProposerId: overrides.activeProposerId ?? proposerId,
  data,
  recomputedValuesRoot: overrides.recomputedValuesRoot ?? carried.root,
  verifySignature,
});

const signedClaim = (): JHistoryAnchorClaimData => {
  const unsigned = unsignedClaim();
  return { ...unsigned, signature: sign(proposer, unsigned) };
};

describe('J history anchor claim admission', () => {
  test('admits a signed claim at registration base and yields the anchor root as fold base', () => {
    const result = validate(signedClaim());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signerId).toBe(proposerId);
    expect(result.baseHeight).toBe(registrationBase);
    expect(result.anchor).toEqual({
      jurisdictionRef,
      anchorHeight,
      anchorBlockHash,
      stateRoot,
      provenValuesRoot: carried.root,
    });
    expect(result.eventHistoryRoot).toBe(buildJHistoryAnchorRoot(result.anchor));
  });

  test('rejects a signature by a key other than the proposer', () => {
    const unsigned = unsignedClaim();
    expect(validate({ ...unsigned, signature: sign(forger, unsigned) }))
      .toEqual({ ok: false, code: 'J_ANCHOR_PROPOSER_SIGNATURE_INVALID' });
  });

  test('rejects any claim field changed after signing', () => {
    const claim = signedClaim();
    const otherHash = ethers.keccak256(ethers.toUtf8Bytes('other'));
    for (const tampered of [
      { ...claim, anchorHeight: anchorHeight + 1 },
      { ...claim, anchorBlockHash: otherHash },
      { ...claim, stateRoot: otherHash },
    ]) {
      expect(validate(tampered)).toEqual({ ok: false, code: 'J_ANCHOR_PROPOSER_SIGNATURE_INVALID' });
    }
  });

  test('rejects a claim root that differs from the root recomputed over the carried values', () => {
    const recomputed = buildProvenValuesRoot({
      jurisdiction,
      entityId,
      blockNumber: anchorHeight,
      blockHash: anchorBlockHash,
      boardRegistryRoot: ethers.keccak256(ethers.toUtf8Bytes('board')),
      reserveRoot: ethers.keccak256(ethers.toUtf8Bytes('reserves-other')),
      debtRoot: ethers.keccak256(ethers.toUtf8Bytes('debts')),
      nonceRoot: ethers.keccak256(ethers.toUtf8Bytes('nonces')),
    });
    expect(recomputed.root).not.toBe(carried.root);
    expect(validate(signedClaim(), { recomputedValuesRoot: recomputed.root }))
      .toEqual({ ok: false, code: 'J_ANCHOR_VALUES_ROOT_MISMATCH' });
  });

  test('rejects a base other than the registration base even when correctly signed', () => {
    for (const baseHeight of [0, registrationBase + 1]) {
      const unsigned = { ...unsignedClaim(), baseHeight };
      expect(validate({ ...unsigned, signature: sign(proposer, unsigned) }))
        .toEqual({ ok: false, code: 'J_ANCHOR_BASE_MISMATCH' });
    }
  });

  test('rejects once the Entity has finality or has moved past registration base', () => {
    const finality = {
      jurisdictionRef,
      baseHeight: registrationBase,
      finalizedThroughHeight: 100,
      tipBlockHash: anchorBlockHash,
      eventHistoryRoot: stateRoot,
      proposerSignerId: proposerId,
      proposerSignature: '0x',
      entityHeight: 1,
    };
    expect(validate(signedClaim(), { state: genesisState({ jHistoryFinality: finality, lastFinalizedJHeight: 100 }) }))
      .toEqual({ ok: false, code: 'J_ANCHOR_FINALITY_EXISTS' });
    expect(validate(signedClaim(), { state: genesisState({ lastFinalizedJHeight: registrationBase + 1 }) }))
      .toEqual({ ok: false, code: 'J_ANCHOR_STATE_NOT_AT_BASE' });
  });

  test('rejects a non-proposer signer, another jurisdiction and an anchor not after base', () => {
    expect(validate(signedClaim(), { activeProposerId: forger.address.toLowerCase() }))
      .toEqual({ ok: false, code: 'J_ANCHOR_NOT_ACTIVE_PROPOSER' });
    const otherJurisdiction = { ...unsignedClaim(), jurisdictionRef: 'eip155:1:0xother' };
    expect(validate({ ...otherJurisdiction, signature: sign(proposer, otherJurisdiction) }))
      .toEqual({ ok: false, code: 'J_ANCHOR_JURISDICTION_MISMATCH' });
    const notAfterBase = { ...unsignedClaim(), anchorHeight: registrationBase };
    expect(validate({ ...notAfterBase, signature: '0x01' }))
      .toEqual({ ok: false, code: 'J_ANCHOR_HEIGHT_INVALID' });
  });
});
