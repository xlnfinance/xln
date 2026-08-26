import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENTITY_TX_TYPES } from '../../../entity/tx/processing/catalog';
import { validateEntityTx } from '../../../entity/tx-validation';
import { decodeAccountTx } from '../../../account/tx-validation';
import { validateStorageEntityCoreDocValue } from '../../../storage/schema/schema-state-docs';
import { projectEntityCoreDoc } from '../../../storage/read/projections';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';

const repoRoot = process.cwd();
const removedEntityTxs = [
  ['hashlock', 'Payment'].join(''),
  ['manual', 'Htlc', 'Lock'].join(''),
  ['pull', 'Lock'].join(''),
  ['resolve', 'Pull'].join(''),
  ['cancel', 'Pull'].join(''),
  ['pull', 'Cancel', 'Expired'].join(''),
  ['resolve', 'Swap'].join(''),
  ['cross', 'Jurisdiction', 'Settled'].join(''),
  ['reopen', 'Disputed', 'Account'].join(''),
];
const removedAccountTxs = [
  ['pull', 'lock'].join('_'),
  ['pull', 'resolve'].join('_'),
  ['pull', 'cancel'].join('_'),
  ['reopen', 'disputed'].join('_'),
];
const historicalPrefixes = ['.archive/', 'audits/', 'docs/audit/', 'docs/releases/'];

const trackedFiles = (): string[] => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).split('\0').filter(Boolean).filter(path =>
  !historicalPrefixes.some(prefix => path.startsWith(prefix))
  && existsSync(join(repoRoot, path))
  && lstatSync(join(repoRoot, path)).isFile()
);

const source = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

test('retired payment transactions stay absent from active tracked files', () => {
  const catalog = new Set<string>(ENTITY_TX_TYPES);
  const activeSources = trackedFiles().map(path => [path, source(path)] as const);
  for (const removedEntityTx of [...removedEntityTxs, ...removedAccountTxs]) {
    const forbiddenSpellings = [
      `'${removedEntityTx}'`,
      `"${removedEntityTx}"`,
      `\`${removedEntityTx}\``,
    ];
    expect(activeSources.filter(([, text]) =>
      forbiddenSpellings.some(spelling => text.includes(spelling)),
    ).map(([path]) => path)).toEqual([]);
    if (removedEntityTxs.includes(removedEntityTx)) expect(catalog.has(removedEntityTx)).toBe(false);
  }
}, 15_000);

test('retired Entity and Account discriminants fail at their canonical decoders', () => {
  for (const type of removedEntityTxs) {
    expect(() => validateEntityTx({ type, data: {} }, 'CANONICAL_PULL'))
      .toThrow(`CANONICAL_PULL_TYPE_UNKNOWN:${type}`);
  }
  for (const type of removedAccountTxs) {
    expect(() => decodeAccountTx({ type, data: {} }, 'CANONICAL_PULL'))
      .toThrow(`CANONICAL_PULL_TYPE_UNKNOWN:${type}`);
  }
});

test('retired dispute cooperative and hub min-fee fields fail their exact boundaries', () => {
  expect(() => validateEntityTx({
    type: 'disputeFinalize',
    data: { counterpartyEntityId: 'hub', cooperative: true },
  }, 'CANONICAL_FINALIZE')).toThrow('CANONICAL_FINALIZE_DATA_FIELDS');
  expect(() => validateEntityTx({
    type: 'setHubConfig',
    data: { minFeeBps: 1n },
  }, 'CANONICAL_HUB_CONFIG')).toThrow('CANONICAL_HUB_CONFIG_DATA_FIELDS');

  const core = projectEntityCoreDoc(
    createEntityProposalFixture('canonical-hub-config-storage').createState(),
  );
  core.hubRebalanceConfig = {
    matchingStrategy: 'amount', policyVersion: 1, routingFeePPM: 1, baseFee: 0n,
    rebalanceLiquidityFeeBps: 1n, minFeeBps: 1n,
  } as never;
  expect(() => validateStorageEntityCoreDocValue(core)).toThrow(
    'STORAGE_ENTITY_DOC_INVALID_HUB_REBALANCE_CONFIG_FIELDS',
  );
});

