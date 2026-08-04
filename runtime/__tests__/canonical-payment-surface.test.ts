import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENTITY_TX_TYPES } from '../entity/tx/catalog';
import { validateEntityTx } from '../entity/tx-validation';
import { decodeAccountTx } from '../account/tx-validation';
import { validateStorageEntityCoreDocValue } from '../storage/schema-state-docs';
import { projectEntityCoreDoc } from '../storage/projections';
import { createEntityProposalFixture } from './helpers/entity-proposal-fixture';

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
];
const removedAccountTxs = [
  ['pull', 'lock'].join('_'),
  ['pull', 'resolve'].join('_'),
  ['pull', 'cancel'].join('_'),
];
const historicalPrefixes = ['.archive/', 'audits/', 'docs/archive/', 'docs/audit/', 'docs/releases/'];

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
});

test('retired Entity and Account pull discriminants fail at their canonical decoders', () => {
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

  const paymentPanel = source('frontend/apps/wallet/src/features/payments/WalletPaymentForm.tsx');
  const paymentAdapter = source('frontend/packages/runtime-client/wallet-payment-input-adapter.ts');
  expect(paymentPanel).toContain('buildWalletPaymentCommand({');
  expect(paymentPanel).toContain('await submitWalletFinancialCommand(key, command.input)');
  expect(paymentAdapter).toContain("const direct = draft.deliveryMode === 'direct' || draft.deliveryMode === 'trusted';");
  expect(paymentAdapter).toContain("type: 'directPayment' as const");
  expect(paymentAdapter).toContain("type: 'htlcPayment' as const");

  expect(source('runtime/entity/tx/handlers/direct-payment.ts'))
    .toContain("type: 'direct_payment'");
  expect(source('runtime/entity/tx/handlers/htlc-payment.ts'))
    .toContain("type: 'htlc_lock'");
  expect(source('runtime/entity/tx/handlers/swap-requests.ts'))
    .toContain("type: 'swap_offer'");
  expect(source('runtime/entity/consensus/frame-application.ts')).not.toContain('Fallback:');

  const crossJurisdiction = source('runtime/entity/tx/handlers/cross-j-setup.ts');
  expect(crossJurisdiction).toContain("{ type: 'registerCrossJurisdictionSwap', data: { route: readyRoute } }");
  expect(crossJurisdiction).toContain("buildCrossJurisdictionPullBinding(route, 'source')");
  expect(crossJurisdiction).toContain("buildCrossJurisdictionPullBinding(route, 'target')");

  expect(source('runtime/entity/tx/handlers/account-admin.ts'))
    .toContain("type: 'set_credit_limit'");

  const lendingPanel = source('frontend/apps/wallet/src/features/accounts/WalletLending.tsx');
  const financialAdapter = source('frontend/packages/runtime-client/wallet-financial-input-adapter.ts');
  for (const builder of ['buildWalletLendingOfferInput', 'buildWalletLendingBorrowInput', 'buildWalletLendingRepayInput']) {
    expect(lendingPanel).toContain(builder);
  }
  for (const type of ['lendingOffer', 'lendingBorrow', 'lendingRepay']) {
    expect(financialAdapter).toContain(`type: '${type}'`);
  }
  const lendingHandler = source('runtime/entity/tx/handlers/lending.ts');
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

  const paymentPanel = source('frontend/apps/wallet/src/features/payments/WalletPaymentForm.tsx');
  const paymentAdapter = source('frontend/packages/runtime-client/wallet-payment-input-adapter.ts');
  for (const mode of ['direct', 'instant', 'async']) {
    expect(paymentPanel).toContain(`value="${mode}"`);
  }
  expect(paymentPanel).toContain('buildWalletPaymentCommand({');
  expect(paymentAdapter).toContain("draft.deliveryMode === 'trusted'");
  expect(paymentAdapter).toContain("type: 'directPayment' as const");
});

test('same-j offers are projected only by the counterparty matcher', () => {
  const frameApplication = source('runtime/entity/consensus/frame-application.ts');
  expect(frameApplication).toContain('if (!currentEntityState.orderbookExt) return stats;');
  expect(frameApplication).toContain("entityLog.debug('orderbook.skip_local_maker'");
  expect(frameApplication).toContain('if (!currentEntityState.orderbookExt) return;');
  expect(frameApplication).not.toContain('ORDERBOOK_EXTENSION_REQUIRED_FOR_MATCHING');
  expect(frameApplication).not.toContain('Fallback:');
});
