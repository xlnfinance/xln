import { expect, test } from 'bun:test';
import {
  assertOriginatedHtlcPayments,
  materializeOriginatedHtlcPayments,
} from '../../../../entity/paybook/payment-admission';
import type { Profile } from '../../../../entity/profile';
import type { EntityTx } from '../../../../types/entity-tx';
import { entity, makeJurisdiction, makeState } from '../../../helpers/cross-j';

// The range certificate is checked by Entity consensus before this boundary.
// Exercise actual onion preparation and validator economics, with a catch-up
// greater than the complete instant-payment enforcement window.
test('htlcPayment uses preceding certified catch-up height for preparation and validation', async () => {
  const source = entity('11');
  const target = entity('22');
  const jurisdiction = makeJurisdiction('catchup', 31337, '33', '44');
  const state = makeState(source, entity('55'), jurisdiction, target);
  const peer = makeState(target, entity('66'), jurisdiction, source);
  state.lastFinalizedJHeight = 100;
  const profiles: Profile[] = [state, peer].map((owner, index) => ({
    entityId: owner.entityId,
    entityEncryptionPublicKey: owner.entityEncryptionPublicKey,
    name: '',
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: state.timestamp,
    runtimeId: '',
    runtimeEncPubKey: '',
    publicAccounts: [],
    wsUrl: null,
    relays: [],
    metadata: {},
    accounts: [
      {
        counterpartyId: index === 0 ? target : source,
        domain: { chainId: jurisdiction.chainId!, depositoryAddress: jurisdiction.depositoryAddress! },
        tokenCapacities: { 1: { inCapacity: 1000n, outCapacity: 1000n } },
      },
    ],
  }));
  const payment: EntityTx = {
    type: 'htlcPayment',
    data: {
      targetEntityId: target,
      tokenId: 1,
      amount: 10n,
      maxSenderDebit: 10n,
      route: [source, target],
      deliveryMode: 'instant',
    },
  };
  const range: EntityTx = {
    type: 'j_event',
    data: {
      from: entity('55'),
      jurisdictionRef: 'catchup',
      baseHeight: 100,
      scannedThroughHeight: 200,
      tipBlockHash: entity('77'),
      eventHistoryRoot: entity('88'),
      rangeHash: entity('99'),
      blocks: [],
      signature: '',
      observedAt: 200,
    },
  };
  const prepare = async (proposalTxs: EntityTx[]) => {
    const input = { state, proposalTxs, profiles, height: 1, resolveRoute: async () => [source, target] };
    const originated = await materializeOriginatedHtlcPayments(input);
    expect(() => assertOriginatedHtlcPayments({ ...input, originated })).not.toThrow();
    return { input, originated };
  };
  const before = await prepare([payment]);
  const missingIntermediary = entity('77');
  const unroutablePayment: EntityTx = {
    ...payment,
    data: { ...payment.data, route: [source, missingIntermediary, target] },
  };
  await expect(materializeOriginatedHtlcPayments({
    state,
    proposalTxs: [unroutablePayment],
    profiles,
    height: 1,
    resolveRoute: async () => [source, target],
  })).rejects.toMatchObject({
    disposition: 'reject',
    txType: 'htlcPayment',
    frameTx: unroutablePayment,
    rejection: `HTLC_PAYMENT_PROFILE_MATCH_COUNT:${missingIntermediary}:0`,
  });
  const caughtUp = await prepare([range, payment]);
  expect(caughtUp.originated[0]!.revealBeforeHeight).toBe(before.originated[0]!.revealBeforeHeight + 100);
  expect(caughtUp.originated[0]!.revealBeforeHeight).toBeGreaterThan(200);
  expect(() => assertOriginatedHtlcPayments({ ...caughtUp.input, originated: before.originated })).toThrow(
    'REVEALBEFOREHEIGHT_MISMATCH',
  );
  const later = await prepare([payment, range]);
  expect(later.originated[0]!.revealBeforeHeight).toBe(before.originated[0]!.revealBeforeHeight);
});