test('each payment operation retains one explicit canonical transaction path', () => {
  expect(ENTITY_TX_TYPES.includes('directPayment')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('htlcPayment')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('placeSwapOffer')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('prepareCrossJurisdictionSwap')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('extendCredit')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('lendingOffer')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('lendingBorrow')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('lendingRepay')).toBe(true);
  expect(ENTITY_TX_TYPES.includes('lendingClosePosition')).toBe(true);

  const paymentCommand = source('frontend/src/lib/components/Entity/payments/runtime/payment-command.ts');
  expect(paymentCommand).toContain("const isDirect = input.deliveryMode === 'direct';");
  expect(paymentCommand).toContain("const isTrusted = input.deliveryMode === 'trusted';");
  expect(paymentCommand).toContain('const usesDirectPayment = isDirect || isTrusted;');
  expect(paymentCommand).toContain("entityTxs: usesDirectPayment\n        ? [{\n            type: 'directPayment'");
  expect(paymentCommand).toContain("        : [{\n            type: 'htlcPayment'");

  expect(source('core/entity/tx/handlers/payments/direct-payment.ts'))
    .toContain("type: 'direct_payment'");
  expect(source('core/entity/tx/handlers/htlc/payment.ts'))
    .toContain("type: 'htlc_lock'");
  expect(source('core/entity/tx/handlers/payments/swap-requests.ts'))
    .toContain("type: 'swap_offer'");

  const crossJurisdiction = source('core/entity/tx/handlers/cross-j/setup.ts');
  expect(crossJurisdiction).toContain("{ type: 'registerCrossJurisdictionSwap', data: { route: readyRoute } }");
  expect(crossJurisdiction).toContain("buildCrossJurisdictionPullBinding(route, 'source')");
  expect(crossJurisdiction).toContain("buildCrossJurisdictionPullBinding(route, 'target')");

  expect(source('core/entity/tx/handlers/account/lifecycle/admin.ts'))
    .toContain("type: 'set_credit_limit'");

  const lendingPanel = source('frontend/src/lib/components/Entity/payments/LendingPanel.svelte');
  for (const type of ['lendingOffer', 'lendingBorrow', 'lendingRepay']) {
    expect(lendingPanel).toContain(`type: '${type}'`);
  }
  const lendingHandler = source('core/entity/tx/handlers/payments/lending.ts');
  for (const type of ['lending_fund', 'lending_borrow_request', 'lending_repay', 'lending_close_request']) {
    expect(lendingHandler).toContain(`type: '${type}'`);
  }
});

test('four payment modes stay distinct while retired swap alternatives fail loud', () => {
  const direct = {
    type: 'directPayment',
    data: {
      targetEntityId: 'recipient', tokenId: 1, amount: 1n,
      route: ['sender', 'recipient'],
      deliveryMode: 'direct',
    },
  };
  expect(validateEntityTx(direct, 'CANONICAL_DIRECT').type).toBe('directPayment');
  expect(() => validateEntityTx({
    ...direct,
    data: { ...direct.data, deliveryMode: undefined },
  }, 'CANONICAL_DIRECT')).toThrow();
  expect(validateEntityTx({
    ...direct,
    data: {
      ...direct.data,
      deliveryMode: 'trusted',
      route: ['sender', 'hub', 'recipient'],
      trustedGatewayEntityId: 'hub',
    },
  }, 'CANONICAL_DIRECT').type).toBe('directPayment');

  const retiredResolveType = ['resolve', 'Swap'].join('');
  expect(() => validateEntityTx({ type: retiredResolveType, data: {} }, 'CANONICAL_SWAP'))
    .toThrow('CANONICAL_SWAP_TYPE_UNKNOWN');
  expect(() => validateEntityTx({
    type: 'placeSwapOffer',
    data: {
      counterpartyEntityId: 'hub', offerId: 'order', giveTokenId: 1,
      giveAmount: 1n, wantTokenId: 2, wantAmount: 1n,
      crossJurisdiction: {},
    },
  }, 'CANONICAL_SWAP')).toThrow();

  const paymentPanel = source('frontend/src/lib/components/Entity/payments/PaymentPanel.svelte');
  for (const mode of ['direct', 'instant', 'async', 'trusted']) {
    expect(paymentPanel).toContain(`value: '${mode}'`);
  }
  expect(source('frontend/src/lib/components/Entity/payments/runtime/payment-command.ts'))
    .toContain("type: 'directPayment'");
});

test('same-j offers are projected only by the counterparty matcher', () => {
  const frameApplication = source('core/entity/consensus/frame/application.ts');
  expect(frameApplication).toContain('if (!currentEntityState.orderbookExt) return stats;');
  expect(frameApplication).toContain("entityLog.debug('orderbook.skip_local_maker'");
  expect(frameApplication).toContain('if (!currentEntityState.orderbookExt) return;');
  expect(frameApplication).not.toContain('ORDERBOOK_EXTENSION_REQUIRED_FOR_MATCHING');
});

test('public proof smoke exercises only the canonical timed dispute path', () => {
  const publicProof = source('jurisdictions/scripts/public-proof-smoke.ts');
  expect(publicProof).not.toContain('hashCooperativeDisputeProofHankoPayload');
  expect(publicProof).not.toContain('cooperativeClose');
  expect(publicProof).not.toContain('cooperative: true');
  expect(publicProof).toContain('const disputeNonce = settlementNonce + 1n;');
  expect(publicProof).toContain('cooperative: false');
  expect(publicProof).toContain('await waitForUnixTimestamp(targetTimestamp)');
});
