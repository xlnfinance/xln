import { expect, test } from 'bun:test';

import {
  hasUsableOpenAccountCounterpartyProfile,
  hasCounterpartyRuntimeRoute,
  prewarmCounterpartyProfiles,
  waitForOpenAccountCounterpartyProfiles,
  waitForCounterpartyRuntimeRoutes,
} from '../../frontend/src/lib/utils/p2pPrefetch';

const SOURCE = `0x${'11'.repeat(32)}`;
const SIGNER = `0x${'22'.repeat(20)}`;
const COUNTERPARTY = `0x${'33'.repeat(32)}`;
const TRON_JURISDICTION = {
  name: 'Tron Testnet',
  chainId: 31338,
  depositoryAddress: `0x${'44'.repeat(20)}`,
};

function envWithSourceJurisdiction(extra: Record<string, unknown> = {}) {
  return {
    eReplicas: new Map([
      [`${SOURCE}:${SIGNER}`, {
        state: {
          entityId: SOURCE,
          config: { jurisdiction: TRON_JURISDICTION },
        },
      }],
    ]),
    ...extra,
  };
}

test('prewarmCounterpartyProfiles forwards unique normalized entity ids to runtime p2p', async () => {
  let seen: string[] = [];
  const env = {
    runtimeState: {
      p2p: {
        ensureProfiles: async (entityIds: string[]) => {
          seen = [...entityIds];
          return true;
        },
      },
    },
  };

  const ready = await prewarmCounterpartyProfiles(env as never, [
    ' 0xAbc ',
    '0xabc',
    '',
    '0xDEF',
  ]);

  expect(ready).toBe(true);
  expect(seen).toEqual(['0xabc', '0xdef']);
});

test('prewarmCounterpartyProfiles degrades cleanly when runtime p2p is unavailable', async () => {
  await expect(prewarmCounterpartyProfiles(null, ['0xabc'])).resolves.toBe(false);
  await expect(prewarmCounterpartyProfiles({ runtimeState: {} } as never, ['0xabc'])).resolves.toBe(false);
});

test('waitForCounterpartyRuntimeRoutes requires a gossip runtime id', async () => {
  const profiles: Array<{ entityId: string; runtimeId?: string }> = [];
  const env = {
    gossip: {
      getProfiles: () => profiles,
    },
    runtimeState: {
      p2p: {
        ensureProfiles: async (entityIds: string[]) => {
          profiles.push({ entityId: entityIds[0]!, runtimeId: '0xruntime' });
          return true;
        },
      },
    },
  };

  await expect(waitForCounterpartyRuntimeRoutes(env as never, [' 0xAbc '], 200)).resolves.toBe(true);
  expect(hasCounterpartyRuntimeRoute(env as never, '0xabc')).toBe(true);
});

test('waitForCounterpartyRuntimeRoutes rejects profiles without runtime routes', async () => {
  const env = {
    gossip: {
      getProfiles: () => [{ entityId: '0xabc' }],
    },
    runtimeState: {
      p2p: {
        ensureProfiles: async () => true,
      },
    },
  };

  await expect(waitForCounterpartyRuntimeRoutes(env as never, ['0xabc'], 100)).resolves.toBe(false);
  expect(hasCounterpartyRuntimeRoute(env as never, '0xabc')).toBe(false);
});

test('openAccount profile readiness requires target jurisdiction metadata', async () => {
  const env = envWithSourceJurisdiction({
    gossip: {
      getProfiles: () => [{
        entityId: COUNTERPARTY,
        runtimeId: `0x${'55'.repeat(20)}`,
        metadata: { isHub: true },
      }],
    },
    runtimeState: {
      p2p: {
        ensureProfiles: async () => true,
      },
    },
  });
  const input = {
    entityId: SOURCE,
    signerId: SIGNER,
    entityTxs: [{ type: 'openAccount', data: { targetEntityId: COUNTERPARTY } }],
  };

  expect(hasUsableOpenAccountCounterpartyProfile(env as never, SOURCE, COUNTERPARTY, { requireHub: true })).toBe(false);
  await expect(waitForOpenAccountCounterpartyProfiles(env as never, [input] as never, 100)).resolves.toBe(false);
});

test('openAccount profile readiness accepts same-jurisdiction target profiles', async () => {
  const env = envWithSourceJurisdiction({
    gossip: {
      getProfiles: () => [{
        entityId: COUNTERPARTY,
        runtimeId: `0x${'55'.repeat(20)}`,
        metadata: {
          isHub: true,
          jurisdiction: TRON_JURISDICTION,
        },
      }],
    },
    runtimeState: {
      p2p: {
        ensureProfiles: async () => true,
      },
    },
  });
  const input = {
    entityId: SOURCE,
    signerId: SIGNER,
    entityTxs: [{ type: 'openAccount', data: { targetEntityId: COUNTERPARTY } }],
  };

  expect(hasUsableOpenAccountCounterpartyProfile(env as never, SOURCE, COUNTERPARTY, { requireHub: true })).toBe(true);
  await expect(waitForOpenAccountCounterpartyProfiles(env as never, [input] as never, 100)).resolves.toBe(true);
});
