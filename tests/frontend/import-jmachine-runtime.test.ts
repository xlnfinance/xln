import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildJMachineImportRuntimeInput,
  buildPersistedJMachineConfig,
  normalizeJMachineCreateDetail,
} from '../../frontend/src/lib/components/Jurisdiction/import-jmachine-runtime';
import { deriveJMachineCreatedAt, normalizeJMachineConfig } from '../../frontend/src/lib/stores/jmachineStore';

const draft = {
  name: 'local-sim-visual',
  mode: 'browservm' as const,
  chainId: 31337,
  rpcs: ['https://ignored.example'],
  blockTimeMs: 1_000,
  ticker: 'sim',
};

test('JMachine import builds a RuntimeInput importJ command', () => {
  const input = buildJMachineImportRuntimeInput(draft);

  expect(input.entityInputs).toEqual([]);
  expect(input.runtimeTxs).toEqual([{
    type: 'importJ',
    data: {
      name: 'local-sim-visual',
      chainId: 31337,
      ticker: 'SIM',
      rpcs: [],
      blockTimeMs: 1_000,
    },
  }]);
});

test('JMachine persisted metadata is deterministic and preserves existing createdAt', () => {
  const normalized = normalizeJMachineCreateDetail(draft);
  const first = buildPersistedJMachineConfig(draft);
  const second = buildPersistedJMachineConfig(draft);
  const existing = buildPersistedJMachineConfig(draft, null, { ...first, createdAt: 99 });

  expect(first.createdAt).toBe(deriveJMachineCreatedAt(normalized));
  expect(second.createdAt).toBe(first.createdAt);
  expect(existing.createdAt).toBe(99);
});

test('JMachine config normalization does not depend on wall-clock fallback', () => {
  const config = normalizeJMachineConfig({
    name: 'remote-hub',
    mode: 'rpc',
    chainId: 84532,
    ticker: 'eth',
    rpcs: ['https://base-sepolia.example'],
    blockTimeMs: 2_000,
  });

  expect(config?.createdAt).toBe(deriveJMachineCreatedAt({
    name: 'remote-hub',
    mode: 'rpc',
    chainId: 84532,
    ticker: 'eth',
    rpcs: ['https://base-sepolia.example'],
    blockTimeMs: 2_000,
  }));
});

test('Settings/UserMode JMachine import uses the shared runtime helper', () => {
  const settings = readFileSync('frontend/src/lib/components/Entity/EntitySettingsProjectionPanel.svelte', 'utf8');
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  const userMode = readFileSync('frontend/src/lib/view/UserModePanel.svelte', 'utf8');
  const addJMachine = readFileSync('frontend/src/lib/components/Jurisdiction/AddJMachine.svelte', 'utf8');
  const store = readFileSync('frontend/src/lib/stores/jmachineStore.ts', 'utf8');
  const helper = readFileSync('frontend/src/lib/components/Jurisdiction/import-jmachine-runtime.ts', 'utf8');

  expect(settings).toContain('onImportJMachine(event.detail)');
  expect(tabs).toContain('await importJMachineViaRuntime(env, detail)');
  expect(userMode).toContain('await importJMachineViaRuntime(env, event.detail)');
  expect(userMode).toContain('data-testid="user-mode-jmachine-error"');
  expect(helper).toContain('J_MACHINE_IMPORT_COMMIT_WAIT_MS = 3_000');
  expect(helper).toContain('while (!nextEnv.jReplicas?.get?.(normalized.name)');
  expect(helper).toContain('await sleep(J_MACHINE_IMPORT_COMMIT_POLL_MS)');
  expect(userMode).not.toContain('[ensureSelfEntities] No J-machines');
  expect(addJMachine).not.toContain('Date.now()');
  expect(store).not.toContain('Date.now()');
});
