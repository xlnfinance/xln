import { allowBrowserIssue, expect, test, type Page } from '../../global-setup.mts';
import { Interface, JsonRpcProvider, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { exerciseAssetFaucets } from '../../../ui/tests/assets-faucet';
import { deriveDelta } from '../../../core/account/utils';
import type { JBatch } from '../../../core/jurisdiction/machine/batch';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL, waitForNamedHubs } from '../../utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from '../../utils/e2e-demo-users';
import { connectRuntimeToHub, waitForReceiveReadyGossipProfiles } from '../../utils/e2e-connect';
import {
  getRenderedAccountSpendableBalance,
  getRenderedExternalBalance,
  getRenderedReserveBalance,
} from '../../utils/runtime/e2e-account-ui';
import { timedStep } from '../../utils/e2e-timing.mts';
import { capturePageScreenshot } from '../../utils/e2e-screenshots';

const LONG_E2E = process.env.E2E_LONG === '1';
const ROUTE_TIMEOUT_MS = LONG_E2E ? 90_000 : 60_000;
const EXTERNAL_BATCH_TIMEOUT_MS = LONG_E2E ? 150_000 : 90_000;

type ApiTokenEntry = {
  address?: string;
  symbol?: string;
  decimals?: number;
  tokenId?: number;
};

const ERC20_BALANCE_OF = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
]);
const ERC20_ALLOWANCE = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const DEPOSITORY_BATCH_EVENTS = new Interface([
  'event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed batchHash, uint256 nonce)',
]);
const DEPOSITORY_RESERVES = new Interface([
  'function _reserves(bytes32 entity, uint256 tokenId) view returns (uint256)',
]);

async function timedMillis<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const elapsedMillis = Number(process.hrtime.bigint() - started) / 1_000_000;
    console.log(`[E2E-TIMING-MS] ${label} ${elapsedMillis.toFixed(3)}ms`);
  }
}

function logBalanceDelta(
  label: string,
  input: {
    beforeSender?: number;
    afterSender?: number;
    beforeRecipient?: number;
    afterRecipient?: number;
  },
): void {
  console.log(
    `[E2E-BALANCE] ${label} ` +
      `sender=${input.beforeSender ?? 'n/a'}->${input.afterSender ?? 'n/a'} ` +
      `recipient=${input.beforeRecipient ?? 'n/a'}->${input.afterRecipient ?? 'n/a'}`
  );
}

async function openAssetsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-assets').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('asset-ledger-refresh').first()).toBeVisible({ timeout: 20_000 });
}

async function selectAssetFaucetToken(page: Page, symbol: string): Promise<void> {
  await openAssetsTab(page);
  const select = page.getByTestId('asset-faucet-symbol').first();
  await expect(select).toBeVisible({ timeout: 20_000 });
  await select.selectOption(symbol);
  await expect(select).toHaveValue(symbol, { timeout: 20_000 });
}

async function clickReserveFaucet(page: Page, symbol: string): Promise<unknown> {
  await selectAssetFaucetToken(page, symbol);
  const button = page.getByTestId(`reserve-faucet-${symbol}`).first();
  await expect(button).toBeEnabled({ timeout: 20_000 });
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().includes('/api/faucet/reserve'),
  );
  await button.click();
  const response = await responsePromise;
  const body = await response.json().catch(async () => ({ raw: await response.text().catch(() => '') }));
  console.log(`[reserve faucet response ${symbol}] status=${response.status()} body=${JSON.stringify(body)}`);
  expect(response.ok(), `reserve faucet ${symbol} failed: status=${response.status()} body=${JSON.stringify(body)}`).toBe(true);
  expect((body as { success?: unknown }).success, `reserve faucet ${symbol} response must be successful`).toBe(true);
  return body;
}

async function clickAccountFaucet(page: Page, symbol: string): Promise<void> {
  await selectAssetFaucetToken(page, symbol);
  const button = page.getByTestId(`account-faucet-${symbol}`).first();
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
}

async function openMoveTab(page: Page): Promise<void> {
  await openAssetsTab(page);
  await page.getByTestId('asset-tab-move').first().click();
  await expect(page.getByTestId('move-route-summary').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('move-committed-line').first()).toBeVisible({ timeout: 20_000 });
}

async function openAccountsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-accounts').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('account-list-wrapper').first()).toBeVisible({ timeout: 20_000 });
}

async function openAccountBatchHistory(page: Page): Promise<void> {
  await openAccountsTab(page);
  const historyTab = page.locator('[data-testid="account-workspace-tab-history"]:visible').first();
  await expect(historyTab).toBeVisible({ timeout: 20_000 });
  await historyTab.click();
  await expect(page.getByTestId('entity-history-panel').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('entity-history-event').first()).toBeVisible({ timeout: 20_000 });
}

async function expectMoveAssetSelector(page: Page): Promise<void> {
  const select = page.getByTestId('move-asset-symbol').first();
  await expect(select).toBeVisible({ timeout: 20_000 });
  const optionValues = (await select.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => String((node as HTMLOptionElement).value || '').trim()).filter(Boolean),
  )).map((value) => value.toUpperCase());
  expect(optionValues, `Move asset selector must expose canonical tokens, got ${JSON.stringify(optionValues)}`).toEqual(
    expect.arrayContaining(['USDC', 'USDT', 'WETH']),
  );
  await expect(select, `Move asset selector must default to USDC, got ${JSON.stringify(optionValues)}`).toHaveValue('USDC');
}

