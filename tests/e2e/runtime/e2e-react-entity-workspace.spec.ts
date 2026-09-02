import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type BrowserContext, type Page, type TestInfo } from '../../global-setup.mts';
import { API_BASE_URL, ensureE2EBaseline } from '../../utils/e2e-baseline';
import {
  RUNTIME_ADAPTER_ACCESS_KEY,
  RUNTIME_ADAPTER_AUTH_KEY,
  RUNTIME_ADAPTER_MODE_KEY,
  RUNTIME_ADAPTER_WS_KEY,
} from '../../../frontend/packages/browser/src/runtime-adapter-session';
import { capturePageScreenshot } from '../../utils/e2e-screenshots';

type RuntimeImportCapability = Readonly<{
  access: 'admin';
  label: string;
  token: string;
  wsUrl: string;
}>;

type CandidateServer = Readonly<{
  baseUrl: string;
  cacheRoot: string;
  process: ChildProcess;
}>;

const VIEWPORTS = [
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'laptop-1366x900', width: 1366, height: 900 },
  { name: 'wide-1920x1080', width: 1920, height: 1080 },
] as const;

const getFreePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('REACT_ENTITY_WORKSPACE_PORT_MISSING'));
      return;
    }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

const waitForCandidate = async (
  baseUrl: string,
  process: ChildProcess,
  readOutput: () => string,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error(
        `REACT_ENTITY_WORKSPACE_VITE_EXITED:${String(process.exitCode)}:${String(process.signalCode)}:${readOutput()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/__app/ops/entity-workspace`);
      if (response.ok) return;
    } catch {
      // The process is still booting; the deadline below remains authoritative.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`REACT_ENTITY_WORKSPACE_VITE_TIMEOUT:${baseUrl}:${readOutput()}`);
};

const stopChildProcess = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once('close', onExit);
    child.kill('SIGTERM');
    timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
  });
};

