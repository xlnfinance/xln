/**
 * Runtime creation of the `proposeAccountsNow` recovery marker.
 *
 * The marker is created only on the offline -> online edge for a peer runtime
 * that still owes us an ACK, only for the local proposer replica, and only
 * once. It carries no authority of its own: external ingress is rejected.
 */
import { describe, expect, test } from 'bun:test';

import { initCrontab } from '../../../entity/scheduler';
import { createEmptyEnv } from '../../../runtime';
import { installJurisdictions, makeAccount, makeJurisdiction } from '../../helpers/cross-j';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import {
  assertProposeAccountsNowTxAuthorized,
  createProposeAccountsNowInputs,
  enqueuePeerReadyProposeAccountsNow,
} from '../../../runtime/mempool/propose-accounts-now';
import { MAX_PROPOSE_ACCOUNTS_NOW_COUNTERPARTIES } from '../../../entity/consensus/account/propose-accounts-now-validation';
import type { EntityReplica, EntityState } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { AccountInput } from '../../../types/account';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const addr20 = (byte: string): string => `0x${byte.repeat(20)}`;

const HUB = entityId('a1');
const PEER = entityId('b2');
const OTHER_HOST_PEER = entityId('c3');
const PROPOSER = addr20('d4');
const FOLLOWER = addr20('d5');
const PEER_RUNTIME = addr20('e6').toLowerCase();
const OTHER_RUNTIME = addr20('e7').toLowerCase();

const jurisdiction = makeJurisdiction('ProposeAccountsNowRuntimeTest', 31_337, '91', '92');

