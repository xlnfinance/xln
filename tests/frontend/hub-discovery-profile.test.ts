import { expect, test } from 'bun:test';

import {
  HUB_OPEN_ACCOUNT_REQUIRES_ADMIN,
  buildDirectOpenAccountRuntimeInput,
  buildHubOpenAccountRuntimeInput,
  buildHubDiscoveryProjection,
  buildHubDiscoveryRemoteHubsFromRuntimes,
  canSubmitHubOpenAccount,
  ensureHubOpenAccountProfileReady,
  getHubOpenAccountPermissionError,
  hubDiscoveryJurisdictionKey,
  hubHasPublishedRuntimeRoute,
  isSameEntityId,
} from '../../frontend/src/lib/components/Entity/hub-discovery-profile';
import { readFileSync } from 'node:fs';

const SOURCE = `0x${'11'.repeat(32)}`;
const SIGNER = `0x${'22'.repeat(20)}`;
const HUB = `0x${'33'.repeat(32)}`;
const RUNTIME = `0x${'44'.repeat(20)}`;
const JURISDICTION = {
  name: 'Testnet',
  chainId: 31337,
  depositoryAddress: `0x${'55'.repeat(20)}`,
};
const REBALANCE_POLICY = {
  r2cRequestSoftLimit: 100n,
  hardLimit: 200n,
  maxAcceptableFee: 3n,
};

const sourceEnv = () => ({
  eReplicas: new Map([
    [`${SOURCE}:${SIGNER}`, {
      state: {
        entityId: SOURCE,
        config: { jurisdiction: JURISDICTION },
      },
    }],
  ]),
});

const hub = {
  entityId: HUB,
  runtimeId: RUNTIME,
  metadata: {
    isHub: true,
    jurisdiction: JURISDICTION,
  },
};

test('hub open-account readiness accepts remote snapshots with a published hub route', async () => {
  expect(hubHasPublishedRuntimeRoute(hub)).toBe(true);
  await expect(ensureHubOpenAccountProfileReady({
    env: sourceEnv() as never,
    sourceEntityId: SOURCE,
    hub,
    seedProfiles: async () => ({ ready: false }),
    timeoutMs: 100,
  })).resolves.toBeUndefined();
});

test('hub open-account readiness rejects self-account attempts before profile checks', async () => {
  await expect(ensureHubOpenAccountProfileReady({
    env: sourceEnv() as never,
    sourceEntityId: SOURCE,
    hub: { ...hub, entityId: SOURCE },
    seedProfiles: async () => {
      throw new Error('seed should not run for self-account');
    },
    timeoutMs: 100,
  })).rejects.toThrow('Cannot open an account with the same entity');
  expect(isSameEntityId(SOURCE.toUpperCase(), SOURCE.toLowerCase())).toBe(true);
});

test('hub open-account readiness rejects live runtimes without a usable route', async () => {
  const env = {
    ...sourceEnv(),
    gossip: {
      getProfiles: () => [],
    },
    runtimeState: {
      p2p: {
        ensureProfiles: async () => false,
      },
    },
  };

  await expect(ensureHubOpenAccountProfileReady({
    env: env as never,
    sourceEntityId: SOURCE,
    hub,
    seedProfiles: async () => ({ ready: false, error: 'not found' }),
    timeoutMs: 100,
  })).rejects.toThrow('Hub routing profile is not ready');
});

test('hub open-account actions require admin auth for remote runtimes', () => {
  expect(canSubmitHubOpenAccount({ adapterMode: 'embedded', authLevel: null })).toBe(true);
  expect(canSubmitHubOpenAccount({ adapterMode: 'remote', authLevel: 'inspect' })).toBe(false);
  expect(canSubmitHubOpenAccount({ adapterMode: 'remote', authLevel: null })).toBe(false);
  expect(canSubmitHubOpenAccount({ adapterMode: 'remote', authLevel: 'admin' })).toBe(true);
  expect(getHubOpenAccountPermissionError({ adapterMode: 'remote', authLevel: 'inspect' }))
    .toBe(HUB_OPEN_ACCOUNT_REQUIRES_ADMIN);
  expect(HUB_OPEN_ACCOUNT_REQUIRES_ADMIN).toBe('Account opening requires admin runtime access.');
});

