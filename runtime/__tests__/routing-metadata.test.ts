import { describe, expect, test } from 'bun:test';
import type { Profile } from '../networking/gossip';
import { parseProfile } from '../networking/gossip';
import { buildNetworkGraph } from '../routing/graph';
import { PathFinder } from '../routing/pathfinding';

const TOKEN_ID = 1;
const AMOUNT = 555_000_000_000_000_000_000n;

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const H1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
const H2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
const MALFORMED_HUB = '0x3333333333333333333333333333333333333333333333333333333333333333';

const caps = (out: bigint, inn: bigint) => ({
  [TOKEN_ID]: {
    outCapacity: out.toString(),
    inCapacity: inn.toString(),
  },
});

function profile(
  entityId: string,
  runtimeId: string,
  metadata: Profile['metadata'],
  accounts: Array<{ counterpartyId: string; tokenCapacities: ReturnType<typeof caps> }>
): Profile {
  return {
    entityId,
    runtimeId,
    name: entityId,
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: 1,
    runtimeEncPubKey: `0x${entityId.slice(2, 66)}`,
    publicAccounts: accounts.map((account) => account.counterpartyId),
    wsUrl: null,
    relays: [],
    metadata,
    accounts,
  };
}

describe('Routing metadata hard requirements', () => {
  test('rejects dead legacy metadata.position field', () => {
    expect(() => parseProfile({
      entityId: ALICE,
      runtimeId: ALICE.slice(0, 42),
      name: 'Alice',
      avatar: '',
      bio: '',
      website: '',
      lastUpdated: 1,
      runtimeEncPubKey: `0x${'aa'.repeat(32)}`,
      publicAccounts: [],
      wsUrl: null,
      relays: [],
      metadata: {
        entityEncPubKey: `0x${'ab'.repeat(32)}`,
        routingFeePPM: 10_000,
        baseFee: '0',
        isHub: false,
        position: { x: 1, y: 2, z: 3 },
        board: {
          threshold: 1,
          validators: [{ signer: ALICE.slice(0, 42), signerId: ALICE.slice(0, 42), weight: 1, publicKey: 'board:alice' }],
        },
      },
      accounts: [],
    })).toThrow(/GOSSIP_PROFILE_METADATA_UNKNOWN_FIELD/);
  });

  test('drops malformed hub profile and never routes through it', () => {
    const high = 10_000_000_000_000_000_000_000n;
    const profiles = new Map<string, Profile>([
      [
        ALICE,
        {
          entityId: ALICE,
          runtimeId: ALICE.slice(0, 42),
          name: 'Alice',
          avatar: '',
          bio: '',
          website: '',
          lastUpdated: 1,
          runtimeEncPubKey: `0x${'aa'.repeat(32)}`,
          publicAccounts: [H1],
          wsUrl: null,
          relays: [],
          metadata: {
            entityEncPubKey: `0x${'ab'.repeat(32)}`,
            routingFeePPM: 10_000,
            baseFee: 0n,
            isHub: false,
            board: {
              threshold: 1,
              validators: [{ signer: ALICE.slice(0, 42), signerId: ALICE.slice(0, 42), weight: 1, publicKey: 'board:alice' }],
            },
          },
          accounts: [{ counterpartyId: H1, tokenCapacities: caps(high, high) }],
        },
      ],
      [
        H1,
        profile(
          H1,
          H1.slice(0, 42),
          {
            entityEncPubKey: `0x${'11'.repeat(32)}`,
            routingFeePPM: 10_000,
            baseFee: 0n,
            isHub: true,
            board: {
              threshold: 1,
              validators: [{ signer: H1.slice(0, 42), signerId: H1.slice(0, 42), weight: 1, publicKey: 'board:h1' }],
            },
          },
          [
            { counterpartyId: H2, tokenCapacities: caps(high, high) },
            { counterpartyId: MALFORMED_HUB, tokenCapacities: caps(high, high) },
          ]
        ),
      ],
      [
        H2,
        profile(
          H2,
          H2.slice(0, 42),
          {
            entityEncPubKey: `0x${'22'.repeat(32)}`,
            routingFeePPM: 10_000,
            baseFee: 0n,
            isHub: true,
            board: {
              threshold: 1,
              validators: [{ signer: H2.slice(0, 42), signerId: H2.slice(0, 42), weight: 1, publicKey: 'board:h2' }],
            },
          },
          [{ counterpartyId: BOB, tokenCapacities: caps(high, high) }]
        ),
      ],
      [
        MALFORMED_HUB,
        // Missing name + routingFeePPM on purpose.
        profile(
          MALFORMED_HUB,
          MALFORMED_HUB.slice(0, 42),
          {
            entityEncPubKey: `0x${'33'.repeat(32)}`,
            baseFee: 0n,
            isHub: true,
            board: {
              threshold: 1,
              validators: [{
                signer: MALFORMED_HUB.slice(0, 42),
                signerId: MALFORMED_HUB.slice(0, 42),
                weight: 1,
                publicKey: 'board:bad',
              }],
            },
          } as Profile['metadata'],
          [{ counterpartyId: H2, tokenCapacities: caps(high, high) }]
        ),
      ],
      [
        BOB,
        {
          entityId: BOB,
          runtimeId: BOB.slice(0, 42),
          name: 'Bob',
          avatar: '',
          bio: '',
          website: '',
          lastUpdated: 1,
          runtimeEncPubKey: `0x${'bb'.repeat(32)}`,
          publicAccounts: [],
          wsUrl: null,
          relays: [],
          metadata: {
            entityEncPubKey: `0x${'bc'.repeat(32)}`,
            routingFeePPM: 10_000,
            baseFee: 0n,
            isHub: false,
            board: {
              threshold: 1,
              validators: [{ signer: BOB.slice(0, 42), signerId: BOB.slice(0, 42), weight: 1, publicKey: 'board:bob' }],
            },
          },
          accounts: [],
        },
      ],
    ]);

    const graph = buildNetworkGraph(profiles, TOKEN_ID);
    expect(graph.edges.has(MALFORMED_HUB)).toBe(false);

    const finder = new PathFinder(graph);
    const routes = finder.findRoutes(ALICE, BOB, AMOUNT, TOKEN_ID, 10);

    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0]?.path).toEqual([ALICE, H1, H2, BOB]);
    for (const route of routes) {
      expect(route.path.includes(MALFORMED_HUB)).toBe(false);
    }
  });
});
