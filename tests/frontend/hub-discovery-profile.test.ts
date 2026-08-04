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
  state: { eReplicas: new Map([
    [
      `${SOURCE}:${SIGNER}`,
      {
        state: {
          entityId: SOURCE,
          config: { jurisdiction: JURISDICTION },
        },
      },
    ],
  ]) },
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
  await expect(
    ensureHubOpenAccountProfileReady({
      env: sourceEnv() as never,
      sourceEntityId: SOURCE,
      hub,
      seedProfiles: async () => ({ ready: false }),
      timeoutMs: 100,
    }),
  ).resolves.toBeUndefined();
});

test('hub open-account readiness rejects self-account attempts before profile checks', async () => {
  await expect(
    ensureHubOpenAccountProfileReady({
      env: sourceEnv() as never,
      sourceEntityId: SOURCE,
      hub: { ...hub, entityId: SOURCE },
      seedProfiles: async () => {
        throw new Error('seed should not run for self-account');
      },
      timeoutMs: 100,
    }),
  ).rejects.toThrow('Cannot open an account with the same entity');
  expect(isSameEntityId(SOURCE.toUpperCase(), SOURCE.toLowerCase())).toBe(true);
});

test('hub open-account readiness rejects live runtimes without a usable route', async () => {
  const env = {
    ...sourceEnv(),
    gossip: {
      getProfiles: () => [],
    },
    infrastructure: {
      p2p: {
        ensureProfiles: async () => false,
      },
    },
  };

  await expect(
    ensureHubOpenAccountProfileReady({
      env: env as never,
      sourceEntityId: SOURCE,
      hub,
      seedProfiles: async () => ({ ready: false, error: 'not found' }),
      timeoutMs: 100,
    }),
  ).rejects.toThrow('Hub routing profile is not ready');
});

test('hub open-account actions require admin auth for remote runtimes', () => {
  expect(canSubmitHubOpenAccount({ adapterMode: 'embedded', authLevel: null })).toBe(true);
  expect(canSubmitHubOpenAccount({ adapterMode: 'remote', authLevel: 'inspect' })).toBe(false);
  expect(canSubmitHubOpenAccount({ adapterMode: 'remote', authLevel: null })).toBe(false);
  expect(canSubmitHubOpenAccount({ adapterMode: 'remote', authLevel: 'admin' })).toBe(true);
  expect(getHubOpenAccountPermissionError({ adapterMode: 'remote', authLevel: 'inspect' })).toBe(
    HUB_OPEN_ACCOUNT_REQUIRES_ADMIN,
  );
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
  expect(input.entityInputs[0]?.entityTxs).toEqual([
    {
      type: 'openAccount',
      data: {
        targetEntityId: HUB.toLowerCase(),
        creditAmount: 10_000n,
        tokenId: 7,
        rebalancePolicy: REBALANCE_POLICY,
      },
    },
  ]);
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
  expect(input.entityInputs[0]?.entityTxs).toEqual([
    {
      type: 'openAccount',
      data: {
        targetEntityId: HUB.toLowerCase(),
        rebalancePolicy: REBALANCE_POLICY,
      },
    },
  ]);
});

test('direct open-account command rejects malformed command targets', () => {
  expect(() =>
    buildDirectOpenAccountRuntimeInput({
      sourceEntityId: SOURCE,
      signerId: SIGNER,
      targetEntityId: SOURCE,
    }),
  ).toThrow('Cannot open an account with the same entity');
  expect(() =>
    buildDirectOpenAccountRuntimeInput({
      sourceEntityId: SOURCE,
      signerId: '',
      targetEntityId: HUB,
    }),
  ).toThrow('Signer is required');
  expect(() =>
    buildDirectOpenAccountRuntimeInput({
      sourceEntityId: SOURCE,
      signerId: SIGNER,
      targetEntityId: '',
    }),
  ).toThrow('Target entity is required');
});