test('hub open-account command builds an explicit RuntimeInput batch', () => {
  const input = buildHubOpenAccountRuntimeInput({
    sourceEntityId: SOURCE.toUpperCase(),
    signerId: SIGNER,
    hubEntityId: HUB.toUpperCase(),
    creditAmount: 10_000n,
    tokenId: 7,
    rebalancePolicy: REBALANCE_POLICY,
  });

  expect(input.runtimeTxs).toEqual([]);
  expect(input.entityInputs).toHaveLength(1);
  expect(input.entityInputs[0]?.entityId).toBe(SOURCE.toLowerCase());
  expect(input.entityInputs[0]?.signerId).toBe(SIGNER);
  expect(input.entityInputs[0]?.entityTxs).toEqual([{
    type: 'openAccount',
    data: {
      targetEntityId: HUB.toLowerCase(),
      creditAmount: 10_000n,
      tokenId: 7,
      rebalancePolicy: REBALANCE_POLICY,
    },
  }]);
});

test('direct open-account command builds an explicit RuntimeInput batch', () => {
  const input = buildDirectOpenAccountRuntimeInput({
    sourceEntityId: SOURCE.toUpperCase(),
    signerId: SIGNER,
    targetEntityId: HUB.toUpperCase(),
    rebalancePolicy: REBALANCE_POLICY,
  });

  expect(input.runtimeTxs).toEqual([]);
  expect(input.entityInputs).toHaveLength(1);
  expect(input.entityInputs[0]?.entityId).toBe(SOURCE.toLowerCase());
  expect(input.entityInputs[0]?.signerId).toBe(SIGNER);
  expect(input.entityInputs[0]?.entityTxs).toEqual([{
    type: 'openAccount',
    data: {
      targetEntityId: HUB.toLowerCase(),
      rebalancePolicy: REBALANCE_POLICY,
    },
  }]);
});

test('direct open-account command rejects malformed command targets', () => {
  expect(() => buildDirectOpenAccountRuntimeInput({
    sourceEntityId: SOURCE,
    signerId: SIGNER,
    targetEntityId: SOURCE,
  })).toThrow('Cannot open an account with the same entity');
  expect(() => buildDirectOpenAccountRuntimeInput({
    sourceEntityId: SOURCE,
    signerId: '',
    targetEntityId: HUB,
  })).toThrow('Signer is required');
  expect(() => buildDirectOpenAccountRuntimeInput({
    sourceEntityId: SOURCE,
    signerId: SIGNER,
    targetEntityId: '',
  })).toThrow('Target entity is required');
});

test('hub open-account command rejects malformed command targets', () => {
  expect(() => buildHubOpenAccountRuntimeInput({
    sourceEntityId: SOURCE,
    signerId: SIGNER,
    hubEntityId: SOURCE,
    creditAmount: 1n,
  })).toThrow('Cannot open an account with the same entity');
  expect(() => buildHubOpenAccountRuntimeInput({
    sourceEntityId: SOURCE,
    signerId: '',
    hubEntityId: HUB,
    creditAmount: 1n,
  })).toThrow('Signer is required');
  expect(() => buildHubOpenAccountRuntimeInput({
    sourceEntityId: SOURCE,
    signerId: SIGNER,
    hubEntityId: HUB,
    creditAmount: 0n,
  })).toThrow('credit amount must be positive');
});

test('hub discovery projection exposes same-jurisdiction hubs and account status', () => {
  const account = {
    leftEntity: SOURCE,
    rightEntity: HUB,
    currentFrame: { height: 7 },
    currentHeight: 7,
  };
  const replicas = new Map([
    [`${SOURCE}:${SIGNER}`, {
      entityId: SOURCE,
      state: {
        entityId: SOURCE,
        config: { jurisdiction: JURISDICTION },
        accounts: new Map([[HUB, account]]),
      },
    }],
    [`${HUB}:${SIGNER}`, {
      entityId: HUB,
      state: {
        entityId: HUB,
        timestamp: 42,
        config: { jurisdiction: JURISDICTION },
        accounts: new Map([[SOURCE, account]]),
        profile: {
          name: 'H1',
          bio: 'hub',
          isHub: true,
          routingFeePPM: 25,
        },
      },
    }],
    [`0x${'66'.repeat(32)}:${SIGNER}`, {
      entityId: `0x${'66'.repeat(32)}`,
      state: {
        entityId: `0x${'66'.repeat(32)}`,
        config: {
          jurisdiction: {
            ...JURISDICTION,
            chainId: 31338,
          },
        },
        accounts: new Map(),
        profile: {
          name: 'foreign',
          isHub: true,
        },
      },
    }],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
    formatRawProfile: () => 'raw-profile',
    avatarForEntity: (entityId) => `avatar:${entityId}`,
  });

  expect(projection.entityJurisdictionKey).toBe(hubDiscoveryJurisdictionKey(JURISDICTION));
  expect(projection.sourceSignerId).toBe(SIGNER);
  expect(projection.discoveryKey).toBe(`${RUNTIME}:${SOURCE.toLowerCase()}:${projection.entityJurisdictionKey}`);
  expect(projection.localHubs).toHaveLength(1);
  expect(projection.localHubs[0]?.entityId).toBe(HUB);
  expect(projection.localHubs[0]?.name).toBe('H1');
  expect(projection.localHubs[0]?.metadata.fee).toBe(25);
  expect(projection.localHubs[0]?.lastSeen).toBe(42);
  expect(projection.localHubs[0]?.raw).toBe('raw-profile');
  expect(projection.localHubs[0]?.isConnected).toBe(true);
  expect(projection.localHubs[0]?.isOpening).toBe(false);
  expect(projection.connectionByHubId.get(HUB.toLowerCase())?.isConnected).toBe(true);
});

