import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from '../../frontend/node_modules/react-dom/server.browser.js';

import { WalletAccountConfigure } from '../../frontend/apps/wallet/src/features/accounts/WalletAccountConfigure';
import { WalletAccountDispute } from '../../frontend/apps/wallet/src/features/accounts/WalletAccountDispute';
import { WalletExternalMove } from '../../frontend/apps/wallet/src/features/accounts/WalletExternalMove';
import { WalletLending } from '../../frontend/apps/wallet/src/features/accounts/WalletLending';
import { WalletMoveCredit } from '../../frontend/apps/wallet/src/features/accounts/WalletMoveCredit';
import { WalletSettlement } from '../../frontend/apps/wallet/src/features/accounts/WalletSettlement';
import type { WalletEntityAccountsView } from '../../frontend/apps/wallet/src/features/accounts/account-view-model';
import { WalletReceiveForm } from '../../frontend/apps/wallet/src/features/payments/WalletReceiveForm';
import { WalletTestnetPage } from '../../frontend/apps/wallet/src/features/routes/WalletTestnetPage';

const ENTITY = `0x${'11'.repeat(32)}`;
const PEER = `0x${'22'.repeat(32)}`;

const entity: WalletEntityAccountsView = {
  entityId: ENTITY,
  signerId: 'signer',
  runtimeId: 'runtime',
  jurisdiction: 'Local',
  label: 'Primary',
  height: 19,
  reserves: [{ tokenId: 1, symbol: 'USDC', decimals: 6, raw: '5000000', formatted: '5' }],
  catalog: [
    { tokenId: 1, symbol: 'USDC', decimals: 6 },
    { tokenId: 2, symbol: 'WETH', decimals: 18 },
  ],
  accounts: [{
    counterpartyId: PEER,
    status: 'active',
    currentHeight: 7,
    pending: false,
    disputed: false,
    activeDispute: false,
    disputeRiskEvidenceComplete: true,
    crossJTargetDisputeRisk: null,
    isLeftPerspective: true,
    workspaceStatus: 'ready_to_submit',
    workspaceHash: `0x${'aa'.repeat(32)}`,
    workspaceRevision: 2,
    workspaceLocalIsExecutor: true,
    workspaceHasLocalHanko: true,
    workspaceHasPeerHanko: true,
    tokens: [{
      tokenId: 1,
      symbol: 'USDC',
      decimals: 6,
      raw: '1000000',
      formatted: '1',
      outboundRaw: '4000000',
      inboundRaw: '3000000',
      collateralRaw: '5000000',
      ownCreditLimitRaw: '1000000',
      peerCreditLimitRaw: '2000000',
      withdrawableCollateralRaw: '2500000',
      outbound: '4',
      inbound: '3',
    }],
  }],
  batch: {
    status: 'accumulating',
    mode: 'draft',
    draftCount: 1,
    sentCount: 0,
    hasDraftBatch: true,
    hasSentBatch: false,
    canBroadcast: true,
    reserveIssue: null,
  },
};

test('financial React surfaces expose explicit operations and immutable review entry points', () => {
  const html = [
    renderToStaticMarkup(<WalletMoveCredit entity={entity} receipt={null} />),
    renderToStaticMarkup(<WalletExternalMove entity={entity} receipt={null} />),
    renderToStaticMarkup(<WalletLending entity={entity} receipt={null} />),
    renderToStaticMarkup(<WalletSettlement entity={entity} receipt={null} />),
  ].join('');
  expect(html).toContain('Reserve → external wallet');
  expect(html).toContain('Account → account');
  expect(html).toContain('External → reserve');
  expect(html).toContain('Review lending intent');
  expect(html).toContain('Review execution');
  expect(html).toContain('Review broadcast');
  expect(html).not.toContain('coming soon');
});

test('account configuration, dispute, and receive surfaces state exact safety boundaries', () => {
  const account = entity.accounts[0]!;
  const html = [
    renderToStaticMarkup(<WalletAccountConfigure entity={entity} account={account} receipt={null} />),
    renderToStaticMarkup(<WalletAccountDispute entity={entity} account={account} receipt={null} />),
    renderToStaticMarkup(<WalletReceiveForm entity={entity} />),
  ].join('');
  expect(html).toContain('Review add asset');
  expect(html).toContain('Review dispute prepare');
  expect(html).toContain('canonical invoice');
  expect(html).toContain('Copy invoice');
});

test('testnet route preserves wallet, custody, health, and no-real-funds contracts', () => {
  const html = renderToStaticMarkup(<WalletTestnetPage />);
  expect(html).toContain('TESTNET · NO REAL FUNDS');
  expect(html).toContain('href="/app"');
  expect(html).toContain('href="https://custody.xln.finance"');
  expect(html).toContain('href="/health"');
});
