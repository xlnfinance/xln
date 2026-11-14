import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import type { JsonRpcProvider } from 'ethers';
import type { E2EHealthResponse } from '../../tests/utils/e2e-baseline';
import { WAIT } from './dispute-wallet';

// Owner outage drills stop the exact Hub, the API that serves the wallet's
// published `/rpc` gateway, and the watchtower. Only the settlement chain
// stays up, and its clock is never moved.

export type OutageTarget = { role: string; pid: number; ports: number[] };

const listeners = (pid: number): number[] => {
  try {
    const out = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      encoding: 'utf8',
    });
    return [...out.matchAll(/^n.*:(\d+)$/gm)].map(match => Number(match[1]));
  } catch {
    return [];
  }
};
const listenerPid = (port: number): number => {
  const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
  const pids = [...new Set(out.split('\n').filter(Boolean).map(Number))];
  if (pids.length !== 1) throw new Error(`OUTAGE_LISTENER_AMBIGUOUS:${port}:${pids.join(',')}`);
  return pids[0]!;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const stop = async (pid: number): Promise<string> => {
  // A supervised child may already have exited with its stopped parent.
  if (!alive(pid)) return 'exited-with-parent';
  process.kill(pid, 'SIGTERM');
  const until = performance.now() + 5_000;
  while (alive(pid) && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  if (!alive(pid)) return 'SIGTERM';
  process.kill(pid, 'SIGKILL');
  await expect.poll(() => alive(pid), WAIT).toBe(false);
  return 'SIGKILL';
};
export const probe = async (url: string, init?: RequestInit): Promise<string> => {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(3_000) });
    return `HTTP ${response.status}`;
  } catch (error) {
    return `unreachable: ${error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error)}`;
  }
};
export const rpcBody = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}',
};
export const since = (start: number): number => Math.round(performance.now() - start);

const health = async (page: Page): Promise<E2EHealthResponse> => {
  const response = await page.request.get('/api/health?full=1');
  expect(response.ok()).toBe(true);
  return response.json();
};

/** Identify the exact processes behind the wallet's Hub, API/RPC gateway and tower. */
export const outageTargets = async (
  page: Page,
  hubId: string,
  apiOrigin: string,
  towerOrigin: string,
): Promise<OutageTarget[]> => {
  const before = await health(page);
  const hubRow = before.hubs?.find(row => row.entityId?.toLowerCase() === hubId);
  const hubChild = before.process?.children?.find(row => row.role === 'hub' && row.name === hubRow?.name);
  if (!hubRow?.name || !hubChild?.online || !hubChild.pid) throw new Error(`OUTAGE_HUB_PROCESS_UNKNOWN:${hubId}`);
  return [
    { role: 'api+rpc-gateway', pid: listenerPid(Number(new URL(apiOrigin).port)) },
    { role: `hub:${hubRow.name}`, pid: hubChild.pid },
    { role: 'watchtower', pid: listenerPid(Number(new URL(towerOrigin).port)) },
  ].map(target => ({ ...target, ports: listeners(target.pid) }));
};

/** Prove every target port refuses and the settlement chain still answers. */
export const proveDown = async (
  targets: readonly OutageTarget[],
  apiOrigin: string,
  towerOrigin: string,
  provider: JsonRpcProvider,
) => {
  const down = {
    alive: targets.map(target => alive(target.pid)),
    ports: await Promise.all(
      targets.flatMap(target =>
        target.ports.map(async port => ({ port, result: await probe(`http://127.0.0.1:${port}/`) })),
      ),
    ),
    apiHealth: await probe(`${apiOrigin}/api/health`),
    towerHealth: await probe(`${towerOrigin}/api/tower/healthz`),
    independentChainBlock: await provider.getBlockNumber(),
  };
  expect(down.alive.every(value => !value)).toBe(true);
  expect(down.ports.every(row => row.result.startsWith('unreachable'))).toBe(true);
  expect(down.apiHealth.startsWith('unreachable')).toBe(true);
  expect(down.towerHealth.startsWith('unreachable')).toBe(true);
  return down;
};

/** Stop the API first so its supervisor cannot restart the Hub. */
export const stopTargets = async (targets: readonly OutageTarget[]) => {
  const signals = [];
  for (const target of targets) signals.push({ ...target, signal: await stop(target.pid) });
  return signals;
};

/** Balances stay hidden while the chain is unreadable; the alert offers the owner a replacement RPC. */
export const replaceRpcFromAlert = async (page: Page, network: string, rpc: string): Promise<string> => {
  const blocked = page.getByTestId('asset-snapshot-status');
  await expect(blocked).toHaveAttribute('role', 'alert', { timeout: 60_000 });
  const alert = await blocked.innerText();
  await blocked.getByTestId(`network-rpc-input-${network}`).fill(rpc);
  await blocked.getByTestId(`network-rpc-replace-${network}`).click();
  await expect(page.getByTestId('asset-snapshot-status')).toHaveCount(0, { timeout: 60_000 });
  return alert;
};

/** Repair every imported chain before the global authenticated catch-up fence can open. */
export const replaceRpcFromSettings = async (page: Page, network: string, rpc: string): Promise<void> => {
  await page.getByTestId('nav-settings').locator('visible=true').first().click();
  const networks = page.getByTestId('settings-networks');
  await networks.locator('summary').first().click();
  const row = networks.getByTestId(`network-row-${network}`);
  await row.locator('summary').first().click();
  await row.getByTestId(`network-rpc-input-${network}`).fill(rpc);
  await row.getByTestId(`network-rpc-replace-${network}`).click();
  await expect(row.getByTestId(`network-rpc-notice-${network}`)).toContainText('RPC verified', WAIT);
  await expect(page.getByTestId('runtime-command-gate')).toHaveCount(0, WAIT);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('nav-settings').locator('visible=true').first().click();
  await page.getByTestId('settings-networks').locator('summary').first().click();
  await expect(page.getByTestId(`network-rpc-active-${network}`)).toHaveText(new URL(rpc).href, WAIT);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
};

export const walletNetworks = (page: Page) =>
  page.evaluate(() => {
    const env = (
      window as unknown as {
        __xln?: {
          env: () => {
            state: { jReplicas: Map<string, { rpcs?: string[]; watcherReceiptCommitment?: string }> };
          } | null;
        };
      }
    ).__xln?.env();
    return env
      ? [...env.state.jReplicas.entries()].map(([name, replica]) => ({
          name,
          rpcs: replica.rpcs,
          commitment: replica.watcherReceiptCommitment ?? null,
        }))
      : null;
  });

/** User-visible dispute start from the owning React wallet. */
export const startDisputeFromWallet = async (
  page: Page,
  hubId: string,
  manageDispute: (page: Page) => Promise<void>,
) => {
  await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click(WAIT);
  await manageDispute(page);
  const clickAt = performance.now();
  await page.getByTestId('dispute-prepare').click();
  await page.getByTestId('dispute-prepare-confirm').click();
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('pending-batch')).toContainText('Dispute start', WAIT);
  await page.getByTestId('batch-broadcast').click();
  return clickAt;
};
