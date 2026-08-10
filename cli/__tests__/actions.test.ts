import { describe, expect, test } from 'bun:test';
import { buildOpenHubAccountInput } from '../lib/actions/open-account';
import { buildPaymentInput, ensureCliPaymentProfiles } from '../lib/actions/pay';
import { buildMoveInput } from '../lib/actions/move';
import { buildReceiveInvoice } from '../lib/actions/pay';
import { normalizeNativeDeepLinkPath } from '../../frontend/src/lib/native/deeplink';
import { parseXlnInvoice } from '../../frontend/src/lib/utils/xlnInvoice';
import { resolveCliHubPartyRoles } from '../lib/account-role-evidence';

describe('cli action builders', () => {
  test('hub role evidence uses committed Entity profile plus authorized public hub', () => {
    const sourceEntityId = `0x${'11'.repeat(32)}`;
    const hubEntityId = `0x${'22'.repeat(32)}`;
    const roles = resolveCliHubPartyRoles({
      entityId: sourceEntityId,
      env: {
        state: { eReplicas: new Map([['source', { state: { entityId: sourceEntityId, profile: { isHub: false } } }]]) },
        gossip: { getProfiles: () => [] },
      },
    } as never, hubEntityId, {
      entityId: hubEntityId,
      runtimeId: null,
      metadata: { isHub: true },
      roleSource: 'operator-config',
    });
    expect(roles.entityRoleEvidence).toMatchObject({ isHub: false, source: 'committed-profile' });
    expect(roles.hubRoleEvidence).toMatchObject({ isHub: true, source: 'operator-config' });
  });

  test('openAccount runtime input shape', () => {
    const input = buildOpenHubAccountInput({
      sourceEntityId: '0xaaa',
      signerId: '0xsigner',
      hubEntityId: '0xhub',
      creditAmount: 100n,
      tokenId: 1,
      sourceRoleEvidence: { entityId: '0xaaa', isHub: false, source: 'committed-profile' },
      hubRoleEvidence: { entityId: '0xhub', isHub: true, source: 'verified-gossip-profile' },
      committedRoles: new Map([['0xaaa', false]]),
    });
    expect(input.entityInputs[0]?.entityTxs[0]?.type).toBe('openAccount');
    expect(input.entityInputs[0]?.entityTxs[0]?.data).toMatchObject({
      targetEntityId: '0xhub',
      tokenId: 1,
      disputeConfig: { leftResponseSeconds: 86400, rightResponseSeconds: 3600 },
    });
  });

  test('direct payment vs htlc payment', () => {
    const direct = buildPaymentInput({
      entityId: '0xa',
      signerId: '0xs',
      targetEntityId: '0xb',
      amount: 5n,
      tokenId: 1,
      route: ['0xa', '0xb'],
      deliveryMode: 'direct',
      maxSenderDebit: 5n,
    });
    expect(direct.entityInputs[0]?.entityTxs[0]?.type).toBe('directPayment');

    const htlc = buildPaymentInput({
      entityId: '0xa',
      signerId: '0xs',
      targetEntityId: '0xc',
      amount: 5n,
      tokenId: 1,
      route: ['0xa', '0xb', '0xc'],
      deliveryMode: 'instant',
      maxSenderDebit: 5n,
    });
    expect(htlc.entityInputs[0]?.entityTxs[0]?.type).toBe('htlcPayment');
  });

  test('payment prewarms every remote route profile before submit', async () => {
    const requested: string[][] = [];
    await ensureCliPaymentProfiles({
      env: {
        infrastructure: {
          p2p: { ensureProfiles: async (ids: string[]) => (requested.push(ids), true) },
        },
      },
    } as never, ['0xself', '0xhub', '0xtarget']);
    expect(requested).toEqual([['0xhub', '0xtarget']]);
  });

  test('move builders', () => {
    const r2c = buildMoveInput({
      entityId: '0xa',
      signerId: '0xs',
      kind: 'r2c',
      tokenId: 1,
      amount: 9n,
      counterpartyId: '0xb',
    });
    expect(r2c.entityInputs[0]?.entityTxs[0]?.type).toBe('r2c');
  });
});

test('CLI receive links round-trip through canonical frontend parsers', () => {
  const entityId = `0x${'ab'.repeat(32)}`;
  const invoice = buildReceiveInvoice({
    entityId,
    settings: { apiBase: 'https://xln.finance' },
  } as never);
  const [, nativeLink, webLink] = invoice.split('\n');

  expect(normalizeNativeDeepLinkPath(nativeLink!)).toBe(`/app#pay/${encodeURIComponent(entityId)}`);
  expect(parseXlnInvoice(nativeLink!).targetEntityId).toBe(entityId);
  expect(parseXlnInvoice(webLink!).targetEntityId).toBe(entityId);
});
