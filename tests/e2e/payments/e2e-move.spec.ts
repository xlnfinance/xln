import { allowBrowserIssue, expect, test, type Page } from '../../global-setup.mts';
import { Interface, JsonRpcProvider, parseUnits } from 'ethers';
import { safeStringify } from '../../../core/protocol/serialization';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../../core/api/runtime-adapter/types';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { exerciseAssetFaucets } from '../../../ui/tests/assets-faucet';
import { clickFaucet, openMove, readRoutes } from '../../../ui/tests/move-wallet';
import { fundFromHubUi } from '../../../ui/tests/fund-from-hub';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL } from '../../utils/e2e-baseline';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { connectRuntimeToHub } from '../../utils/e2e-connect';

for (const symbol of ['USDC', 'WETH', 'USDT']) {
  test(`asset faucet exposes correct modes and funds ${symbol}`, { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(50_000);
    await ensureE2EBaseline(page, { requireHubMesh: true, requireMarketMaker: false, minHubCount: 3 });
    await gotoApp(page, { appBaseUrl: APP_BASE_URL });
    await createWalletIdentity(page, 'alice', selectDemoMnemonic('alice'));
    // The rejected grant is an asserted negative path; every other browser issue remains fatal.
    allowBrowserIssue({
      type: 'http',
      severity: 'warning',
      url: new URL('/api/faucet/erc20', APP_BASE_URL).href,
      method: 'POST',
      status: 413,
      message: 'HTTP 413',
    });
    allowBrowserIssue({
      type: 'console',
      severity: 'warning',
      url: new URL('/ui/assets', APP_BASE_URL).href,
      message: 'Failed to load resource: the server responded with a status of 413 (Payload Too Large)',
    });
    const provider = new JsonRpcProvider(`${API_BASE_URL}/rpc`, 31337, { staticNetwork: true, cacheTimeout: -1 });
    try {
      // This mesh's existing public faucet cap is 10^21 tokens; the production-profile caller uses 100.
      await exerciseAssetFaucets(page, provider, testInfo, symbol, expect, '1000000000000000000001');
    } finally {
      provider.destroy();
    }
  });
}

type MovePlace = 'external' | 'reserve' | 'account';
type MoveWindow = Window & {
  __xln?: {
    env(): RuntimeReplica | null;
    xln(): Promise<XLNModule>;
    adapter(): RuntimeAdapter | null;
    store: { getState(): { activeEntityId: string | null } };
  };
};
const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };

async function readMoney(page: Page, counterparty: string) {
  const places = await readRoutes(page);
  const observation = await page.evaluate(async hubId => {
    const debug = (window as MoveWindow).__xln;
    const adapter = debug?.adapter();
    const entityId = debug?.store.getState().activeEntityId;
    if (!debug || !adapter || !entityId) throw new Error('MOVE_OWNER_MISSING');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
    const active = frame.activeEntity;
    if (!active) throw new Error('MOVE_ENTITY_MISSING');
    const account = active.accounts.items.find(
      row => row.state.leftEntity === hubId || row.state.rightEntity === hubId,
    );
    const delta = account?.state.deltas.get(1);
    if (!account || !delta) throw new Error(`MOVE_ACCOUNT_MISSING:${hubId}`);
    const value = (await debug.xln()).deriveDelta(delta, account.state.leftEntity === entityId);
    return {
      entityNonce: active.core.jBatchState?.entityNonce ?? 0,
      depository: active.core.config.jurisdiction?.depositoryAddress,
      account: {
        owned: String(value.outCollateral + value.outPeerCredit - value.inOwnCredit),
        capacity: String(value.outCapacity),
        collateral: String(delta.collateral),
        pending: Boolean(account.pendingFrame),
        mempool: account.mempoolCount,
      },
    };
  }, counterparty);
  return { ...places, ...observation };
}

const batchEvents = new Interface([
  'event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed batchHash, uint256 nonce)',
]);

