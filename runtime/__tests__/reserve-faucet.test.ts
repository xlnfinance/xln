import { describe, expect, test } from 'bun:test';

import type { JAdapter } from '../jadapter';
import { handleReserveFaucet, parseReserveFaucetAmount } from '../server/reserve-faucet';
import type { Env, RuntimeInput } from '../types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const signer = (byte: string): string => `0x${byte.repeat(20)}`;

const HUB = entity('11');
const USER = entity('22');
const HUB_SIGNER = signer('33');

const makeAdapter = (): JAdapter => ({
  mode: 'browservm',
  chainId: 31337,
  getReserves: async () => 0n,
} as unknown as JAdapter);

const makeEnv = (options: {
  activeHubProfile?: boolean;
  hubReserve?: bigint;
} = {}): Env => ({
  eReplicas: new Map([
    [`${HUB}:${HUB_SIGNER}`, {
      entityId: HUB,
      signerId: HUB_SIGNER,
      isProposer: true,
      mempool: [],
      state: {
        entityId: HUB,
        reserves: new Map([[1, options.hubReserve ?? 0n]]),
        accounts: new Map(),
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [HUB_SIGNER],
          shares: { [HUB_SIGNER]: 1n },
        },
      },
    }],
  ]),
  gossip: {
    getProfiles: () => options.activeHubProfile === false
      ? []
      : [{
        entityId: HUB,
        metadata: {
          isHub: true,
          board: { validators: [{ signerId: HUB_SIGNER }] },
        },
      }],
  },
} as unknown as Env);

const callReserveFaucet = async (options: {
  adapter?: JAdapter | null;
  activeHubEntityIds?: string[];
  amount?: string;
  env?: Env | null;
  tokenCatalog?: Array<{ tokenId: number; symbol: string; decimals: number }>;
  tokenId?: number | string;
} = {}): Promise<{ response: Response; body: Record<string, unknown>; enqueued: RuntimeInput[] }> => {
  const enqueued: RuntimeInput[] = [];
  const response = await handleReserveFaucet({
    req: new Request('http://xln.local/api/faucet/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userEntityId: USER,
        tokenId: options.tokenId ?? 1,
        amount: options.amount ?? '100',
      }),
    }),
    env: options.env === undefined ? makeEnv() : options.env,
    headers: { 'content-type': 'application/json' },
    relayStore: { activeHubEntityIds: options.activeHubEntityIds ?? [HUB] },
    getJAdapter: () => options.adapter === undefined ? makeAdapter() : options.adapter,
    ensureTokenCatalog: async () => options.tokenCatalog ?? [{ tokenId: 1, symbol: 'USDC', decimals: 6 }],
    enqueueRuntimeInput: (_env, runtimeInput) => {
      enqueued.push(runtimeInput);
    },
  });
  return { response, body: await response.json(), enqueued };
};

describe('reserve faucet failures', () => {
  test('parses human amounts with trusted token decimals', () => {
    expect(parseReserveFaucetAmount('100', { tokenId: 1, decimals: 6 })).toBe(100n * 10n ** 6n);
    expect(parseReserveFaucetAmount('100', { tokenId: 2, decimals: 18 })).toBe(100n * 10n ** 18n);
    expect(() => parseReserveFaucetAmount('100', { tokenId: 9, decimals: null }))
      .toThrow('FAUCET_TOKEN_DECIMALS_INVALID:9:null');
  });

  test('reports typed transient failure when j-adapter is unavailable', async () => {
    const { response, body, enqueued } = await callReserveFaucet({ adapter: null });

    expect(response.status).toBe(503);
    expect(body.error).toBe('J-adapter not initialized');
    expect(body.code).toBe('FAUCET_J_ADAPTER_NOT_INITIALIZED');
    expect(body.category).toBe('TransientRace');
    expect(body.retryable).toBe(true);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'TransientRace',
      code: 'FAUCET_J_ADAPTER_NOT_INITIALIZED',
      retryable: true,
      fatal: false,
    });
    expect(enqueued).toHaveLength(0);
  });

  test('reports typed contradiction for invalid token id', async () => {
    const { response, body, enqueued } = await callReserveFaucet({ tokenId: 'not-a-number' });

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid tokenId');
    expect(body.code).toBe('FAUCET_INVALID_TOKEN_ID');
    expect(body.category).toBe('Contradiction');
    expect(body.retryable).toBe(false);
    expect(body.fatal).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  test('reports typed transient failure when no faucet hub is visible', async () => {
    const { response, body, enqueued } = await callReserveFaucet({
      activeHubEntityIds: [],
      env: makeEnv({ activeHubProfile: false }),
    });

    expect(response.status).toBe(503);
    expect(body.error).toBe('No faucet hub available');
    expect(body.code).toBe('FAUCET_HUBS_EMPTY');
    expect(body.category).toBe('TransientRace');
    expect(body.retryable).toBe(true);
    expect(body.fatal).toBe(false);
    expect(body.activeHubEntityIds).toEqual([]);
    expect(enqueued).toHaveLength(0);
  });

  test('reports typed expected-empty failure when hub reserves are insufficient', async () => {
    const { response, body, enqueued } = await callReserveFaucet({
      env: makeEnv({ hubReserve: 99n * 10n ** 6n }),
      tokenCatalog: [{ tokenId: 1, symbol: 'USDC', decimals: 6 }],
    });

    expect(response.status).toBe(409);
    expect(body.error).toBe('Hub has insufficient reserves for token 1');
    expect(body.code).toBe('FAUCET_HUB_INSUFFICIENT_RESERVES');
    expect(body.category).toBe('ExpectedEmpty');
    expect(body.retryable).toBe(false);
    expect(body.fatal).toBe(false);
    expect(body.have).toBe((99n * 10n ** 6n).toString());
    expect(body.need).toBe((100n * 10n ** 6n).toString());
    expect(enqueued).toHaveLength(0);
  });
});