const startCandidateServer = async (): Promise<CandidateServer> => {
  const port = await getFreePort();
  const cacheRoot = await mkdtemp(join(tmpdir(), 'xln-react-entity-workspace-'));
  const child = spawn('bunx', ['vite', '--config', 'apps/ops/vite.config.ts'], {
    cwd: `${process.cwd()}/frontend`,
    env: {
      ...process.env,
      XLN_REACT_PORT_OFFSET: String(port - 8085),
      XLN_REACT_VITE_CACHE_ROOT: cacheRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const appendOutput = (chunk: unknown): void => {
    output = `${output}${String(chunk)}`.slice(-4_000);
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  child.once('error', appendOutput);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForCandidate(baseUrl, child, () => output.trim());
  } catch (error) {
    await stopChildProcess(child);
    await rm(cacheRoot, { recursive: true, force: true });
    throw error;
  }
  return { baseUrl, cacheRoot, process: child };
};

const stopCandidateServer = async (server: CandidateServer | null): Promise<void> => {
  if (!server) return;
  await stopChildProcess(server.process);
  await rm(server.cacheRoot, { recursive: true, force: true });
};

const readH1Capability = async (page: Page): Promise<RuntimeImportCapability> => {
  const deadline = Date.now() + 60_000;
  let detail = 'not queried';
  while (Date.now() < deadline) {
    try {
      const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`, {
        headers: { 'Cache-Control': 'no-store' },
        timeout: 5_000,
      });
      const payload = await response.json() as {
        ready?: boolean;
        manifest?: { entries?: RuntimeImportCapability[] };
        entries?: RuntimeImportCapability[];
      };
      const entries = payload.manifest?.entries ?? payload.entries ?? [];
      const capability = entries.find(entry => entry.label.trim().toLowerCase() === 'h1');
      if (response.ok() && payload.ready !== false && capability) {
        expect(capability.access).toBe('admin');
        expect(capability.token).toMatch(/^xlnra1\./);
        expect(capability.wsUrl).toMatch(/^wss?:\/\//);
        return capability;
      }
      detail = `status=${response.status()} ready=${String(payload.ready)} entries=${entries.length}`;
    } catch (error: unknown) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`REACT_ENTITY_WORKSPACE_H1_CAPABILITY_TIMEOUT:${detail}`);
};

const installRemoteSession = async (
  context: BrowserContext,
  capability: RuntimeImportCapability,
): Promise<void> => {
  await context.addInitScript(({ keys, session }) => {
    localStorage.setItem(keys.mode, 'remote');
    localStorage.setItem(keys.ws, session.wsUrl);
    localStorage.setItem(keys.access, session.access);
    localStorage.removeItem(keys.auth);
    sessionStorage.setItem(keys.auth, session.token);
  }, {
    keys: {
      mode: RUNTIME_ADAPTER_MODE_KEY,
      ws: RUNTIME_ADAPTER_WS_KEY,
      access: RUNTIME_ADAPTER_ACCESS_KEY,
      auth: RUNTIME_ADAPTER_AUTH_KEY,
    },
    session: capability,
  });
};

const assertSelectedContext = async (page: Page, expectedRuntimeId: string): Promise<void> => {
  const shell = page.getByTestId('entity-workspace-shell');
  await expect(shell).toHaveAttribute('data-read-status', 'ready', { timeout: 30_000 });
  await expect(page.getByText('Not attached')).toHaveCount(0);
  await expect(page.getByText(expectedRuntimeId.slice(0, 8), { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
};

let candidateServer: CandidateServer | null = null;

test.beforeAll(async () => {
  candidateServer = await startCandidateServer();
});

test.afterAll(async () => {
  await stopCandidateServer(candidateServer);
});

test.setTimeout(180_000);

test('React Entity workspace reads selected context from a real H1 Runtime', { tag: '@functional' }, async ({ browser, page }, testInfo: TestInfo) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const capability = await readH1Capability(page);
  const h1 = (baseline.hubs ?? []).find(hub => String(hub.name || '').trim().toLowerCase() === 'h1');
  const expectedRuntimeId = String(h1?.runtimeId || '').trim().toLowerCase();
  expect(expectedRuntimeId).toMatch(/^0x[0-9a-f]{40}$/);
  if (!candidateServer) throw new Error('REACT_ENTITY_WORKSPACE_VITE_MISSING');

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    try {
      await installRemoteSession(context, capability);
      const candidatePage = await context.newPage();
      const response = await candidatePage.goto(
        `${candidateServer.baseUrl}/__app/ops/entity-workspace#accounts`,
        { waitUntil: 'domcontentloaded' },
      );
      expect(response?.ok()).toBe(true);
      await assertSelectedContext(candidatePage, expectedRuntimeId);
      const accounts = candidatePage.getByTestId('accounts-page-projection');
      await expect(accounts).toBeVisible();
      await expect(candidatePage.getByTestId('accounts-visible-count')).not.toHaveText('0');
      await expect(candidatePage.getByTestId('accounts-total-count')).not.toHaveText('0');
      await expect(candidatePage.getByText('Payments, swaps, credit, and Account lifecycle commands remain on the canonical workspace.')).toBeVisible();
      await capturePageScreenshot(candidatePage, testInfo, `react-entity-workspace-accounts-${viewport.name}.png`);
      await candidatePage.evaluate(() => { window.location.hash = 'settings/entity'; });
      const profile = candidatePage.getByTestId('settings-profile-projection');
      await expect(profile).toBeVisible();
      await expect(candidatePage.getByTestId('settings-profile-name')).not.toHaveText('');
      await expect(candidatePage.getByTestId('settings-profile-role')).toHaveText('Hub entity');
      await expect(candidatePage.getByText('Profile edits and all Settings commands remain on the canonical workspace.')).toBeVisible();
      await capturePageScreenshot(candidatePage, testInfo, `react-entity-workspace-settings-profile-${viewport.name}.png`);
    } finally {
      await context.close();
    }
  }
});