test('hub discovery projection exposes same-jurisdiction hub profiles without full hub replicas', () => {
  const replicas = new Map([
    [`${SOURCE}:${SIGNER}`, {
      entityId: SOURCE,
      state: {
        entityId: SOURCE,
        config: { jurisdiction: JURISDICTION },
        accounts: new Map(),
      },
    }],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
    profiles: [{
      entityId: HUB,
      name: 'H1',
      avatar: 'avatar-url',
      bio: 'profile hub',
      website: 'https://hub.example',
      lastUpdated: 99,
      runtimeId: RUNTIME,
      runtimeEncPubKey: '',
      publicAccounts: [SOURCE],
      wsUrl: 'ws://127.0.0.1:3333',
      relays: [],
      metadata: {
        entityEncPubKey: '',
        isHub: true,
        hubName: 'H1',
        routingFeePPM: 17,
        baseFee: 0n,
        board: { threshold: 1, validators: [] },
        jurisdiction: JURISDICTION,
      },
      accounts: [],
    } as never],
    formatRawProfile: () => 'raw-profile',
  });

  expect(projection.localHubs).toHaveLength(1);
  expect(projection.localHubs[0]?.entityId).toBe(HUB);
  expect(projection.localHubs[0]?.name).toBe('H1');
  expect(projection.localHubs[0]?.metadata.fee).toBe(17);
  expect(projection.localHubs[0]?.metadata.description).toBe('profile hub');
  expect(projection.localHubs[0]?.runtimeId).toBe(RUNTIME);
  expect(projection.localHubs[0]?.wsUrl).toBe('ws://127.0.0.1:3333');
  expect(projection.localHubs[0]?.lastSeen).toBe(99);
  expect(projection.localHubs[0]?.raw).toBe('raw-profile');
});

test('hub discovery projection exposes same-jurisdiction remote runtime hubs without full hub replicas', () => {
  const replicas = new Map([
    [`${SOURCE}:${SIGNER}`, {
      entityId: SOURCE,
      state: {
        entityId: SOURCE,
        config: { jurisdiction: JURISDICTION },
        accounts: new Map(),
      },
    }],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
    remoteHubs: [{
      entityId: HUB,
      name: 'Remote H1',
      runtimeId: 'radapter:ws://127.0.0.1:8092/rpc',
      wsUrl: 'ws://127.0.0.1:8092/rpc',
      jurisdiction: JURISDICTION,
      height: 123,
    }],
    avatarForEntity: (entityId) => `avatar:${entityId}`,
  });

  expect(projection.localHubs).toHaveLength(1);
  expect(projection.localHubs[0]?.entityId).toBe(HUB);
  expect(projection.localHubs[0]?.name).toBe('Remote H1');
  expect(projection.localHubs[0]?.metadata.description).toBe('Remote runtime hub');
  expect(projection.localHubs[0]?.runtimeId).toBe('radapter:ws://127.0.0.1:8092/rpc');
  expect(projection.localHubs[0]?.wsUrl).toBe('ws://127.0.0.1:8092/rpc');
  expect(projection.localHubs[0]?.lastSeen).toBe(123);
});

