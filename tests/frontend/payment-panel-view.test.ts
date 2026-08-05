import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildPaymentPanelView,
  buildPaymentPanelViewFromRuntimeView,
} from '../../frontend/src/lib/components/Entity/payment-panel-view';
import { hasCertifiedEntityEncryptionManifest } from '../../frontend/src/lib/components/Entity/payment-routing';

const SOURCE = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;
const RECIPIENT = `0x${'33'.repeat(32)}`;
const SIGNER = `0x${'44'.repeat(20)}`;

test('payment panel view projects only payment routing state from replicas', () => {
  const delta = { offdelta: 10n };
  const networkGraph = {
    findPaths: async () => [],
  };
  const replicas = new Map([
    [`${SOURCE}:${SIGNER}`, {
      entityId: SOURCE,
      state: {
        entityId: SOURCE,
        entityEncPubKey: `0x${'55'.repeat(32)}`,
        config: { hiddenFromPaymentView: true },
        reserves: new Map([[1, 100n]]),
        lockBook: new Map([['lock-1', { accountId: HUB, tokenId: 1, direction: 'outgoing' }]]),
        accounts: new Map([
          [HUB, {
            state: {
              leftEntity: SOURCE,
              rightEntity: HUB,
              deltas: new Map([[1, delta]]),
            },
            activeDispute: { reason: 'test' },
          }],
        ]),
      },
    }],
  ]);

  const view = buildPaymentPanelView({
    entityId: SOURCE,
    replicas: replicas as never,
    profiles: [
      { entityId: SOURCE, name: 'Self', accounts: [], publicAccounts: [], metadata: {} },
      { entityId: RECIPIENT, name: 'Recipient', accounts: [], publicAccounts: [], metadata: {} },
    ] as never,
    networkGraph,
  });

  expect(view.knownRecipientEntities).toEqual([RECIPIENT.toLowerCase()]);
  expect(view.blockedCounterpartyIds.has(HUB.toLowerCase())).toBe(true);
  expect(view.networkGraph).toBe(networkGraph);
  expect(view.replicaMap.size).toBe(1);
  const projected = view.replicaMap.get(`${SOURCE}:${SIGNER}`);
  expect((projected?.state as Record<string, unknown>).entityEncPubKey).toBeUndefined();
  expect(projected?.state.lockBook.get('lock-1')).toEqual({ accountId: HUB, tokenId: 1, direction: 'outgoing' });
  expect(projected?.state.accounts.get(HUB)?.deltas.get(1)).toBe(delta);
  expect((projected?.state as Record<string, unknown>).config).toBeUndefined();
  expect((projected?.state as Record<string, unknown>).reserves).toBeUndefined();
});

test('payment panel view projects payment routing state from runtime adapter frame', () => {
  const delta = { offdelta: 25n };
  const frame = {
    height: 7,
    head: { latestHeight: 7 },
    entities: [
      { entityId: SOURCE, label: 'Source', height: 7 },
      { entityId: HUB, label: 'Hub', height: 7 },
      { entityId: RECIPIENT, label: 'Recipient', height: 7 },
    ],
    activeEntityId: SOURCE,
    activeEntity: {
      summary: { entityId: SOURCE, label: 'Source', height: 7 },
      core: {
        entityId: SOURCE,
        signerId: SIGNER,
        entityEncPubKey: `0x${'66'.repeat(32)}`,
        lockBook: new Map([['lock-2', { accountId: HUB, tokenId: 1, direction: 'outgoing' }]]),
      },
      accounts: {
        items: [
          {
            state: {
              leftEntity: SOURCE,
              rightEntity: HUB,
              deltas: new Map([[1, delta]]),
            },
            status: 'disputed',
          },
        ],
        nextCursor: null,
        totalItems: 1,
      },
      books: { items: [], nextCursor: null },
    },
  };

  const view = buildPaymentPanelViewFromRuntimeView({
    entityId: SOURCE,
    frame: frame as never,
  });

  expect(view.knownRecipientEntities).toEqual([HUB.toLowerCase(), RECIPIENT.toLowerCase()]);
  expect(view.blockedCounterpartyIds.has(HUB.toLowerCase())).toBe(true);
  expect(view.networkGraph).toBeNull();
  const projected = view.replicaMap.get(`${SOURCE}:${SIGNER.toLowerCase()}`);
  expect((projected?.state as Record<string, unknown>).entityEncPubKey).toBeUndefined();
  expect(projected?.state.lockBook.get('lock-2')).toEqual({ accountId: HUB, tokenId: 1, direction: 'outgoing' });
  expect(projected?.state.accounts.get(HUB.toLowerCase())?.deltas.get(1)).toBe(delta);
});

test('payment key coverage requires every validator key in a certified profile', () => {
  const profile = {
    entityId: HUB,
    runtimeSignature: `0x${'11'.repeat(65)}`,
    metadata: {
      profileHanko: '0x01',
      board: {
        threshold: 2,
        validators: [{ signerId: 'a' }, { signerId: 'b' }],
        encryptionAttestations: [{ encryptionPublicKey: `0x${'21'.repeat(32)}` }],
      },
    },
  };
  expect(hasCertifiedEntityEncryptionManifest(new Map(), [profile] as never, HUB)).toBe(false);
  profile.metadata.board.encryptionAttestations.push({ encryptionPublicKey: `0x${'22'.repeat(32)}` });
  expect(hasCertifiedEntityEncryptionManifest(new Map(), [profile] as never, HUB)).toBe(true);
  profile.metadata.board.encryptionAttestations[1]!.encryptionPublicKey = `0x${'21'.repeat(32)}`;
  expect(hasCertifiedEntityEncryptionManifest(new Map(), [profile] as never, HUB)).toBe(false);
});


test('runtime gossip refresh owns exact payment and open-account readiness', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');

  expect(source).toContain('export async function refreshRuntimeGossipProfiles');
  expect(source).toContain('const xln = env ? await getXLN() : null;');
  expect(source).toContain("if (!env) {");
  expect(source).toContain('PAYMENT_PREFLIGHT_GOSSIP_PROJECTION_ONLY');
  expect(source).toContain('return { profiles: Array.from(mergedProfiles.values()), announced };');
  expect(source).toContain('env.gossip.announce(profile)');
  expect(source).toContain('env.infrastructure?.p2p?.syncProfiles?.()');
  expect(source).toContain('xln?.ensureGossipProfiles');
  expect(source).toContain('hasUsableOpenAccountCounterpartyProfile(env, sourceEntityId, targetEntityId)');
  expect(source).toContain("throw new Error('OPEN_ACCOUNT_COUNTERPARTY_PROFILE_NOT_READY");
  expect(source).toContain('xln?.refreshGossip?.(env)');
  expect(source).not.toContain("if (!env) throw new Error('Runtime env is not loaded')");
  expect(source).toContain('export function sendRuntimeDebugEvent');
});