type LocalEntityRef = {
  entityId: string;
  signerId: string;
};

type MoveBatchSnapshot = {
  pendingExternalToReserve: number;
  pendingReserveToCollateral: number;
  pendingCollateralToReserve: number;
  pendingSettlements: number;
  pendingReserveToReserve: number;
  pendingReserveToExternal: number;
  pendingOpCount: number;
  sentExternalToReserve: number;
  sentReserveToCollateral: number;
  sentCollateralToReserve: number;
  sentSettlements: number;
  sentReserveToReserve: number;
  sentReserveToExternal: number;
  sentOpCount: number;
  sentExists: boolean;
  entityNonce: number;
  sentEntityNonce: number | null;
  recentMessages: string[];
};

async function getLocalEntity(page: Page): Promise<LocalEntityRef> {
  const entity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.state?.eReplicas) return null;
    for (const [replicaKey] of env.state.eReplicas.entries()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      if (!entityId || !signerId) continue;
      return { entityId, signerId };
    }
    return null;
  });
  if (!entity) throw new Error('No local entity in isolatedEnv');
  return entity;
}

function asLocalEntityRef(ref: { entityId: string; signerId: string }): LocalEntityRef {
  return {
    entityId: String(ref.entityId || '').trim(),
    signerId: String(ref.signerId || '').trim(),
  };
}

