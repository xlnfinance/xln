import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  ENTITY_PROVIDER_ACTION_KIND,
  encodeCancelEntityProviderActionHankoPayload,
  encodeWatchtowerMinSequenceHankoPayload,
  hashWatchtowerMinSequenceHankoPayload,
} from '../../../hanko/onchain-domain';
import { watchtowerMinSequenceRevokingAll } from '../../../watchtower/store/appointments';

const DOMAIN = {
  chainId: 8453,
  entityProviderAddress: '0x6666666666666666666666666666666666666666',
  boardEpoch: 11,
} as const;

describe('watchtower appointment fence (EntityProvider.setWatchtowerMinSequence)', () => {
  test('payload is abi.encodePacked("WATCHTOWER_MIN_SEQUENCE", chainId, ep, entityNumber, boardEpoch, newMinimum, actionNonce)', () => {
    const payload = encodeWatchtowerMinSequenceHankoPayload(DOMAIN, {
      entityNumber: 42,
      newMinimum: 7,
      actionNonce: 3,
    });
    const reference = ethers.solidityPacked(
      ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
      ['WATCHTOWER_MIN_SEQUENCE', 8453, DOMAIN.entityProviderAddress, 42, 11, 7, 3],
    );
    expect(payload).toBe(reference);
    expect(hashWatchtowerMinSequenceHankoPayload(DOMAIN, { entityNumber: 42, newMinimum: 7, actionNonce: 3 }))
      .toBe(ethers.keccak256(reference));
    // Pinned so an accidental label/field-order change is loud.
    expect(hashWatchtowerMinSequenceHankoPayload(DOMAIN, { entityNumber: 42, newMinimum: 7, actionNonce: 3 }))
      .toBe('0x' + ethers.keccak256(reference).slice(2));
    expect((payload.length - 2) / 2).toBe('WATCHTOWER_MIN_SEQUENCE'.length + 32 + 20 + 32 * 4);
  });

  test('domain and value guards mirror the other entity actions', () => {
    expect(() => encodeWatchtowerMinSequenceHankoPayload(DOMAIN, { entityNumber: 42, newMinimum: 0, actionNonce: 3 }))
      .toThrow('INVALID_HANKO_WATCHTOWER_MIN_SEQUENCE:0');
    expect(() => encodeWatchtowerMinSequenceHankoPayload({ ...DOMAIN, chainId: 0 }, { entityNumber: 42, newMinimum: 1, actionNonce: 1 }))
      .toThrow('INVALID_HANKO_DOMAIN_CHAIN_ID:0');
    expect(() => encodeWatchtowerMinSequenceHankoPayload(DOMAIN, { entityNumber: 42, newMinimum: -1, actionNonce: 1 }))
      .toThrow('INVALID_HANKO_WATCHTOWER_MIN_SEQUENCE');
  });

  test('action kind 2 is cancellable on the shared entity action lane', () => {
    expect(ENTITY_PROVIDER_ACTION_KIND.watchtowerMinSequence).toBe(2);
    const cancelledActionHash = `0x${'ab'.repeat(32)}`;
    expect(() => encodeCancelEntityProviderActionHankoPayload(DOMAIN, {
      entityNumber: 42,
      actionNonce: 4,
      cancelledActionHash,
      cancelledActionKind: 2,
    })).not.toThrow();
    expect(() => encodeCancelEntityProviderActionHankoPayload(DOMAIN, {
      entityNumber: 42,
      actionNonce: 4,
      cancelledActionHash,
      cancelledActionKind: 3,
    })).toThrow('INVALID_HANKO_CANCELLED_ACTION_KIND:3');
  });

  test('revoking minimum is one above the highest stored appointment sequence', () => {
    expect(watchtowerMinSequenceRevokingAll([])).toBe(1n);
    expect(watchtowerMinSequenceRevokingAll([
      { lastResortPayload: { appointmentSequence: 4 } as never },
      { lastResortPayload: { appointmentSequence: 9 } as never },
      { lastResortPayload: undefined as never },
    ])).toBe(10n);
  });
});
