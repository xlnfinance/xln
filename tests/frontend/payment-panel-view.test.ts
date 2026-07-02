import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildPaymentPanelView,
  buildPaymentPanelViewFromRuntimeView,
} from '../../frontend/src/lib/components/Entity/payment-panel-view';

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
            leftEntity: SOURCE,
            rightEntity: HUB,
            deltas: new Map([[1, delta]]),
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
  expect(projected?.state.entityEncPubKey).toBe(`0x${'55'.repeat(32)}`);
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
            leftEntity: SOURCE,
            rightEntity: HUB,
            deltas: new Map([[1, delta]]),
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
  expect(projected?.state.entityEncPubKey).toBe(`0x${'66'.repeat(32)}`);
  expect(projected?.state.lockBook.get('lock-2')).toEqual({ accountId: HUB, tokenId: 1, direction: 'outgoing' });
  expect(projected?.state.accounts.get(HUB.toLowerCase())?.deltas.get(1)).toBe(delta);
});

test('PaymentPanel consumes PaymentPanelView instead of owning full env reads', () => {
  const panel = readFileSync('frontend/src/lib/components/Entity/PaymentPanel.svelte', 'utf8');
  const accountWorkspace = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

  expect(panel).toContain('export let paymentView: PaymentPanelView');
  expect(panel).toContain('export let actionRuntimeEnv: Env | null');
  expect(panel).toContain('export let submitRuntimeInput');
  expect(panel).toContain('await submitRuntimeInput({ runtimeTxs: [], entityInputs: [paymentInput], jInputs: [] })');
  expect(panel).toContain('function resolveProjectedSignerId');
  expect(panel).toContain('function resolvePaymentSignerId(env: Env | null)');
  expect(panel).toContain('const resolvedSignerId = resolvePaymentSignerId(currentEnv)');
  expect(panel).toContain('paymentProjectionReady &&');
  expect(panel).not.toContain("throw new Error('Environment not ready')");
  expect(panel).not.toContain('currentEnv &&\n    activeIsLive');
  expect(panel).not.toContain('submitEntityInputs');
  expect(panel).not.toContain('export let env');
  expect(panel).not.toContain('env.eReplicas');
  expect(panel).not.toContain('currentEnv?.gossip?.getProfiles');
  expect(panel).not.toContain('getXLN');
  expect(panel).not.toContain('env.gossip');
  expect(panel).not.toContain('runtimeState?.p2p');
  expect(panel).not.toContain('ensureGossipProfiles');
  expect(panel).not.toContain('refreshGossip?.');
  expect(panel).not.toContain('/api/gossip/profile');
  expect(panel).toContain('refreshPaymentRuntimeGossip');
  expect(panel).toContain('sendRuntimeDebugEvent');
  expect(panel).not.toContain('buildNetworkAdjacency(env');
  expect(accountWorkspace).toContain('export let paymentView: PaymentPanelView');
  expect(accountWorkspace).toContain('{paymentView}');
  expect(accountWorkspace).toContain('{submitRuntimeInput}');
  expect(tabs).toContain('paymentView = runtimeProjectionFrame');
  expect(tabs).toContain('buildPaymentPanelViewFromRuntimeView');
  expect(tabs).toContain('networkGraph: actionRuntimeEnv?.gossip?.getNetworkGraph?.() ?? null');
  expect(tabs).toContain('{paymentView}');

  const viewSource = readFileSync('frontend/src/lib/components/Entity/payment-panel-view.ts', 'utf8');
  expect(viewSource).not.toContain('Env,');
  expect(viewSource).not.toContain('actionRuntimeEnv');
  expect(viewSource).not.toContain('gossip?.getNetworkGraph');
  expect(viewSource).toContain('networkGraph?: PaymentRuntimeGraph | null');
});

test('payment gossip refresh is owned by runtime store operation', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');

  expect(source).toContain('export async function refreshPaymentRuntimeGossip');
  expect(source).toContain('const xln = env ? await getXLN() : null;');
  expect(source).toContain("if (!env) {");
  expect(source).toContain('PAYMENT_PREFLIGHT_GOSSIP_PROJECTION_ONLY');
  expect(source).toContain('return { profiles: Array.from(mergedProfiles.values()), announced };');
  expect(source).toContain('env.gossip.announce(profile)');
  expect(source).toContain('env.runtimeState?.p2p?.syncProfiles?.()');
  expect(source).toContain('xln?.ensureGossipProfiles');
  expect(source).toContain('xln?.refreshGossip?.(env)');
  expect(source).not.toContain("if (!env) throw new Error('Runtime env is not loaded')");
  expect(source).toContain('export function sendRuntimeDebugEvent');
});