async function readMoveBatchSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<MoveBatchSnapshot> {
  return page.evaluate(({ entityId, signerId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.state?.eReplicas) {
      return {
        pendingExternalToReserve: 0,
        pendingReserveToCollateral: 0,
        pendingCollateralToReserve: 0,
        pendingSettlements: 0,
        pendingReserveToReserve: 0,
        pendingReserveToExternal: 0,
        pendingOpCount: 0,
        sentExternalToReserve: 0,
        sentReserveToCollateral: 0,
        sentCollateralToReserve: 0,
        sentSettlements: 0,
        sentReserveToReserve: 0,
        sentReserveToExternal: 0,
        sentOpCount: 0,
        sentExists: false,
        entityNonce: 0,
        sentEntityNonce: null,
        recentMessages: [],
      };
    }
    const key = Array.from(env.state.eReplicas.keys()).find((candidateKey: string) => {
      const [candidateEntityId, candidateSignerId] = String(candidateKey).split(':');
      return String(candidateEntityId || '').toLowerCase() === String(entityId).toLowerCase()
        && String(candidateSignerId || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const replica = key ? env.state.eReplicas.get(key) as {
      state?: {
        jBatchState?: {
          entityNonce?: number;
          batch?: Partial<JBatch>;
          sentBatch?: { entityNonce?: number; batch?: Partial<JBatch> };
        };
        messages?: unknown[];
      };
    } | undefined : undefined;
    const pending = replica?.state?.jBatchState?.batch;
    const sentBatch = replica?.state?.jBatchState?.sentBatch;
    const sent = sentBatch?.batch;
    const recentMessages = Array.isArray(replica?.state?.messages)
      ? replica.state.messages.slice(-8).map((message) => String(message || ''))
      : [];
    const count = (batch: Partial<JBatch> | undefined, key: keyof JBatch): number => {
      const value = batch?.[key];
      return Array.isArray(value) ? value.length : 0;
    };
    // Observational Move readiness: cooperative C2R is queued in settlements,
    // while raw collateralToReserve is a separate contract operation.
    const countTotal = (batch: Partial<JBatch> | undefined): number => (
      count(batch, 'externalTokenToReserve')
      + count(batch, 'reserveToCollateral')
      + count(batch, 'collateralToReserve')
      + count(batch, 'settlements')
      + count(batch, 'reserveToReserve')
      + count(batch, 'reserveToExternalToken')
    );
    return {
      pendingExternalToReserve: count(pending, 'externalTokenToReserve'),
      pendingReserveToCollateral: count(pending, 'reserveToCollateral'),
      pendingCollateralToReserve: count(pending, 'collateralToReserve'),
      pendingSettlements: count(pending, 'settlements'),
      pendingReserveToReserve: count(pending, 'reserveToReserve'),
      pendingReserveToExternal: count(pending, 'reserveToExternalToken'),
      pendingOpCount: countTotal(pending),
      sentExternalToReserve: count(sent, 'externalTokenToReserve'),
      sentReserveToCollateral: count(sent, 'reserveToCollateral'),
      sentCollateralToReserve: count(sent, 'collateralToReserve'),
      sentSettlements: count(sent, 'settlements'),
      sentReserveToReserve: count(sent, 'reserveToReserve'),
      sentReserveToExternal: count(sent, 'reserveToExternalToken'),
      sentOpCount: countTotal(sent),
      sentExists: Boolean(sentBatch),
      entityNonce: Number(replica?.state?.jBatchState?.entityNonce || 0),
      sentEntityNonce: typeof sentBatch?.entityNonce === 'number' ? Number(sentBatch.entityNonce) : null,
      recentMessages,
    };
  }, { entityId, signerId });
}

async function waitForMoveReady(page: Page): Promise<void> {
  const confirm = page.getByTestId('move-confirm').first();
  await expect
    .poll(async () => {
      if (!(await confirm.isDisabled())) return 'enabled';
      const statuses = await page.getByTestId('move-status').allTextContents().catch(() => []);
      const text = statuses.map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ');
      return text || 'disabled';
    }, { timeout: 10_000 })
    .toBe('enabled');
}

async function waitForMoveAllowanceRequired(page: Page): Promise<void> {
  const confirm = page.getByTestId('move-confirm').first();
  const allowancePanel = page.getByTestId('move-allow-panel').first();
  await expect(allowancePanel).toBeVisible({ timeout: 20_000 });
  await expect(confirm).toBeDisabled({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const statuses = await page.getByTestId('move-status').allTextContents().catch(() => []);
      return statuses.map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ');
    }, { timeout: 10_000 })
    .toContain('Allow ERC20 before adding to batch');
}

async function approveMoveAllowance(page: Page, mode: 'amount' | 'max'): Promise<void> {
  const button = page.getByTestId(mode === 'amount' ? 'move-allow-exact' : 'move-allow-max').first();
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  await waitForMoveActionToSettle(page);
}

async function waitForMoveActionToSettle(page: Page): Promise<void> {
  const confirm = page.getByTestId('move-confirm').first();
  await expect
    .poll(async () => String(await confirm.textContent() || '').trim(), { timeout: ROUTE_TIMEOUT_MS })
    .not.toBe('Working...');
}

type MinedBatchLog = { address: string; topics: string[]; data: string; transactionHash: string; blockHash: string; removed?: boolean };

async function readConfirmedMoveBatch(
  page: Page, depository: string, entityId: string, nonce: number, fromBlock: string,
): Promise<MinedBatchLog | null> {
  const logs = await rpcCall<MinedBatchLog[]>(page, 'eth_getLogs', [{
    address: depository, fromBlock, toBlock: 'latest',
    topics: DEPOSITORY_BATCH_EVENTS.encodeFilterTopics('HankoBatchProcessed', [entityId]),
  }]);
  const matching = logs.filter(log => {
    const event = DEPOSITORY_BATCH_EVENTS.parseLog(log);
    return event?.args.nonce === BigInt(nonce);
  });
  expect(matching.length, 'one committed batch receipt per exact Entity nonce').toBeLessThanOrEqual(1);
  const log = matching[0];
  if (!log) return null;
  const event = DEPOSITORY_BATCH_EVENTS.parseLog(log)!;
  expect(String(event.args.entityId).toLowerCase()).toBe(entityId.toLowerCase());
  expect(event.args.nonce).toBe(BigInt(nonce));
  expect(log.removed, 'confirmed batch log must not be removed').not.toBe(true);
  expect(log.address.toLowerCase()).toBe(depository.toLowerCase());
  const receipt = await rpcCall<{ status: string; transactionHash: string; blockHash: string } | null>(
    page, 'eth_getTransactionReceipt', [log.transactionHash],
  );
  expect(receipt, 'mined batch must have its successful transaction receipt').not.toBeNull();
  expect(receipt!.status).toBe('0x1');
  expect(receipt!.transactionHash.toLowerCase()).toBe(log.transactionHash.toLowerCase());
  expect(receipt!.blockHash.toLowerCase()).toBe(log.blockHash.toLowerCase());
  return log;
}

async function readMoveVisibleDiagnostic(page: Page) {
  return page.evaluate(() => {
    const picker = document.querySelector('[data-testid="move-source-account-picker"]');
    return {
      sourceAccountLabel: picker?.querySelector('.item-name')?.textContent?.trim() ?? null,
      sourceAccountDisplayedId: picker?.querySelector('.item-id')?.textContent?.trim() ?? null,
      sourceAccountInput: picker?.querySelector('input')?.value ?? null,
      toasts: Array.from(document.querySelectorAll('.toast.error, .toast.info, .toast.warning'))
        .filter(node => node.getClientRects().length > 0)
        .map(node => ({ type: node.className, message: node.querySelector('.message')?.textContent?.trim() ?? '' })),
    };
  });
}

async function captureMoveSettlementDiagnostic(
  page: Page, entity: LocalEntityRef, initialSurface: Awaited<ReturnType<typeof readMoveVisibleDiagnostic>>,
): Promise<void> {
  const local = await page.evaluate(({ entityId, signerId }) => {
    const env = (window as any).isolatedEnv;
    const replicaKey = Array.from(env?.state?.eReplicas?.keys() ?? []).find(
      (key: any) => String(key).toLowerCase() === `${entityId}:${signerId}`.toLowerCase(),
    );
    const replica = env?.state?.eReplicas?.get(replicaKey);
    const accounts = Array.from(replica?.state?.accounts?.entries?.() ?? [], ([counterpartyId, account]: any) => {
      const workspace = account.state.settlementWorkspace;
      const continuation = replica.state.settlementContinuations?.get(counterpartyId);
      return {
        counterpartyId, height: account.currentHeight, pendingFrame: Boolean(account.pendingFrame),
        pendingAck: account.pendingAccountInput?.kind === 'ack_frame',
        mempoolKinds: (account.mempool ?? []).map((tx: any) => tx.type),
        pendingFrameKinds: (account.pendingFrame?.accountTxs ?? []).map((tx: any) => tx.type),
        workspace: workspace ? {
          status: workspace.status, revision: workspace.revision, workspaceHash: workspace.workspaceHash,
          settlementHash: workspace.settlementHash ?? null, executorIsLeft: workspace.executorIsLeft,
          leftHanko: Boolean(workspace.leftHanko), rightHanko: Boolean(workspace.rightHanko),
          postLeftHanko: Boolean(workspace.postSettlementDisputeProof?.leftHanko),
          postRightHanko: Boolean(workspace.postSettlementDisputeProof?.rightHanko),
        } : null,
        continuation: continuation ? { workspaceHash: continuation.workspaceHash, broadcast: continuation.broadcast } : null,
        deferredApproval: replica.state.deferredAccountProposals?.get(counterpartyId) ?? null,
      };
    });
    return {
      replicaPresent: Boolean(replica), runtimeHeight: env?.state?.height ?? null,
      entityHeight: replica?.state?.height ?? null,
      entityMempoolKinds: (replica?.mempool ?? []).map((tx: any) => tx.type),
      proposalKinds: (replica?.proposal?.txs ?? []).map((tx: any) => tx.type),
      accounts,
    };
  }, entity);
  const hubs = await Promise.all(local.accounts.map(async account => {
    const url = new URL('/api/hub/account-status', API_BASE_URL);
    url.searchParams.set('hubEntityId', String(account.counterpartyId));
    url.searchParams.set('counterpartyEntityId', entity.entityId);
    const response = await page.request.get(url.href, { timeout: 3000 });
    const status = await response.json();
    return {
      counterpartyId: account.counterpartyId, httpStatus: response.status(),
      hasAccount: status.hasAccount ?? null, height: status.currentHeight ?? null,
      pendingFrameHeight: status.pendingFrameHeight ?? null, mempoolCount: status.mempool ?? null,
      entityMempoolKinds: status.replica?.mempool ?? null, proposalKinds: status.replica?.proposalTxs ?? null,
      lockedFrameKinds: status.replica?.lockedFrameTxs ?? null,
      runtimeHeight: status.runtime?.height ?? null,
      halted: status.runtime?.halted ?? null, framePhase: status.runtime?.framePhase ?? null,
      outboundCount: status.runtime?.pendingNetworkOutputs ?? null,
      workspaceEvidence: 'not_exposed_by_account_status',
    };
  }));
  const surface = await readMoveVisibleDiagnostic(page);
  const { recentMessages: _messages, ...batch } = await readMoveBatchSnapshot(page, entity.entityId, entity.signerId);
  console.log(`[E2E-MOVE-SETTLEMENT] ${JSON.stringify({ entity, initialSurface, surface, local, hubs, batch })}`);
}

async function broadcastDraftBatch(
  page: Page,
  entity?: LocalEntityRef,
  timeoutMs = ROUTE_TIMEOUT_MS,
): Promise<void> {
  const localEntity = entity ?? await getLocalEntity(page);
  const initial = await readMoveBatchSnapshot(page, localEntity.entityId, localEntity.signerId);
  console.log(`[E2E-BATCH] waiting ${JSON.stringify({
    pendingOpCount: initial.pendingOpCount, sentOpCount: initial.sentOpCount,
    pendingSettlements: initial.pendingSettlements, sentSettlements: initial.sentSettlements,
    entityNonce: initial.entityNonce,
  })}`);
  const waitStarted = Date.now();
  const initialSurface = await readMoveVisibleDiagnostic(page);
  let capturedPending = false;
  await expect
    .poll(async () => {
      const snapshot = await readMoveBatchSnapshot(page, localEntity.entityId, localEntity.signerId);
      if (snapshot.pendingOpCount === 0 && !capturedPending && Date.now() - waitStarted >= 10_000) {
        capturedPending = true;
        await captureMoveSettlementDiagnostic(page, localEntity, initialSurface);
      }
      return snapshot.pendingOpCount;
    }, { timeout: timeoutMs })
    .toBeGreaterThan(0);
  await expect(page.getByTestId('workspace-pending-banner').first()).toBeVisible({ timeout: 20_000 });
  const broadcast = page.getByTestId('settle-sign-broadcast').first();
  await expect(broadcast).toBeVisible({ timeout: 20_000 });
  await expect(broadcast).toBeEnabled({ timeout: 20_000 });
  const before = await readMoveBatchSnapshot(page, localEntity.entityId, localEntity.signerId);
  const expectedNonce = before.entityNonce + 1;
  const depository = await getDepositoryAddress(page);
  const fromBlock = await rpcCall<string>(page, 'eth_blockNumber', []);
  await broadcast.click();
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = before;

  while (Date.now() < deadline) {
    lastSnapshot = await readMoveBatchSnapshot(page, localEntity.entityId, localEntity.signerId);
    const confirmed = await readConfirmedMoveBatch(page, depository, localEntity.entityId, expectedNonce, fromBlock);
    // Receipt proves the exact successful nonce; the replica must also ingest
    // its acknowledgement and clear the live sent batch before we continue.
    if (confirmed && !lastSnapshot.sentExists && lastSnapshot.entityNonce >= expectedNonce) {
      expect(lastSnapshot.sentExists).toBe(false);
      expect(lastSnapshot.entityNonce).toBeGreaterThanOrEqual(expectedNonce);
      console.log(`[E2E-BATCH] confirmed nonce=${expectedNonce} tx=${confirmed.transactionHash}`);
      return;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Batch broadcast did not finalize within ${timeoutMs}ms: expectedNonce=${expectedNonce} snapshot=${JSON.stringify(lastSnapshot)}`,
  );
}

async function chooseMoveRoute(
  page: Page,
  from: 'external' | 'reserve' | 'account',
  to: 'external' | 'reserve' | 'account',
  order: 'source-first' | 'target-first' = 'source-first',
): Promise<void> {
  const source = page.getByTestId(`move-source-${from}`).first();
  const target = page.getByTestId(`move-target-${to}`).first();
  if (order === 'target-first') {
    await target.click();
    await source.click();
    return;
  }
  await source.click();
  await target.click();
}

async function selectMoveEntityField(page: Page, testId: string, optionText: string): Promise<void> {
  const field = page.getByTestId(testId).first();
  await expect(field).toBeVisible({ timeout: 20_000 });
  const picker = field.locator('[data-testid$="-picker"], .entity-input').first();
  const trigger = picker.locator('.closed-trigger, input').first();
  await trigger.click();
  const exactHex = /^0x[0-9a-fA-F]{64}$/.test(optionText);
  const candidateTexts = exactHex
    ? [optionText, `${optionText.slice(0, 10)}...${optionText.slice(-6)}`]
    : [optionText];
  for (const candidateText of candidateTexts) {
    const option = picker.getByTestId(/-option-/).filter({ hasText: candidateText }).first();
    if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {
      await option.dispatchEvent('mousedown');
      return;
    }
  }
  const option = picker.getByTestId(/-option-/).filter({ hasText: optionText }).first();
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.dispatchEvent('mousedown');
}

async function waitForRecipientCounterpartyProfile(
  page: Page,
  recipientEntityId: string,
  counterpartyEntityId: string,
): Promise<void> {
  // Recipient discovery is on demand; request its canonical profile before
  // waiting for the advertised counterparty edge used by the Move route.
  await waitForReceiveReadyGossipProfiles(
    page, [recipientEntityId], counterpartyEntityId, ROUTE_TIMEOUT_MS,
  );
}

async function getApiTokens(page: Page): Promise<ApiTokenEntry[]> {
  const tokensResponse = await page.request.get(`${API_BASE_URL}/api/tokens`);
  expect(tokensResponse.ok()).toBe(true);
  const body = await tokensResponse.json().catch(() => ({}));
  return Array.isArray(body?.tokens) ? body.tokens as ApiTokenEntry[] : [];
}

async function getApiToken(page: Page, symbol: string): Promise<Required<Pick<ApiTokenEntry, 'address' | 'symbol' | 'decimals' | 'tokenId'>>> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  expect(typeof token?.tokenId === 'number', `Missing ${symbol} tokenId`).toBe(true);
  return {
    address: String(token!.address),
    symbol: String(token!.symbol || symbol).toUpperCase(),
    decimals: typeof token!.decimals === 'number' ? token!.decimals : 18,
    tokenId: Number(token!.tokenId),
  };
}

async function getDepositoryAddress(page: Page): Promise<string> {
  const response = await page.request.get(`${API_BASE_URL}/api/jurisdictions?ts=${Date.now()}`);
  expect(response.ok()).toBe(true);
  const body = await response.json().catch(() => ({} as Record<string, unknown>));
  const root = (body?.jurisdictions && typeof body.jurisdictions === 'object')
    ? body.jurisdictions as Record<string, unknown>
    : body;
  const jurisdictions = Object.values(root || {}) as Array<Record<string, unknown>>;
  const depository = jurisdictions
    .map((entry) => String((entry?.contracts as Record<string, unknown> | undefined)?.depository || entry?.depository || '').trim())
    .find((value) => /^0x[a-fA-F0-9]{40}$/.test(value));
  expect(depository, 'Missing depository address in jurisdictions response').toBeTruthy();
  return depository!;
}

async function rpcCall<T>(page: Page, method: string, params: unknown[]): Promise<T> {
  const response = await page.request.post(`${API_BASE_URL}/rpc`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json().catch(() => ({}));
  if (body?.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  return body?.result as T;
}

async function getRpcExternalBalanceRaw(page: Page, symbol: string, holder: string): Promise<bigint> {
  const token = await getApiToken(page, symbol);
  const raw = await rpcCall<string>(page, 'eth_call', [
    {
      to: token.address,
      data: ERC20_BALANCE_OF.encodeFunctionData('balanceOf', [holder]),
    },
    'latest',
  ]);
  return BigInt(raw || '0x0');
}

async function getRpcAllowanceRaw(page: Page, symbol: string, owner: string, spender: string): Promise<bigint> {
  const token = await getApiToken(page, symbol);
  const raw = await rpcCall<string>(page, 'eth_call', [
    {
      to: token.address,
      data: ERC20_ALLOWANCE.encodeFunctionData('allowance', [owner, spender]),
    },
    'latest',
  ]);
  return BigInt(raw || '0x0');
}


async function seedExternalWallet(page: Page, recipient: string, symbol: string, amount: string): Promise<void> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  const decimals = typeof token?.decimals === 'number' ? token.decimals : 18;
  const beforeRaw = await getRpcExternalBalanceRaw(page, symbol, recipient);
  const faucetResponse = await page.request.post(`${API_BASE_URL}/api/faucet/erc20`, {
    data: { userAddress: recipient, tokenSymbol: symbol, amount },
  });
  const body = await faucetResponse.json().catch(() => ({}));
  expect(faucetResponse.ok(), `ERC20 faucet failed: ${JSON.stringify(body)}`).toBe(true);
  expect(body?.success, `ERC20 faucet failed: ${JSON.stringify(body)}`).toBe(true);
  const expectedRaw = beforeRaw + parseUnits(amount, decimals);
  await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, recipient), {
    timeout: ROUTE_TIMEOUT_MS,
  })
    .toBeGreaterThanOrEqual(expectedRaw);
}

async function refreshExternalBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedExternalBalance(page, symbol);
}

async function refreshReserveBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedReserveBalance(page, symbol);
}

async function refreshAccountSpendableBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedAccountSpendableBalance(page, symbol);
}


async function getRpcExternalBalance(page: Page, symbol: string, holder: string): Promise<number> {
  const token = await getApiToken(page, symbol);
  return Number(formatUnits(await getRpcExternalBalanceRaw(page, symbol, holder), token.decimals));
}

async function readOnchainReserveBalanceRaw(page: Page, entityId: string, symbol: string): Promise<bigint> {
  const token = await getApiToken(page, symbol);
  const depository = await getDepositoryAddress(page);
  const raw = await rpcCall<string>(page, 'eth_call', [
    {
      to: depository,
      data: DEPOSITORY_RESERVES.encodeFunctionData('_reserves', [entityId, token.tokenId]),
    },
    'latest',
  ]);
  const [reserve] = DEPOSITORY_RESERVES.decodeFunctionResult('_reserves', raw);
  return BigInt(reserve);
}

type DeltaSnapshot = {
  ondelta: string;
  offdelta: string;
  collateral: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
};

async function readAccountOutCapacityRaw(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
): Promise<bigint> {
  const delta = await page.evaluate(({ counterpartyId, entityId, tokenId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, {
              deltas?: Map<number | string, unknown>;
            }>;
          };
        }>;
      };
    }).isolatedEnv;
    if (!env?.state?.eReplicas) return null;
    for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
      if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
      const account = replica.state?.accounts?.get(counterpartyId);
      const delta = account?.state?.deltas?.get(tokenId);
      if (!delta || typeof delta !== 'object') return null;
      const raw = delta as Record<string, unknown>;
      const readBig = (value: unknown): string => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
        return '0';
      };
      return {
        ondelta: readBig(raw.ondelta),
        offdelta: readBig(raw.offdelta),
        collateral: readBig(raw.collateral),
        leftCreditLimit: readBig(raw.leftCreditLimit),
        rightCreditLimit: readBig(raw.rightCreditLimit),
        leftAllowance: readBig(raw.leftAllowance),
        rightAllowance: readBig(raw.rightAllowance),
        leftHold: readBig(raw.leftHold),
        rightHold: readBig(raw.rightHold),
      } satisfies DeltaSnapshot;
    }
    return null;
  }, { counterpartyId, entityId, tokenId });

  if (!delta) return 0n;
  return deriveDelta({
    tokenId,
    ondelta: BigInt(delta.ondelta),
    offdelta: BigInt(delta.offdelta),
    collateral: BigInt(delta.collateral),
    leftCreditLimit: BigInt(delta.leftCreditLimit),
    rightCreditLimit: BigInt(delta.rightCreditLimit),
    leftAllowance: BigInt(delta.leftAllowance),
    rightAllowance: BigInt(delta.rightAllowance),
    leftHold: BigInt(delta.leftHold),
    rightHold: BigInt(delta.rightHold),
  }, String(entityId).toLowerCase() < String(counterpartyId).toLowerCase()).outCapacity;
}

async function waitForExactBigInt(
  probe: () => Promise<bigint>,
  expected: bigint,
  timeoutMs = ROUTE_TIMEOUT_MS,
): Promise<void> {
  await expect.poll(probe, { timeout: timeoutMs }).toBe(expected);
}

function expectExactDelta(
  label: string,
  beforeSender: bigint | null,
  afterSender: bigint | null,
  beforeRecipient: bigint | null,
  afterRecipient: bigint | null,
  amount: bigint,
): void {
  if (beforeSender !== null && afterSender !== null) {
    expect(afterSender, `${label}: sender exact delta`).toBe(beforeSender - amount);
  }
  if (beforeRecipient !== null && afterRecipient !== null) {
    expect(afterRecipient, `${label}: recipient exact delta`).toBe(beforeRecipient + amount);
  }
}

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

test('move tab covers all routed paths on isolated runtimes', { tag: '@functional' }, async ({ page, browser }, testInfo) => {
  test.setTimeout(LONG_E2E ? 420_000 : 300_000);

  await timedStep('move.baseline', async () => {
    await ensureE2EBaseline(page, {
      timeoutMs: LONG_E2E ? 240_000 : 180_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
    });
  });

  const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobPage = await bobContext.newPage();
  try {
    let alice: { entityId: string; signerId: string; runtimeId: string } | null = null;
    let bob: { entityId: string; signerId: string; runtimeId: string } | null = null;
    await timedStep('move.runtimes', async () => {
      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      await page.evaluate((apiBaseUrl: string) => {
        (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
        localStorage.setItem('xln-api-base-url', apiBaseUrl);
      }, API_BASE_URL);
      alice = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
      await switchToRuntimeId(page, alice.runtimeId);

      await gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      await bobPage.evaluate((apiBaseUrl: string) => {
        (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
        localStorage.setItem('xln-api-base-url', apiBaseUrl);
      }, API_BASE_URL);
      bob = await createRuntimeIdentity(bobPage, 'bob', selectDemoMnemonic('bob'));
      await switchToRuntimeId(bobPage, bob.runtimeId);
    });

    const hubs = await waitForNamedHubs(page, ['H1', 'H2'], { timeoutMs: ROUTE_TIMEOUT_MS });
    await timedStep('move.open-accounts', async () => {
      await connectRuntimeToHub(page, { entityId: alice!.entityId, signerId: alice!.signerId }, hubs.h1);
      await connectRuntimeToHub(bobPage, { entityId: bob!.entityId, signerId: bob!.signerId }, hubs.h2);
    });

    const symbol = 'USDC';
    const token = await getApiToken(page, symbol);
    const depository = await getDepositoryAddress(page);
    const amountRaw = (amount: string): bigint => parseUnits(amount, token.decimals);
    const aliceEoa = String(alice!.signerId || '').trim();
    const bobEoa = String(bob!.signerId || '').trim();
    expect(aliceEoa).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(bobEoa).toMatch(/^0x[a-fA-F0-9]{40}$/);

    await timedStep('move.seed-wallet', async () => {
      await seedExternalWallet(page, aliceEoa, symbol, '120');
      await expect
        .poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(0);
    });

    await timedStep('move.wait-bob-profile-on-alice', async () => {
      await waitForRecipientCounterpartyProfile(page, bob!.entityId, hubs.h2);
    });

    await timedStep('move.asset-selector', async () => {
      await openMoveTab(page);
      await expectMoveAssetSelector(page);
    });

    await timedStep('move.seed-reserve', async () => {
      const beforeReserve = await refreshReserveBalance(page, symbol);
      await clickReserveFaucet(page, symbol);
      await expect.poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeReserve);
    });

    await timedStep('move.seed-account', async () => {
      const beforeAccount = await refreshAccountSpendableBalance(page, symbol);
      await clickAccountFaucet(page, symbol);
      await expect
        .poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(beforeAccount);
    });

    await timedStep('move.e2r', async () => {
      const amount = amountRaw('20');
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      expect(beforeExternalRaw, 'move.e2r external wallet must hold enough ERC20 before approve/batch').toBeGreaterThanOrEqual(
        amount,
      );
      for (const requiredSymbol of ['USDC', 'USDT', 'WETH'] as const) {
        const beforeAllowance = await getRpcAllowanceRaw(page, requiredSymbol, aliceEoa, depository);
        expect(beforeAllowance, `${requiredSymbol} allowance should start at zero in fresh wallet`).toBe(0n);
      }
      await timedMillis('move.e2r', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'reserve');
        await page.getByTestId('move-amount').fill('20');
        await waitForMoveAllowanceRequired(page);
        await expect(page.getByTestId('move-route-summary')).toContainText('External → Reserve');
        await expect(page.getByTestId('move-amount')).toHaveValue('20');
        await expect(page.getByTestId('move-asset-symbol')).toHaveValue(symbol);
        await expect(page.getByTestId('move-allow-amount').first()).toHaveValue('20');
        await approveMoveAllowance(page, 'max');
        await waitForExactBigInt(
          async () => await getRpcAllowanceRaw(page, symbol, aliceEoa, depository),
          MaxUint256,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await expect(page.getByTestId('move-allow-panel')).toHaveCount(0);
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Add to Batch/i);
        await capturePageScreenshot(page, testInfo, 'move-batch-route-summary-desktop.png', {
          fullPage: false,
          ux: {
            title: 'desktop on-chain batch route',
            group: 'On-chain Batch',
            description: 'External to reserve route summary before adding a move to batch.',
            platform: 'desktop',
            tags: ['move', 'batch', 'external-reserve'],
          },
        });
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await capturePageScreenshot(page, testInfo, 'move-batch-queued-desktop.png', {
          fullPage: false,
          ux: {
            title: 'desktop on-chain batch queued',
            group: 'On-chain Batch',
            description: 'Move operation queued into a J-batch before broadcast.',
            platform: 'desktop',
            tags: ['move', 'batch', 'j-batch'],
          },
        });
        await broadcastDraftBatch(page, asLocalEntityRef(alice!), EXTERNAL_BATCH_TIMEOUT_MS);
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw + amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw - amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await waitForExactBigInt(
          async () => await getRpcAllowanceRaw(page, symbol, aliceEoa, depository),
          MaxUint256,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await openAccountBatchHistory(page);
        await capturePageScreenshot(page, testInfo, 'move-batch-history-desktop.png', {
          fullPage: false,
          ux: {
            title: 'desktop on-chain batch history',
            group: 'History',
            description: 'Confirmed on-chain batch history after broadcasting an external reserve move.',
            platform: 'desktop',
            tags: ['history', 'batch', 'confirmed'],
          },
        });
      });
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      expectExactDelta('move.e2r', beforeExternalRaw, afterExternalRaw, beforeReserveRaw, afterReserveRaw, amount);
    });

    await timedStep('move.r2a-self', async () => {
      const amount = amountRaw('8');
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      await timedMillis('move.r2a-self', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'account');
        await page.getByTestId('move-amount').fill('8');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw - amount,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAccountRaw + amount,
        );
      });
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      expectExactDelta('move.r2a-self', beforeReserveRaw, afterReserveRaw, beforeAccountRaw, afterAccountRaw, amount);
    });

    await timedStep('move.a2r-self', async () => {
      const amount = amountRaw('3');
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      await timedMillis('move.a2r-self', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'reserve');
        await page.getByTestId('move-amount').fill('3');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw + amount,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAccountRaw - amount,
        );
      });
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      expectExactDelta('move.a2r-self', beforeAccountRaw, afterAccountRaw, beforeReserveRaw, afterReserveRaw, amount);
    });

    await timedStep('move.r2e', async () => {
      const amount = amountRaw('2');
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.r2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'external');
        await page.getByTestId('move-amount').fill('2');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-route-summary')).toContainText('Reserve → External');
        await expect(page.getByTestId('move-amount')).toHaveValue('2');
        await expect(page.getByTestId('move-asset-symbol')).toHaveValue(symbol);
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Add to Batch/i);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw + amount,
        );
      });
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      expectExactDelta('move.r2e', beforeReserveRaw, afterReserveRaw, beforeExternalRaw, afterExternalRaw, amount);
    });

    await timedStep('move.r2r-remote', async () => {
      const amount = amountRaw('4');
      const beforeAliceReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeBobReserveRaw = await readOnchainReserveBalanceRaw(bobPage, bob!.entityId, symbol);
      await timedMillis('move.r2r-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'reserve');
        await page.getByTestId('move-amount').fill('4');
        await selectMoveEntityField(page, 'move-reserve-recipient-field', bob!.entityId);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeAliceReserveRaw - amount,
        );
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(bobPage, bob!.entityId, symbol),
          beforeBobReserveRaw + amount,
        );
      });
      const afterAliceReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterBobReserveRaw = await readOnchainReserveBalanceRaw(bobPage, bob!.entityId, symbol);
      expectExactDelta('move.r2r-remote', beforeAliceReserveRaw, afterAliceReserveRaw, beforeBobReserveRaw, afterBobReserveRaw, amount);
    });

    await timedStep('move.e2a-remote', async () => {
      const amount = amountRaw('5');
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const beforeBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      await timedMillis('move.e2a-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'account');
        await page.getByTestId('move-amount').fill('5');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForExactBigInt(
          async () => await getRpcAllowanceRaw(page, symbol, aliceEoa, depository),
          MaxUint256,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await expect(page.getByTestId('move-allow-panel')).toHaveCount(0);
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Add to Batch/i);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw - amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId),
          beforeBobAccountRaw + amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
      });
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      expectExactDelta('move.e2a-remote', beforeExternalRaw, afterExternalRaw, beforeBobAccountRaw, afterBobAccountRaw, amount);
    });

    await timedStep('move.a2e', async () => {
      const amount = amountRaw('1');
      const beforeAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.a2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'external');
        await page.getByTestId('move-amount').fill('1');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAccountRaw - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw + amount,
        );
      });
      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      expectExactDelta('move.a2e', beforeAccountRaw, afterAccountRaw, beforeExternalRaw, afterExternalRaw, amount);
    });

    await timedStep('move.a2a-remote', async () => {
      const amount = amountRaw('2');
      const beforeAliceAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const beforeBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      await timedMillis('move.a2a-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'account');
        await page.getByTestId('move-amount').fill('2');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAliceAccountRaw - amount,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId),
          beforeBobAccountRaw + amount,
        );
      });
      const afterAliceAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const afterBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      expectExactDelta('move.a2a-remote', beforeAliceAccountRaw, afterAliceAccountRaw, beforeBobAccountRaw, afterBobAccountRaw, amount);
    });

    await timedStep('move.e2e', async () => {
      const amount = amountRaw('7');
      const beforeAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const beforeBobExternalRaw = await getRpcExternalBalanceRaw(page, symbol, bobEoa);
      await timedMillis('move.e2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'external');
        await page.getByTestId('move-amount').fill('7');
        await page.getByTestId('move-external-recipient').fill(bobEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeAliceExternalRaw - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, bobEoa),
          beforeBobExternalRaw + amount,
        );
      });
      const afterAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterBobExternalRaw = await getRpcExternalBalanceRaw(page, symbol, bobEoa);
      expectExactDelta('move.e2e', beforeAliceExternalRaw, afterAliceExternalRaw, beforeBobExternalRaw, afterBobExternalRaw, amount);
    });

    await timedStep('move.roundtrip-r2e-e2a', async () => {
      const amount = amountRaw('1.25');
      const reserveBefore = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const externalBefore = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const bobAccountBefore = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);

      await timedMillis('move.roundtrip.r2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'external', 'target-first');
        await page.getByTestId('move-amount').fill('1.25');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          reserveBefore - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          externalBefore + amount,
        );
      });

      const externalMid = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.roundtrip.e2a', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'account', 'target-first');
        await page.getByTestId('move-amount').fill('1.25');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          externalMid - amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId),
          bobAccountBefore + amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
      });

      const afterAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      expect(afterAliceExternalRaw, 'move.roundtrip-r2e-e2a external net zero').toBe(externalBefore);
      expect(afterBobAccountRaw, 'move.roundtrip-r2e-e2a bob account exact').toBe(bobAccountBefore + amount);
    });

    await timedStep('move.roundtrip-a2r-r2e', async () => {
      const amount = amountRaw('0.5');
      const accountBefore = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const reserveBefore = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const externalBefore = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);

      await timedMillis('move.roundtrip.a2r', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'reserve', 'target-first');
        await page.getByTestId('move-amount').fill('0.5');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          accountBefore - amount,
        );
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          reserveBefore + amount,
        );
      });

      const reserveMid = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      await timedMillis('move.roundtrip.r2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'external', 'target-first');
        await page.getByTestId('move-amount').fill('0.5');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForMoveActionToSettle(page);
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          reserveMid - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          externalBefore + amount,
        );
      });

      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      expect(afterAccountRaw, 'move.roundtrip-a2r-r2e account exact').toBe(accountBefore - amount);
      expect(afterReserveRaw, 'move.roundtrip-a2r-r2e reserve net zero').toBe(reserveBefore);
      expect(afterExternalRaw, 'move.roundtrip-a2r-r2e external exact').toBe(externalBefore + amount);
    });
  } finally {
    await bobContext.close();
  }
});