async function confirmedBatches(
  provider: JsonRpcProvider,
  entityId: string,
  before: Awaited<ReturnType<typeof readMoney>>,
  after: Awaited<ReturnType<typeof readMoney>>,
  fromBlock: number,
) {
  if (!before.depository) throw new Error('MOVE_DEPOSITORY_MISSING');
  expect(after.entityNonce).toBeGreaterThan(before.entityNonce);
  const logs = await provider.getLogs({
    address: before.depository,
    fromBlock,
    toBlock: 'latest',
    topics: batchEvents.encodeFilterTopics('HankoBatchProcessed', [entityId]),
  });
  const evidence = [];
  for (let nonce = before.entityNonce + 1; nonce <= after.entityNonce; nonce++) {
    const matching = logs.filter(log => batchEvents.parseLog(log)?.args.nonce === BigInt(nonce));
    expect(matching, 'exactly one committed receipt for each Entity nonce').toHaveLength(1);
    const log = matching[0];
    if (!log) throw new Error('MOVE_BATCH_RECEIPT_MISSING');
    const event = batchEvents.parseLog(log);
    if (!event) throw new Error('MOVE_BATCH_EVENT_MISSING');
    expect(String(event.args.entityId).toLowerCase()).toBe(entityId.toLowerCase());
    expect(log.removed).toBe(false);
    expect(log.address.toLowerCase()).toBe(before.depository.toLowerCase());
    const receipt = await provider.getTransactionReceipt(log.transactionHash);
    if (!receipt) throw new Error('MOVE_MINED_RECEIPT_MISSING');
    expect(receipt.status).toBe(1);
    expect(receipt.hash).toBe(log.transactionHash);
    expect(receipt.blockHash).toBe(log.blockHash);
    evidence.push({
      nonce,
      transactionHash: receipt.hash,
      blockHash: receipt.blockHash,
      batchHash: String(event.args.batchHash),
    });
  }
  return evidence;
}

async function assertFreshAllowances(page: Page) {
  const rows = await page.evaluate(async () => {
    const debug = (window as MoveWindow).__xln;
    const env = debug?.env();
    const entityId = debug?.store.getState().activeEntityId;
    if (!debug || !env || !entityId) throw new Error('MOVE_OWNER_MISSING');
    const replica = [...env.state.eReplicas.values()].find(row => row.entityId === entityId);
    if (!replica) throw new Error('MOVE_REPLICA_MISSING');
    const chain = (await debug.xln()).getEntityJAdapter(env, entityId, replica.signerId);
    if (!chain) throw new Error('MOVE_CHAIN_MISSING');
    const tokens = (await chain.getTokenRegistry()).filter(row => ['USDC', 'USDT', 'WETH'].includes(row.symbol));
    const snapshot = await chain.readWalletSnapshot({
      owner: replica.signerId,
      tokenAddresses: [],
      allowances: tokens.map(token => ({ tokenAddress: token.address, spender: chain.addresses.depository })),
    });
    if (!snapshot.allowances || snapshot.allowances.length !== tokens.length)
      throw new Error('MOVE_ALLOWANCES_MISSING');
    const allowances = snapshot.allowances;
    return tokens.map((token, index) => ({ symbol: token.symbol, allowance: String(allowances[index]) }));
  });
  expect(rows.map(row => row.symbol).sort()).toEqual(['USDC', 'USDT', 'WETH']);
  expect(rows.every(row => row.allowance === '0')).toBe(true);
}

async function seedMoveWallet(page: Page) {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await clickFaucet(page, 'gas', expect);
  await page.getByTestId('faucet-amount').fill('120');
  await clickFaucet(page, 'erc20', expect);
  await page.getByTestId('faucet-amount').fill('100');
  await clickFaucet(page, 'reserve', expect);
  await fundFromHubUi(page, expect);
}