test('hub discovery remote hubs are projected from runtime registry outside EntityPanelTabs', () => {
  const runtimes = [
    {
      id: 'radapter:ws://127.0.0.1:8092/rpc',
      type: 'remote',
      label: 'H1 Runtime',
      env: null,
      wsUrl: 'ws://127.0.0.1:8092/rpc',
      permissions: 'write',
      status: 'connected',
      hubEntities: [{
        entityId: HUB,
        label: 'H1',
        height: 123,
        jurisdiction: JURISDICTION,
      }],
      lastSynced: 456,
    },
    {
      id: 'radapter:ws://127.0.0.1:8093/rpc',
      type: 'remote',
      label: 'Legacy Runtime',
      env: null,
      wsUrl: 'ws://127.0.0.1:8093/rpc',
      permissions: 'read',
      status: 'connected',
      hubEntityId: `0x${'66'.repeat(32)}`,
      hubName: 'Legacy H2',
      hubJurisdiction: JURISDICTION,
    },
    {
      id: 'local',
      type: 'local',
      label: 'Local',
      env: null,
      permissions: 'write',
      status: 'connected',
    },
  ];

  const hubs = buildHubDiscoveryRemoteHubsFromRuntimes(runtimes as never);
  expect(hubs).toHaveLength(2);
  expect(hubs[0]).toMatchObject({
    entityId: HUB,
    name: 'H1',
    runtimeId: 'radapter:ws://127.0.0.1:8092/rpc',
    wsUrl: 'ws://127.0.0.1:8092/rpc',
    height: 123,
    lastSeen: 456,
  });
  expect(hubs[1]).toMatchObject({
    name: 'Legacy H2',
    runtimeId: 'radapter:ws://127.0.0.1:8093/rpc',
    wsUrl: 'ws://127.0.0.1:8093/rpc',
    height: 0,
  });

  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  expect(tabs).toContain('buildHubDiscoveryRemoteHubsFromRuntimes($runtimeHandles.values())');
  expect(tabs).not.toContain('remoteHubCandidates = Array.from($runtimeHandles.values()).flatMap');
});

test('hub discovery projection tracks connected fetched hubs without local hub replicas', () => {
  const account = {
    leftEntity: SOURCE,
    rightEntity: HUB,
    currentFrame: { height: 3 },
  };
  const replicas = new Map([
    [`${SOURCE}:${SIGNER}`, {
      entityId: SOURCE,
      state: {
        entityId: SOURCE,
        config: { jurisdiction: JURISDICTION },
        accounts: new Map([[HUB, account]]),
      },
    }],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
  });

  expect(projection.localHubs).toHaveLength(0);
  expect(projection.connectionByHubId.get(HUB.toLowerCase())?.isConnected).toBe(true);
  expect(projection.connectionByHubId.get(HUB.toLowerCase())?.isOpening).toBe(false);
});

test('hub discovery projection marks uncommitted account as opening', () => {
  const replicas = new Map([
    [`${SOURCE}:${SIGNER}`, {
      entityId: SOURCE,
      state: {
        entityId: SOURCE,
        config: { jurisdiction: JURISDICTION },
        accounts: new Map([[HUB, { leftEntity: SOURCE, rightEntity: HUB }]]),
      },
    }],
    [`${HUB}:${SIGNER}`, {
      entityId: HUB,
      state: {
        entityId: HUB,
        config: { jurisdiction: JURISDICTION },
        accounts: new Map(),
        profile: { name: 'H1', isHub: true },
      },
    }],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
  });

  expect(projection.localHubs[0]?.isConnected).toBe(false);
  expect(projection.localHubs[0]?.isOpening).toBe(true);
});

