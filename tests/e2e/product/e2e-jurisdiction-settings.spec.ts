import { test, expect, type Page } from '../../global-setup.mts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeReplica } from '../../../core/api/public/runtime-module';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../core/protocol/boundary-validation';
import { createWalletIdentity, readWalletIdentity } from '../../../ui/tests/wallet-ui';

import { gotoApp as gotoSharedApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;
const EXTRA_JURISDICTION_CHAIN_ID = 31_338;
const EXTRA_JURISDICTION_DEV_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

async function gotoApp(page: Page): Promise<void> {
  await gotoSharedApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
}

async function startExtraJurisdiction(
  name: string,
  port: number,
): Promise<{
  proc: ChildProcessWithoutNullStreams;
  configJson: string;
}> {
  const repoRoot = process.cwd();
  // A watcher identity is chainId + Depository. Use the second local chain and
  // a different funded Anvil deployer so this stack has a distinct Depository
  // instead of reproducing the primary stack's intentionally ambiguous pair.
  const proc = spawn(
    'bun',
    [
      'core/scripts/operations/development/dev-anvil-stack.ts',
      '--spawn-anvil',
      '--keep-alive',
      '--json-only',
      '--name',
      name,
      '--port',
      String(port),
      '--chain-id',
      String(EXTRA_JURISDICTION_CHAIN_ID),
      '--block-time',
      '1',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        JADAPTER_DEV_PRIVATE_KEY: EXTRA_JURISDICTION_DEV_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  const configJson = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for extra jurisdiction config.\nSTDERR:\n${stderr}`));
    }, 60_000);

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const lines = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.name === 'string' && Array.isArray(parsed.rpcs)) {
            clearTimeout(timeout);
            resolve(JSON.stringify(parsed, null, 2));
            return;
          }
        } catch {
          // keep reading
        }
      }
    });

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    proc.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Extra jurisdiction helper exited early with code ${code}.\nSTDERR:\n${stderr}`));
    });
  });

  return { proc, configJson };
}

test(
  'settings can add custom jurisdiction from canonical JSON and import it into active runtime',
  { tag: '@functional' },
  async ({ page }) => {
    const port = 18600 + (process.pid % 500);
    const helperName = `settings-test-${Date.now()}`;
    const extra = await startExtraJurisdiction(helperName, port);

    try {
      console.log('[J-SETTINGS] open app');
      await gotoApp(page);
      console.log('[J-SETTINGS] create runtime');
      const identity = await createWalletIdentity(page, 'settings', selectDemoMnemonic('alice'));

      console.log('[J-SETTINGS] open network settings');
      await page.getByTestId('nav-settings').locator('visible=true').first().click();
      const networks = page.getByTestId('settings-networks');
      await networks.locator('summary').first().click();
      await networks.getByText('Add a network', { exact: true }).click();

      // Populate the current public form from the real deployment's canonical JSON.
      // Contract addresses and the authenticated scan anchor come from that deployment.
      const config = requireBoundaryRecord(JSON.parse(extra.configJson), 'EXTRA_JURISDICTION_CONFIG_INVALID');
      const contracts = requireBoundaryRecord(config['contracts'], 'EXTRA_JURISDICTION_CONTRACTS_INVALID');
      const rpc = `http://127.0.0.1:${port}`;
      expect(config['chainId']).toBe(EXTRA_JURISDICTION_CHAIN_ID);
      expect(config['rpcs']).toEqual([rpc]);
      expect(config['name']).toBe(helperName);
      const deploymentBlock = requireBoundaryInteger(
        config['entityProviderDeploymentBlock'],
        'EXTRA_JURISDICTION_ANCHOR_MISSING',
        1,
      );
      const fields = {
        name: helperName,
        rpc,
        chainId: String(EXTRA_JURISDICTION_CHAIN_ID),
        ticker: 'ETH',
        blockTimeMs: '1000',
        deploymentBlock: String(deploymentBlock),
      };
      for (const [key, value] of Object.entries(fields)) await page.getByTestId(`network-${key}`).fill(value);
      const normalizedContracts: Record<string, string> = {};
      for (const key of ['depository', 'entityProvider', 'account', 'deltaTransformer'] as const) {
        const address = contracts[key];
        if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) {
          throw new Error(`EXTRA_JURISDICTION_ADDRESS_INVALID:${key}`);
        }
        normalizedContracts[key] = address.toLowerCase();
        await page.getByTestId(`network-contract-${key}`).fill(address);
      }
      await page.getByTestId('network-connect').click();

      console.log('[J-SETTINGS] wait for import');
      await expect(page.getByTestId('network-notice')).toHaveText(
        `${helperName} connected. Create or select an entity on this network to use it.`,
        { timeout: 45_000 },
      );

      await expect
        .poll(
          async () => {
            return await page.evaluate(jurisdictionName => {
              const env = (window as Window & { __xln?: { env(): RuntimeReplica | null } }).__xln?.env();
              if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
              const replica = env.state.jReplicas.get(jurisdictionName);
              return {
                hasReplica: Boolean(replica),
                chainId: replica?.chainId,
                contracts: replica?.contracts,
                deploymentBlock: replica?.entityProviderDeploymentBlock,
                rpcs: replica?.rpcs,
              };
            }, helperName);
          },
          { timeout: 45_000 },
        )
        .toMatchObject({
          hasReplica: true,
          chainId: EXTRA_JURISDICTION_CHAIN_ID,
          contracts: normalizedContracts,
          deploymentBlock,
          rpcs: [new URL(rpc).href],
        });
      expect(await readWalletIdentity(page)).toEqual(identity);
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await expect(page.getByTestId('home-pay')).toBeEnabled();
    } finally {
      await page.close();
      if (extra.proc.exitCode === null) {
        extra.proc.kill('SIGTERM');
      }
    }
  },
);