const makeState = (proposer: string, timestamp: number): EntityState => ({
  entityId: HUB,
  entityEncryptionPublicKey: '',
  height: 0,
  timestamp,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [proposer],
    shares: { [proposer]: 1n },
    jurisdiction,
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(HUB, computeEntityAccountValueHash),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: { name: 'propose-accounts-now-runtime', isHub: true, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
  swapTradingPairs: [],
  crontabState: initCrontab(),
});

/** A retained, already-signed proposal that the peer never acknowledged. */
const retainedProposal = (counterparty: string): Extract<AccountInput, { kind: 'ack_frame' }> => ({
  kind: 'ack_frame',
  fromEntityId: HUB,
  toEntityId: counterparty,
  domain: { chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress },
  disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  proposal: {
    frame: {
      height: 1,
      timestamp: 1_000,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: `0x${'00'.repeat(32)}`,
      accountStateRoot: `0x${'11'.repeat(32)}`,
      stateHash: `0x${'22'.repeat(32)}`,
    },
    frameHanko: `0x${'33'.repeat(65)}`,
  },
});

const withPendingAccount = (state: EntityState, counterparty: string, pending: boolean): void => {
  if (!(state.accounts instanceof PersistentEntityAccountMap)) throw new Error('TEST_ACCOUNTS_NOT_COMMITTED_GRAPH');
  const account = makeAccount(HUB, counterparty, jurisdiction);
  if (pending) {
    account.pendingFrame = { ...account.currentFrame, height: 1 };
    account.pendingAccountInput = retainedProposal(counterparty);
  }
  state.accounts = state.accounts.updated(counterparty, account);
};

const makeReplica = (state: EntityState, signerId: string): EntityReplica => ({
  entityId: state.entityId,
  signerId,
  state,
  mempool: [],
  isProposer: state.config.validators[0] === signerId,
});

type Fixture = Readonly<{ env: RuntimeReplica; state: EntityState; replica: EntityReplica }>;

const fixture = (label: string, signerId = PROPOSER): Fixture => {
  const env = createEmptyEnv(label);
  env.state.timestamp = 1_000;
  env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
  installJurisdictions(env, jurisdiction);
  const state = makeState(PROPOSER, 1_000);
  withPendingAccount(state, PEER, true);
  const replica = makeReplica(state, signerId);
  env.state.eReplicas.set(`${HUB}:${signerId}`, replica);
  env.infrastructure = env.infrastructure ?? {};
  env.infrastructure.verifiedProfileRoutes = new Map([
    [PEER.toLowerCase(), {
      runtimeId: PEER_RUNTIME,
      runtimeSignerId: PEER_RUNTIME,
      runtimeEncPubKey: `0x${'44'.repeat(32)}`,
      lastUpdated: 1_000,
    }],
    [OTHER_HOST_PEER.toLowerCase(), {
      runtimeId: OTHER_RUNTIME,
      runtimeSignerId: OTHER_RUNTIME,
      runtimeEncPubKey: `0x${'45'.repeat(32)}`,
      lastUpdated: 1_000,
    }],
  ]);
  return { env, state, replica };
};

describe('runtime proposeAccountsNow', () => {
  test('creates exactly one marker for the peer runtime that owes an ACK', () => {
    const { env } = fixture('propose-accounts-now-create');

    const inputs = createProposeAccountsNowInputs(env, PEER_RUNTIME);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      entityId: HUB,
      signerId: PROPOSER,
      entityTxs: [{
        type: 'proposeAccountsNow',
        data: { version: 1, proposerSignerId: PROPOSER, counterparties: [PEER.toLowerCase()] },
      }],
    });
    expect(MAX_PROPOSE_ACCOUNTS_NOW_COUNTERPARTIES).toBeGreaterThan(0);
  });

  test('creates nothing for an unrelated peer runtime or a settled account', () => {
    const settled = fixture('propose-accounts-now-settled');
    expect(createProposeAccountsNowInputs(settled.env, OTHER_RUNTIME)).toEqual([]);

    const clean = fixture('propose-accounts-now-clean');
    withPendingAccount(clean.state, PEER, false);
    expect(createProposeAccountsNowInputs(clean.env, PEER_RUNTIME)).toEqual([]);
  });

  test('creates nothing for a replica that is not the active leader', () => {
    const follower = fixture('propose-accounts-now-follower', FOLLOWER);
    expect(createProposeAccountsNowInputs(follower.env, PEER_RUNTIME)).toEqual([]);
  });

  test('enqueues once on the offline -> online edge and never duplicates', () => {
    const { env, replica } = fixture('propose-accounts-now-edge');

    // A readiness edge to offline is not a recovery trigger.
    enqueuePeerReadyProposeAccountsNow(env, PEER_RUNTIME, false);
    expect(env.runtimeMempool?.entityInputs).toEqual([]);

    enqueuePeerReadyProposeAccountsNow(env, PEER_RUNTIME, true);
    expect(env.runtimeMempool?.entityInputs).toHaveLength(1);

    // A second edge while the first marker is still queued adds nothing.
    enqueuePeerReadyProposeAccountsNow(env, PEER_RUNTIME, true);
    expect(env.runtimeMempool?.entityInputs).toHaveLength(1);

    // Nor while it is waiting in the replica mempool.
    const queued = env.runtimeMempool!.entityInputs[0]!;
    env.runtimeMempool!.entityInputs = [];
    replica.mempool.push(queued.entityTxs![0]!);
    enqueuePeerReadyProposeAccountsNow(env, PEER_RUNTIME, true);
    expect(env.runtimeMempool?.entityInputs).toEqual([]);
  });

  test('a second peer online in the same frame gets its own marker', () => {
    // Deduping by replica alone hid the second peer: a queued marker for the
    // first peer made the second peer's retained proposals never re-sent.
    const { env, state } = fixture('propose-accounts-now-two-peers');
    withPendingAccount(state, OTHER_HOST_PEER, true);

    enqueuePeerReadyProposeAccountsNow(env, PEER_RUNTIME, true);
    enqueuePeerReadyProposeAccountsNow(env, OTHER_RUNTIME, true);
    enqueuePeerReadyProposeAccountsNow(env, OTHER_RUNTIME, true);

    const markers = env.runtimeMempool!.entityInputs.map(input => {
      const tx = input.entityTxs?.[0];
      return tx?.type === 'proposeAccountsNow' ? tx.data.counterparties : [];
    });
    expect(markers).toEqual([[PEER.toLowerCase()], [OTHER_HOST_PEER.toLowerCase()]]);
  });

  test('rejects the same marker arriving from an external peer', () => {
    const { env } = fixture('propose-accounts-now-authorization');
    const [input] = createProposeAccountsNowInputs(env, PEER_RUNTIME);
    const local = input?.entityTxs?.[0];
    if (!local) throw new Error('TEST_PROPOSE_ACCOUNTS_NOW_MISSING');

    // Locally authored: allowed.
    expect(() => assertProposeAccountsNowTxAuthorized(local, false)).not.toThrow();
    // The same bytes without the local marker are forged external authority.
    const external = structuredClone(local);
    expect(() => assertProposeAccountsNowTxAuthorized(external, false)).toThrow(
      'PROPOSE_ACCOUNTS_NOW_EXTERNAL_INGRESS_REJECTED',
    );
    // Replay reads committed WAL bytes, where the local marker is always gone.
    expect(() => assertProposeAccountsNowTxAuthorized(external, true)).not.toThrow();
  });
});