for (const group of ['reserve-and-own-account', 'remote-and-external', 'round-trips'])
  test(
    `move routed paths on isolated runtimes: ${group}`,
    { tag: '@functional' },
    async ({ page, browser }, testInfo) => {
      test.setTimeout(55_000);
      const health = await ensureE2EBaseline(page, { requireHubMesh: true, requireMarketMaker: false, minHubCount: 3 });
      const h1 = health.hubs?.find(hub => hub.name === 'H1')?.entityId;
      const h2 = health.hubs?.find(hub => hub.name === 'H2')?.entityId;
      if (!h1 || !h2) throw new Error('MOVE_HUBS_MISSING');
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const bobPage = await context.newPage();
      const evidence: unknown[] = [];
      const provider = new JsonRpcProvider(`${API_BASE_URL}/rpc`, 31337, { staticNetwork: true, cacheTimeout: -1 });
      try {
        await Promise.all([
          gotoApp(page, { appBaseUrl: APP_BASE_URL }),
          gotoApp(bobPage, { appBaseUrl: APP_BASE_URL }),
        ]);
        const [alice, bob] = await Promise.all([
          createWalletIdentity(page, 'alice', selectDemoMnemonic('alice')),
          createWalletIdentity(bobPage, 'bob', selectDemoMnemonic('bob')),
        ]);
        await Promise.all([connectRuntimeToHub(page, alice, h1), connectRuntimeToHub(bobPage, bob, h2)]);
        await assertFreshAllowances(page);
        await seedMoveWallet(page);
        const readPair = async () => ({ alice: await readMoney(page, h1), bob: await readMoney(bobPage, h2) });
        const amounts = (state: Awaited<ReturnType<typeof readPair>>) => ({
          alice: { external: state.alice.external, reserve: state.alice.reserve, account: state.alice.account.owned },
          bob: { external: state.bob.external, reserve: state.bob.reserve, account: state.bob.account.owned },
        });
        const idle = (state: Awaited<ReturnType<typeof readPair>>) =>
          [state.alice, state.bob].every(
            wallet =>
              !wallet.batch.sent &&
              wallet.batch.draftOperations === 0 &&
              !wallet.account.pending &&
              wallet.account.mempool === 0,
          );
        await expect
          .poll(async () => {
            const state = await readPair();
            return { amounts: amounts(state), idle: idle(state) };
          }, WAIT)
          .toEqual({
            amounts: {
              alice: { external: '120000000', reserve: '100000000', account: '100000000' },
              bob: { external: '0', reserve: '0', account: '0' },
            },
            idle: true,
          });

        await openMove(page, 'external', 'reserve');
        await page.getByRole('button', { name: 'USDC', exact: true }).click();
        for (const symbol of ['USDC', 'WETH', 'USDT'])
          await expect(page.getByRole('option', { name: new RegExp(`^${symbol}`) })).toBeVisible();
        await page.getByRole('option', { name: /^USDC/ }).click();

        const move = async (
          name: string,
          from: MovePlace,
          to: MovePlace,
          amount: string,
          remote = false,
          targetFirst = false,
        ) => {
          console.log(`MOVE_ROUTE_START ${name}`);
          const before = await readPair();
          const fromBlock = await provider.getBlockNumber();
          expect(idle(before)).toBe(true);
          const units = parseUnits(amount, 6);
          const recipient = remote ? bob : alice;
          const recipientHub = remote ? h2 : h1;
          await page.getByTestId('nav-home').locator('visible=true').first().click();
          await page.getByTestId('home-move').click();
          const order = targetFirst
            ? [
                ['to', to],
                ['from', from],
              ]
            : [
                ['from', from],
                ['to', to],
              ];
          for (const [side, place] of order) await page.getByTestId(`move-${side}-${place}`).click();
          await page.getByTestId('move-amount').fill(amount);
          if (from === 'account') await page.getByTestId('move-source-account').selectOption(h1);
          if (to === 'account') {
            if (remote) {
              await page.getByPlaceholder('0x… entity id', { exact: true }).fill(recipient.entityId);
              await expect(page.getByTestId('move-target-hub')).toHaveValue('');
              await expect(page.getByTestId('move-draft')).toBeDisabled();
            }
            const choices = await page
              .getByTestId('move-target-hub')
              .locator('option')
              .evaluateAll(rows => rows.map(row => row.getAttribute('value')));
            expect(choices, `recipient Account ${recipientHub} must be selectable`).toContain(recipientHub);
            await page.getByTestId('move-target-hub').selectOption(recipientHub);
          }
          if (to === 'reserve' && remote)
            await page.getByPlaceholder('0x… entity id', { exact: true }).fill(recipient.entityId);
          if (to === 'external') await page.getByTestId('move-external-recipient').fill(recipient.signerId);
          if (from === 'external' && to !== 'external') {
            expect(before.alice.allowance).toBe('0');
            await expect(page.getByTestId('move-approve')).toBeEnabled();
            await page.getByTestId('move-approve').click();
            await expect(page.getByTestId('move-approve')).toHaveCount(0, WAIT);
            expect((await readRoutes(page)).allowance).toBe(units.toString());
          }
          if (from === 'external' && to === 'external') await page.getByTestId('move-send-external').click();
          else {
            await expect(page.getByTestId('move-draft')).toBeEnabled();
            await page.getByTestId('move-draft').click();
            await expect(page.getByTestId('batch-broadcast')).toBeVisible(WAIT);
            const drafted = await readPair();
            expect(amounts(drafted)).toEqual(amounts(before));
            expect(drafted.alice.batch.draftOperations).toBeGreaterThan(0);
            expect(drafted.alice.batch.sent).toBe(false);
            await page.screenshot({ path: testInfo.outputPath(`${name}-draft.png`) });
            await page.getByTestId('batch-broadcast').click();
          }
          const expected = amounts(before);
          expected.alice[from] = (BigInt(expected.alice[from]) - units).toString();
          const receiver = remote ? expected.bob : expected.alice;
          receiver[to] = (BigInt(receiver[to]) + units).toString();
          await expect
            .poll(async () => {
              const state = await readPair();
              return { amounts: amounts(state), idle: idle(state) };
            }, WAIT)
            .toEqual({ amounts: expected, idle: true });
          const after = await readPair();
          if (from === 'account')
            expect(BigInt(after.alice.account.capacity)).toBe(BigInt(before.alice.account.capacity) - units);
          if (to === 'account') {
            const owner = remote ? 'bob' : 'alice';
            expect(BigInt(after[owner].account.capacity)).toBe(BigInt(before[owner].account.capacity) + units);
          }
          expect(after.alice.allowance).toBe('0');
          const total = Object.values(amounts(after))
            .flatMap(Object.values)
            .reduce((sum, value) => sum + BigInt(value), 0n);
          expect(total).toBe(320_000_000n);
          const receipts =
            from === 'external' && to === 'external'
              ? []
              : await confirmedBatches(provider, alice.entityId, before.alice, after.alice, fromBlock);
          if (from === 'external' && to === 'external') expect(after.alice.entityNonce).toBe(before.alice.entityNonce);
          evidence.push({ name, from, to, amount, remote, before, after, receipts });
          console.log(`MOVE_ROUTE_CONFIRMED ${name}`);
          return { before, after };
        };
        if (group === 'reserve-and-own-account') {
          await move('e2r', 'external', 'reserve', '20');
          await move('r2a-self', 'reserve', 'account', '8');
          await move('a2r-self', 'account', 'reserve', '3');
          await move('r2e', 'reserve', 'external', '2');
          await move('r2r-remote', 'reserve', 'reserve', '4', true);
        }
        if (group === 'remote-and-external') {
          await move('prepare-collateral', 'reserve', 'account', '8');
          await move('e2a-remote', 'external', 'account', '5', true);
          await move('a2e', 'account', 'external', '1');
          await move('a2a-remote', 'account', 'account', '2', true);
          await move('e2e', 'external', 'external', '7', true);
        }
        if (group === 'round-trips') {
          await move('prepare-collateral', 'reserve', 'account', '8');
          const first = await move('roundtrip-r2e', 'reserve', 'external', '1.25', false, true);
          const second = await move('roundtrip-e2a', 'external', 'account', '1.25', true, true);
          expect(second.after.alice.external).toBe(first.before.alice.external);
          expect(BigInt(second.after.bob.account.owned)).toBe(BigInt(first.before.bob.account.owned) + 1_250_000n);
          const third = await move('roundtrip-a2r', 'account', 'reserve', '0.5');
          const fourth = await move('roundtrip-r2e-final', 'reserve', 'external', '0.5', false, true);
          expect(fourth.after.alice.reserve).toBe(third.before.alice.reserve);
          expect(BigInt(fourth.after.alice.external)).toBe(BigInt(third.before.alice.external) + 500_000n);
          expect(BigInt(fourth.after.alice.account.owned)).toBe(BigInt(third.before.alice.account.owned) - 500_000n);
        }
      } finally {
        provider.destroy();
        await testInfo.attach('routed-move-exact-balances', {
          body: safeStringify(evidence),
          contentType: 'application/json',
        });
        await context.close();
      }
    },
  );
