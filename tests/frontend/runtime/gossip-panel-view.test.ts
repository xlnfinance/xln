import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildGossipDirectoryViewFromRuntimeEntities,
  emptyGossipDirectoryView,
  filterGossipDirectoryProfiles,
  getGossipDirectoryDisplayName,
  type GossipDirectoryProfile,
} from '../../../frontend/packages/runtime-client/src/gossip-panel-view';

const ALICE = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;
const BLOCKED = `0x${'33'.repeat(32)}`;

const directoryProfile = (input: Partial<GossipDirectoryProfile> = {}): GossipDirectoryProfile => ({
  entityId: ALICE,
  name: 'Alice',
  runtimeId: 'radapter:local',
  lastUpdated: 0,
  isHub: false,
  ...input,
});

describe('gossip panel view model', () => {
  test('projects Runtime summaries in canonical hub-first order and excludes blocked peers', () => {
    const view = buildGossipDirectoryViewFromRuntimeEntities({
      runtimeId: ' radapter:ws://127.0.0.1:8092/rpc ',
      blockedCounterpartyIds: new Set([BLOCKED.toUpperCase()]),
      entities: [
        { entityId: ALICE, label: 'Alice', height: 7, jurisdiction: { name: 'Testnet' } },
        { entityId: BLOCKED, label: 'Blocked', height: 8 },
        { entityId: HUB, label: 'Hub', height: 9.9, isHub: true, jurisdiction: { name: 'Tron' } },
      ],
    });

    expect(view.profileCount).toBe(2);
    expect(view.hubCount).toBe(1);
    expect(view.lastRefreshAt).toBe(0);
    expect(view.profiles.map(({ entityId }) => entityId)).toEqual([HUB, ALICE]);
    expect(view.profiles[0]).toEqual({
      entityId: HUB,
      name: 'Hub',
      runtimeId: 'radapter:ws://127.0.0.1:8092/rpc',
      lastUpdated: 0,
      isHub: true,
      height: 9,
      jurisdictionName: 'Tron',
    });
  });

  test('filters by every visible identity field without changing source order', () => {
    const profiles = [
      directoryProfile(),
      directoryProfile({ entityId: HUB, name: 'Relay', runtimeId: 'remote-hub', jurisdictionName: 'Tron' }),
    ];

    expect(filterGossipDirectoryProfiles(profiles, '  TRON  ')).toEqual([profiles[1]]);
    expect(filterGossipDirectoryProfiles(profiles, 'remote-HUB')).toEqual([profiles[1]]);
    expect(filterGossipDirectoryProfiles(profiles, HUB.slice(-8).toUpperCase())).toEqual([profiles[1]]);
    expect(filterGossipDirectoryProfiles(profiles, '')).toEqual(profiles);
    expect(filterGossipDirectoryProfiles(profiles, '')).not.toBe(profiles);
  });

  test('preserves empty and identity fallback presentation semantics', () => {
    expect(emptyGossipDirectoryView()).toEqual({
      profiles: [], profileCount: 0, hubCount: 0, lastRefreshAt: 0,
    });
    expect(getGossipDirectoryDisplayName(directoryProfile())).toBe('Alice');
    expect(getGossipDirectoryDisplayName(directoryProfile({ name: '' }))).toBe(ALICE);
  });

  test('keeps Runtime reads and lifecycle effects in Svelte while consuming the shared projection', () => {
    const panel = readFileSync('frontend/src/lib/view/panels/GossipPanel.svelte', 'utf8');
    const facade = readFileSync(
      'frontend/src/lib/components/Entity/activity/gossip-directory-view.ts',
      'utf8',
    );

    expect(panel).toContain("from '../../../../packages/runtime-client/src/gossip-panel-view'");
    expect(panel).toContain('createRuntimeQueryStore');
    expect(panel).toContain('frameStore.destroy()');
    expect(panel).toContain('filterGossipDirectoryProfiles');
    expect(panel).not.toContain('.filter((profile) =>');
    expect(facade).toContain("from '../../../../../packages/runtime-client/src/gossip-panel-view'");
  });
});
