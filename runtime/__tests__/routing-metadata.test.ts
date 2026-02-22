import { describe, expect, test } from 'bun:test';
import type { Profile } from '../networking/gossip';
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
  metadata: Record<string, unknown>,
  accounts: Array<{ counterpartyId: string; tokenCapacities: ReturnType<typeof caps> }>
): Profile {
  return {
    entityId,
    capabilities: ['hub', 'routing'],
    metadata: metadata as any,
    accounts: accounts as any,
  };
}

describe('Routing metadata hard requirements', () => {
  test('drops malformed hub profile and never routes through it', () => {
    const high = 10_000_000_000_000_000_000_000n;
    const profiles = new Map<string, Profile>([
      [
        ALICE,
        {
          entityId: ALICE,
          capabilities: [],
          metadata: { name: 'Alice', routingFeePPM: 10_000, isHub: false },
          accounts: [{ counterpartyId: H1, tokenCapacities: caps(high, high) }] as any,
        },
      ],
      [
        H1,
        profile(
          H1,
          { name: 'H1', routingFeePPM: 10_000, isHub: true },
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
          { name: 'H2', routingFeePPM: 10_000, isHub: true },
          [{ counterpartyId: BOB, tokenCapacities: caps(high, high) }]
        ),
      ],
      [
        MALFORMED_HUB,
        // Missing name + routingFeePPM on purpose.
        profile(
          MALFORMED_HUB,
          { isHub: true },
          [{ counterpartyId: H2, tokenCapacities: caps(high, high) }]
        ),
      ],
      [
        BOB,
        {
          entityId: BOB,
          capabilities: [],
          metadata: { name: 'Bob', routingFeePPM: 10_000, isHub: false },
          accounts: [] as any,
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

