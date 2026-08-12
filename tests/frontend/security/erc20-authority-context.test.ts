import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(process.cwd(), 'frontend/src/lib/components/Entity/workspace/shell/EntityPanelTabs.svelte'),
  'utf8',
);

const section = (start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};

test('ERC20 approval pins signer authority before every await and verifies on the same adapter', () => {
  const context = section('async function getMoveAllowanceContext', 'async function requestExternalGasFaucet');
  expect(context.indexOf('captureSignerAuthorityContext(context)')).toBeLessThan(
    context.indexOf('await getXLN()'),
  );

  const approval = section('async function approveMoveExternalAllowance', 'function getDerivedDeltaForAccount');
  expect(approval).toContain('getSignerPrivateKeyForAuthority(authority)');
  expect(approval).toContain('assertSignerAuthorityContextCurrent(authority, "move-erc20-allowance-before-send")');
  expect(approval).toContain('jadapter.getErc20Allowance(token.address, owner, spender)');
  expect(approval).not.toContain('getActiveSignerPrivateKey()');
  expect(approval).not.toContain('getCurrentLiveEntityReplica()');
  expect(approval.indexOf('assertSignerAuthorityContextCurrent')).toBeLessThan(
    approval.indexOf('await jadapter.approveErc20'),
  );
});

test('external transfer cannot pair a captured adapter with a later signer key', () => {
  const transfer = section('async function sendExternalAsset', 'async function collateralToReserve');
  expect(transfer).toContain('captureSignerAuthorityContext("send-external-asset")');
  expect(transfer).toContain('getCurrentEntityJAdapter(xln, authority.env');
  expect(transfer).toContain('getSignerPrivateKeyForAuthority(authority)');
  expect(transfer).toContain('assertSignerAuthorityContextCurrent(authority, "send-external-asset-before-send")');
  expect(transfer).not.toContain('getActiveSignerPrivateKey()');
});