test('hub open-account command rejects malformed command targets', () => {
  expect(() =>
    buildHubOpenAccountRuntimeInput({
      sourceEntityId: SOURCE,
      signerId: SIGNER,
      hubEntityId: SOURCE,
      creditAmount: 1n,
    }),
  ).toThrow('Cannot open an account with the same entity');
  expect(() =>
    buildHubOpenAccountRuntimeInput({
      sourceEntityId: SOURCE,
      signerId: '',
      hubEntityId: HUB,
      creditAmount: 1n,
    }),
  ).toThrow('Signer is required');
  expect(() =>
    buildHubOpenAccountRuntimeInput({
      sourceEntityId: SOURCE,
      signerId: SIGNER,
      hubEntityId: HUB,
      creditAmount: 0n,
    }),
  ).toThrow('credit amount must be positive');
});

test('hub discovery projection exposes same-jurisdiction hubs and account status', () => {
  const account = {
    state: { leftEntity: SOURCE, rightEntity: HUB },
    currentFrame: { height: 7 },
    currentHeight: 7,
  };
  const replicas = new Map([
    [
      `${SOURCE}:${SIGNER}`,
      {
        entityId: SOURCE,
        state: {
          entityId: SOURCE,
          config: { jurisdiction: JURISDICTION },
          accounts: new Map([[HUB, account]]),
        },
      },
    ],
    [
      `${HUB}:${SIGNER}`,
      {
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
      },
    ],
    [
      `0x${'66'.repeat(32)}:${SIGNER}`,
      {
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
      },
    ],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
    formatRawProfile: () => 'raw-profile',
    avatarForEntity: entityId => `avatar:${entityId}`,
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
    [
      `${SOURCE}:${SIGNER}`,
      {
        entityId: SOURCE,
        state: {
          entityId: SOURCE,
          config: { jurisdiction: JURISDICTION },
          accounts: new Map(),
        },
      },
    ],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
    profiles: [
      {
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
      } as never,
    ],
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
    [
      `${SOURCE}:${SIGNER}`,
      {
        entityId: SOURCE,
        state: {
          entityId: SOURCE,
          config: { jurisdiction: JURISDICTION },
          accounts: new Map(),
        },
      },
    ],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
    remoteHubs: [
      {
        entityId: HUB,
        name: 'Remote H1',
        runtimeId: 'radapter:ws://127.0.0.1:8092/rpc',
        wsUrl: 'ws://127.0.0.1:8092/rpc',
        jurisdiction: JURISDICTION,
        height: 123,
      },
    ],
    avatarForEntity: entityId => `avatar:${entityId}`,
  });

  expect(projection.localHubs).toHaveLength(1);
  expect(projection.localHubs[0]?.entityId).toBe(HUB);
  expect(projection.localHubs[0]?.name).toBe('Remote H1');
  expect(projection.localHubs[0]?.metadata.description).toBe('Remote runtime hub');
  expect(projection.localHubs[0]?.runtimeId).toBe('radapter:ws://127.0.0.1:8092/rpc');
  expect(projection.localHubs[0]?.wsUrl).toBe('ws://127.0.0.1:8092/rpc');
  expect(projection.localHubs[0]?.lastSeen).toBe(123);
});


test('hub discovery projection tracks connected fetched hubs without local hub replicas', () => {
  const account = {
    state: { leftEntity: SOURCE, rightEntity: HUB },
    currentFrame: { height: 3 },
  };
  const replicas = new Map([
    [
      `${SOURCE}:${SIGNER}`,
      {
        entityId: SOURCE,
        state: {
          entityId: SOURCE,
          config: { jurisdiction: JURISDICTION },
          accounts: new Map([[HUB, account]]),
        },
      },
    ],
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
    [
      `${SOURCE}:${SIGNER}`,
      {
        entityId: SOURCE,
        state: {
          entityId: SOURCE,
          config: { jurisdiction: JURISDICTION },
          accounts: new Map([[HUB, { state: { leftEntity: SOURCE, rightEntity: HUB } }]]),
        },
      },
    ],
    [
      `${HUB}:${SIGNER}`,
      {
        entityId: HUB,
        state: {
          entityId: HUB,
          config: { jurisdiction: JURISDICTION },
          accounts: new Map(),
          profile: { name: 'H1', isHub: true },
        },
      },
    ],
  ]);

  const projection = buildHubDiscoveryProjection({
    entityId: SOURCE,
    runtimeId: RUNTIME,
    replicas: replicas as never,
  });

  expect(projection.localHubs[0]?.isConnected).toBe(false);
  expect(projection.localHubs[0]?.isOpening).toBe(true);
});
