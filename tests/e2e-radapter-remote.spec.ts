import { expect, test } from '@playwright/test';
import { createHmac } from 'crypto';
import {
  APP_BASE_URL,
  API_BASE_URL,
  ensureE2EBaseline,
  waitForNamedHubs,
} from './utils/e2e-baseline';

const capabilityToken = (seed: string, role: 'read' | 'full', expiresAtMs: number, rawAudience: string): string => {
  const level = role === 'read' ? 'inspect' : 'admin';
  const audience = String(rawAudience || 'xln-runtime').toLowerCase();
  const keyId = 'e2e';
  const tokenId = `e2e-${expiresAtMs}`;
  const signature = createHmac('sha256', seed)
    .update(`xln-radapter-v1:cap:${level}:${expiresAtMs}:${audience}:${keyId}:${tokenId}`)
    .digest('hex');
  return [
    'xlnra1',
    role,
    String(expiresAtMs),
    Buffer.from(audience, 'utf8').toString('base64url'),
    Buffer.from(keyId, 'utf8').toString('base64url'),
    Buffer.from(tokenId, 'utf8').toString('base64url'),
    signature,
  ].join('.');
};

const hubRpcUrl = (hubOffset: number): string => {
  const api = new URL(API_BASE_URL);
  const port = Number(api.port);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`E2E_API_BASE_URL must include a port: ${API_BASE_URL}`);
  return `ws://localhost:${port + hubOffset}/rpc`;
};

test('remote /app opens an existing hub runtime through radapter', async ({ page }) => {
  await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1 || '').toLowerCase();
  expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

  const wsUrl = hubRpcUrl(10);
  const hubInfoResponse = await page.request.get(`http://127.0.0.1:${Number(new URL(API_BASE_URL).port) + 10}/api/info`);
  expect(hubInfoResponse.ok()).toBe(true);
  const hubInfo = await hubInfoResponse.json().catch(() => ({}));
  const audience = String(hubInfo.runtimeId || '').toLowerCase();
  expect(audience.length).toBeGreaterThan(0);
  const key = capabilityToken('xln-e2e-h1', 'full', Date.now() + 60 * 60 * 1_000, audience);
  const url = `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(key)}#accounts`;

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const remotePrompt = page.getByTestId('remote-runtime-login-screen');
  await expect(remotePrompt).not.toBeVisible({ timeout: 10_000 });

  await page.waitForFunction(
    ({ hubId, expectedRuntimePrefix }) => {
      const view = window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, {
            entityId?: string;
            state?: {
              profile?: { isHub?: boolean; name?: string };
              accounts?: Map<string, unknown>;
            };
          }>;
        };
      };
      const env = view.isolatedEnv;
      if (!env || !String(env.runtimeId || '').startsWith(expectedRuntimePrefix)) return false;
      const replicas = Array.from(env.eReplicas?.values?.() ?? []);
      return replicas.some((replica) =>
        String(replica.entityId || '').toLowerCase() === hubId &&
        replica.state?.profile?.isHub === true,
      );
    },
    { hubId: h1, expectedRuntimePrefix: `radapter:${wsUrl}` },
    { timeout: 60_000 },
  );

  const snapshot = await page.evaluate((hubId) => {
    const view = window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        height?: number;
        eReplicas?: Map<string, {
          entityId?: string;
          state?: {
            profile?: { isHub?: boolean; name?: string };
            accounts?: Map<string, unknown>;
          };
        }>;
      };
    };
    const env = view.isolatedEnv;
    const replicas = Array.from(env?.eReplicas?.values?.() ?? []);
    const hub =
      replicas.find((replica) =>
        String(replica.entityId || '').toLowerCase() === hubId &&
        replica.state?.profile?.isHub === true,
      ) ??
      replicas.find((replica) => String(replica.entityId || '').toLowerCase() === hubId);
    return {
      runtimeId: String(env?.runtimeId || ''),
      height: Number(env?.height || 0),
      replicaCount: replicas.length,
      hubName: String(hub?.state?.profile?.name || ''),
      hubIsHub: hub?.state?.profile?.isHub === true,
      accountCount: Number(hub?.state?.accounts?.size || 0),
      loginText: document.body.textContent || '',
    };
  }, h1);

  expect(snapshot.runtimeId).toBe(`radapter:${wsUrl}`);
  expect(snapshot.height).toBeGreaterThan(0);
  expect(snapshot.replicaCount).toBeGreaterThan(0);
  expect(snapshot.hubIsHub).toBe(true);
  expect(snapshot.hubName.toLowerCase()).toContain('h1');
  expect(snapshot.accountCount).toBeLessThanOrEqual(10);
  expect(/quick login/i.test(snapshot.loginText)).toBe(false);
  await expect(page.getByTestId('context-current')).not.toContainText(/no runtime selected/i);
  await expect(page.getByRole('button', { name: /^H1$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^H2$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^H3$/ })).toBeVisible();
});