test('HubDiscoveryPanel renders a supplied projection instead of scanning eReplicas', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/HubDiscoveryPanel.svelte', 'utf8');
  const profile = readFileSync('frontend/src/lib/components/Entity/hub-discovery-profile.ts', 'utf8');
  const accountOpen = readFileSync('frontend/src/lib/components/Entity/AccountOpenPanel.svelte', 'utf8');
  const accountWorkspace = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  expect(source).toContain('export let hubDiscoveryProjection');
  expect(source).toContain('export let canOpenAccounts = true');
  expect(source).toContain('export let submitRuntimeInput');
  expect(source).toContain('hubDiscoveryProjection.sourceSignerId');
  expect(source).toContain('ensureHubOpenAccountProfileReady({');
  expect(source).toContain("import { runtimeControllerHandle } from '../../stores/runtimeControllerStore'");
  expect(source).toContain('adapterMode: $runtimeControllerHandle.mode');
  expect(source).toContain('authLevel: $runtimeControllerHandle.authLevel');
  expect(source).toContain('hubDiscoveryProjection.localHubs');
  expect(source).toContain('projectedHubs = mergeHubs(hubDiscoveryProjection.localHubs, hubs)');
  expect(profile).toContain('profiles?: readonly GossipProfile[]');
  expect(profile).toContain('remoteHubs?: readonly HubDiscoveryRemoteHub[]');
  expect(profile).toContain('for (const profile of input.profiles ?? [])');
  expect(profile).toContain('for (const remoteHub of input.remoteHubs ?? [])');
  expect(source).toContain('projectedConnection?.isConnected || projectedConnection?.isOpening');
  expect(source).toContain('buildHubOpenAccountRuntimeInput');
  expect(source).toContain('await submitRuntimeInput(buildHubOpenAccountRuntimeInput');
  expect(source).toContain('{:else if entityId && canOpenHubAccount}');
  expect(source).not.toContain("throw new Error('Environment not ready')");
  expect(source).not.toContain('const currentEnv = actionRuntimeEnv;\\n      if (!currentEnv)');
  expect(source).not.toContain('fetch(');
  expect(source).not.toContain('/api/hubs');
  expect(source).not.toContain('/api/gossip/profile');
  expect(source).not.toContain('resolveConfiguredApiBase');
  expect(source).not.toContain('Date.now');
  expect(source).not.toContain('setTimeout');
  expect(source).not.toContain('AbortController');
  expect(source).not.toContain('enqueueAndProcess');
  expect(source).not.toContain('Read only');
  expect(source.includes(['Open Account requires', 'runtime access'].join(' full '))).toBe(false);
  expect(accountOpen).toContain('export let canOpenAccounts = true');
  expect(accountOpen).toContain('{#if activeIsLive}');
  expect(accountOpen).toContain('{actionRuntimeEnv}');
  expect(accountOpen).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'hub-discovery')");
  expect(accountOpen).toContain('{#if canOpenAccounts}');
  expect(accountOpen).toContain('{submitRuntimeInput}');
  expect(accountWorkspace).toContain('export let canOpenAccounts = true');
  expect(accountWorkspace).toContain('{canOpenAccounts}');
  expect(accountWorkspace).toContain('{submitRuntimeInput}');
  expect(tabs).toContain('canOpenAccounts = canSubmitHubOpenAccount');
  expect(tabs).toContain('profiles: directoryPanelView.profiles?.length ? directoryPanelView.profiles : panelProfiles');
  expect(tabs).toContain("import { runtimes as runtimeHandles } from '../../stores/runtimeStore'");
  expect(tabs).toContain('remoteHubs: remoteHubCandidates');
  expect(tabs).toContain('if (!canOpenAccounts)');
  expect(tabs).toContain('buildDirectOpenAccountRuntimeInput');
  expect(tabs).toContain('await submitRuntimeInput(buildDirectOpenAccountRuntimeInput');
  expect(tabs).toContain('{canOpenAccounts}');
  expect(tabs).toContain('{submitRuntimeInput}');
  const directOpenStart = tabs.indexOf('async function openAccountWithFullId');
  const nextFunctionStart = tabs.indexOf('function confirmDisputeAction', directOpenStart);
  expect(directOpenStart).toBeGreaterThan(0);
  expect(nextFunctionStart).toBeGreaterThan(directOpenStart);
  const directOpenSource = tabs.slice(directOpenStart, nextFunctionStart);
  expect(directOpenSource).not.toContain('enqueueEntityInputs');
  expect(directOpenSource).not.toContain('buildEntityInput');
  expect(source).not.toContain('enqueueEntityInputs');
  expect(source).not.toContain("type: 'openAccount'");
  expect(source).not.toContain('function collectLocalHubs');
  expect(source).not.toContain('env?.eReplicas');
  expect(source).not.toContain('getEntityJurisdictionKey(');
  expect(source).not.toContain('appRuntimeAdapterMode');
  expect(source).not.toContain('runtimeAdapterAuthLevel');
  expect(tabs).toContain("import { runtimeControllerHandle } from '../../stores/runtimeControllerStore'");
  expect(tabs).toContain('adapterMode: $runtimeControllerHandle.mode');
  expect(tabs).toContain('authLevel: $runtimeControllerHandle.authLevel');
  expect(tabs).not.toContain('appRuntimeAdapterMode');
  expect(tabs).not.toContain('runtimeAdapterAuthLevel');
});
