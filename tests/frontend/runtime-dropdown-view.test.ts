import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildRuntimeDropdownEntries,
  remoteHostLabel,
  shortRuntimeId,
} from '../../frontend/src/lib/components/Runtime/runtime-dropdown-view';

test('runtime dropdown view keeps browser and remote runtimes in one source-marked list', () => {
  const entries = buildRuntimeDropdownEntries({
    remoteRuntimes: [{
      id: '0xremote',
      label: 'H1',
      permissions: 'read',
      status: 'connected',
      hubEntities: [{
        entityId: '0xhub1',
        label: 'H1',
        runtimeId: '0xremote',
        jurisdiction: { name: 'Testnet', chainId: 31337 },
      }, {
        entityId: '0xhub2',
        label: 'H2',
        runtimeId: '0xother',
        jurisdiction: { name: 'Tron', chainId: 31338 },
      }],
    }],
    vaultRuntimes: [{
      id: '0xbrowser',
      label: 'Browser A',
      signers: [{
        address: '0x1111222233334444555566667777888899990000',
        name: 'Signer A',
        entityId: '0xentity1',
        jurisdiction: 'Testnet',
      }],
    }],
    activeRuntimeId: '0xbrowser',
    connStatus: 'connected',
    runtimeAdapterDotStatus: 'connected',
  });

  expect(entries.map(entry => [entry.source, entry.label])).toEqual([
    ['remote', 'H1'],
    ['browser', '0x1111...0000 (Browser A)'],
  ]);
  expect(entries[0]?.groups.map(group => [group.label, group.entities.map(entity => entity.label)])).toEqual([
    ['Testnet', ['H1']],
  ]);
  expect(entries[1]?.groups).toEqual([{
    id: 'testnet',
    label: 'Testnet',
    entities: [{ id: '0xentity1', label: 'Signer A' }],
  }]);
});

test('runtime dropdown uses stable compact labels for long ids and remote endpoints', () => {
  expect(shortRuntimeId('0x1111222233334444555566667777888899990000')).toBe('0x1111...0000');
  expect(remoteHostLabel({ id: 'radapter', label: 'Remote ws://127.0.0.1:8092/rpc' })).toBe('127.0.0.1:8092/rpc');
});

test('RuntimeDropdown renders source chips and runtime-jurisdiction-entity tree rows', () => {
  const source = readFileSync('frontend/src/lib/components/Runtime/RuntimeDropdown.svelte', 'utf8');

  expect(source).toContain('buildRuntimeDropdownEntries');
  expect(source).toContain('source-chip {runtime.source}');
  expect(source).toContain('runtime-tree');
  expect(source).toContain('{#each runtime.groups as group (group.id)}');
  expect(source).toContain('{#each group.entities as entity (entity.id)}');
});
