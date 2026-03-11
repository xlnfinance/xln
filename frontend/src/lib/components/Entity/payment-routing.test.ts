import { describe, expect, test } from 'bun:test';
import type { Delta, Profile as GossipProfile } from '@xln/runtime/xln-api';
import {
  extractEntityEncPubKey,
  getDirectionalEdgeCapacity,
  type DeriveDeltaFn,
  type LocalReplicaLike,
} from './payment-routing';

const makeDelta = (tokenId: number, outCapacity: bigint, inCapacity: bigint): Delta => ({
  tokenId,
  collateral: 0n,
  ondelta: inCapacity,
  offdelta: outCapacity,
  leftCreditLimit: 0n,
  rightCreditLimit: 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
});

const deriveFromDelta: DeriveDeltaFn = (delta) => ({
  delta: 0n,
  collateral: delta.collateral,
  inCollateral: 0n,
  outCollateral: 0n,
  inOwnCredit: delta.ondelta,
  outOwnCredit: delta.offdelta,
  inPeerCredit: 0n,
  outPeerCredit: 0n,
  inAllowance: 0n,
  outAllowance: 0n,
  inCapacity: delta.ondelta,
  outCapacity: delta.offdelta,
  totalCapacity: delta.ondelta + delta.offdelta,
  ownCreditLimit: 0n,
  peerCreditLimit: 0n,
  peerCreditUsed: 0n,
  ownCreditUsed: 0n,
  outTotalHold: 0n,
  inTotalHold: 0n,
  ascii: '',
});

const makeProfile = (
  entityId: string,
  counterpartyId: string,
  capacities: { inCapacity: string; outCapacity: string },
  entityEncPubKey: string,
): GossipProfile => ({
  entityId,
  name: entityId,
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  runtimeId: '0xruntime',
  runtimeEncPubKey: '0x' + '22'.repeat(32),
  publicAccounts: [counterpartyId],
  endpoints: [],
  relays: [],
  metadata: {
    entityEncPubKey,
    isHub: true,
    routingFeePPM: 100,
    baseFee: 0n,
    board: {
      threshold: 1,
      validators: [
        {
          signer: '0x' + '11'.repeat(20),
          signerId: '0x' + '11'.repeat(20),
          weight: 1,
          publicKey: '0x' + '33'.repeat(65),
        },
      ],
    },
  },
  accounts: [
    {
      counterpartyId,
      tokenCapacities: {
        '1': capacities,
      },
    },
  ],
});

describe('payment routing helpers', () => {
  test('prefers local replica capacity over stale gossip for own runtime', () => {
    const owner = '0x' + 'aa'.repeat(32);
    const hub = '0x' + 'bb'.repeat(32);
    const replicas = new Map<string, LocalReplicaLike>([
      [
        `${owner}:signer`,
        {
          state: {
            entityEncPubKey: '0x' + '44'.repeat(32),
            accounts: new Map([
              [
                hub,
                {
                  leftEntity: owner,
                  rightEntity: hub,
                  deltas: new Map([[1, makeDelta(1, 5n, 0n)]]),
                },
              ],
            ]),
          },
        },
      ],
    ]);
    const profiles: GossipProfile[] = [
      makeProfile(owner, hub, { inCapacity: '0', outCapacity: '0' }, '0x' + '55'.repeat(32)),
      makeProfile(hub, owner, { inCapacity: '9', outCapacity: '9' }, '0x' + '66'.repeat(32)),
    ];

    const capacity = getDirectionalEdgeCapacity(replicas, profiles, deriveFromDelta, owner, hub, 1);
    expect(capacity).toBe(5n);
  });

  test('prefers local entity encryption key over gossip cache', () => {
    const owner = '0x' + 'aa'.repeat(32);
    const hub = '0x' + 'bb'.repeat(32);
    const localKey = '0x' + '77'.repeat(32);
    const replicas = new Map<string, LocalReplicaLike>([
      [
        `${owner}:signer`,
        {
          state: {
            entityEncPubKey: localKey,
            accounts: new Map(),
          },
        },
      ],
    ]);
    const profiles: GossipProfile[] = [
      makeProfile(owner, hub, { inCapacity: '0', outCapacity: '0' }, '0x' + '88'.repeat(32)),
    ];

    expect(extractEntityEncPubKey(replicas, profiles, owner)).toBe(localKey);
  });
});
