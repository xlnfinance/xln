import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildGossipDirectoryView,
  buildGossipDirectoryViewFromRuntimeEntities,
} from '../../frontend/src/lib/components/Entity/activity/gossip-directory-view';

const ALICE = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;
const BLOCKED = `0x${'33'.repeat(32)}`;

const profile = (input: {
  entityId: string;
  name: string;
  runtimeId?: string;
  lastUpdated?: number;
  isHub?: boolean;
}) => ({
  entityId: input.entityId,
  name: input.name,
  runtimeId: input.runtimeId ?? '',
  lastUpdated: input.lastUpdated ?? 0,
  metadata: { isHub: input.isHub === true },
});

test('gossip directory view projects sorted non-blocked profile rows', () => {
  const view = buildGossipDirectoryView({
    profiles: [
      profile({ entityId: ALICE, name: 'Alice', lastUpdated: 10 }),
      profile({ entityId: BLOCKED, name: 'Blocked', lastUpdated: 30 }),
      profile({ entityId: HUB, name: 'Hub', runtimeId: 'remote-h1', lastUpdated: 20, isHub: true }),
    ] as never,
    blockedCounterpartyIds: new Set([BLOCKED.toUpperCase()]),
  });

  expect(view.profileCount).toBe(2);
  expect(view.hubCount).toBe(1);
  expect(view.lastRefreshAt).toBe(20);
  expect(view.profiles.map((row) => row.entityId)).toEqual([HUB, ALICE]);
  expect(view.profiles[0]).toEqual({
    entityId: HUB,
    name: 'Hub',
    runtimeId: 'remote-h1',
    lastUpdated: 20,
    isHub: true,
  });
});

test('gossip directory view projects radapter entity summaries without full RuntimeReplica access', () => {
  const view = buildGossipDirectoryViewFromRuntimeEntities({
    runtimeId: 'radapter:ws://127.0.0.1:8092/rpc',
    entities: [
      {
        entityId: ALICE,
        label: 'Alice',
        height: 7,
        jurisdiction: { name: 'Testnet' },
      },
      {
        entityId: HUB,
        label: 'Hub',
        height: 9,
        isHub: true,
        jurisdiction: { name: 'Tron' },
      },
    ],
  });

  expect(view.profileCount).toBe(2);
  expect(view.hubCount).toBe(1);
  expect(view.lastRefreshAt).toBe(0);
  expect(view.profiles.map((row) => row.entityId)).toEqual([HUB, ALICE]);
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

test('dock GossipPanel consumes the Runtime query projection', () => {
  const dockPanel = readFileSync('frontend/src/lib/view/panels/GossipPanel.svelte', 'utf8');
  const dockRoot = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');
  const tabs = readFileSync('frontend/src/lib/components/Entity/workspace/shell/EntityPanelTabs.svelte', 'utf8');
  const settingsProjection = readFileSync('frontend/src/lib/components/Entity/workspace/shell/EntitySettingsProjectionPanel.svelte', 'utf8');

  expect(dockPanel).toContain('createRuntimeQueryStore');
  expect(dockPanel).toContain('readViewFrame');
  expect(dockPanel).toContain('buildGossipDirectoryViewFromRuntimeEntities');
  expect(dockPanel).toContain("from '../../../../packages/runtime-client/src/gossip-panel-view'");
  expect(dockPanel).not.toContain('export let runtimeFrameEnv');
  expect(dockPanel).not.toContain('env?.gossip');
  expect(dockPanel).not.toContain('gossip.getProfiles');
  expect(dockPanel).not.toContain('eReplicas');
  expect(dockPanel).not.toContain('jReplicas');
  expect(dockRoot).toContain("component = mount(GossipPanel");
  expect(dockRoot).not.toContain('props: { runtimeFrameEnv },');
  expect(tabs).not.toContain('gossipDirectoryView = buildGossipDirectoryView');
  expect(tabs).not.toContain('{gossipDirectoryView}');
  expect(settingsProjection).not.toContain('gossipDirectoryView');
  expect(settingsProjection).not.toContain('<GossipPanel');
});
