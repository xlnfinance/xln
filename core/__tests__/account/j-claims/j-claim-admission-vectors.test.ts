/**
 * FX-3 (proofs/fixes.md, decision D4): the four mandatory j-claim vectors —
 * committed conflict, two conflicts in one batch, exact duplicate, stale
 * admitted claim after an incoming frame — over a real two-replica bilateral
 * Account driven by the production consensus functions.
 *
 * Verdict parity: every code/message/disposition asserted here is the exact
 * vocabulary asserted by the Rust twin
 * rscore/crates/engine/tests/fx3_j_claim_admission.rs:
 * `ACCOUNT_J_CLAIM_{LEFT|RIGHT}_CONFLICT:{side}:{height}`,
 * `ACCOUNT_J_CLAIM_QUEUED_CONFLICT:{height}`, admission code
 * `ACCOUNT_TX_VALIDATION`, drop disposition `removed`.
 */
import { describe, expect, test } from 'bun:test';

import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import { isProposedAccountFrame } from '../../../account/consensus/result';
import type {
  AccountConsensusHashToSign,
  ProposeAccountFrameResult,
} from '../../../account/consensus/types';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { cacheCommittedAccountJClaimNodeChanges } from '../../../entity/account/account-j-claim-node-store';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { signEntityHashes } from '../../../hanko/signing';
import { isLeftEntity } from '../../../account/utils';
import { createEmptyEnv } from '../../../runtime';
import type {
  AccountInput,
  AccountPeerInput,
  AccountReplica,
  AccountTx,
} from '../../../types/account';
import type { RuntimeReplica } from '../../../runtime/types';
import type { EntityState } from '../../../entity/types';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { installJurisdictions, makeAccount, makeJurisdiction, makeState } from '../../helpers/cross-j';

const RUNTIME_SEED = 'fx3-j-claim-admission-vectors';
const CHAIN = { name: 'fx3-j', chainId: 31_337, depository: 'dd', provider: 'ee' } as const;
const STEP_MS = 1_000;
type Side = 'alpha' | 'beta';
const PEER_OF: Record<Side, Side> = { alpha: 'beta', beta: 'alpha' };

type SideRecord = Readonly<{
  entityId: string;
  signerId: string;
  state: EntityState;
  accounts: PersistentEntityAccountMap;
}>;

/**
 * Minimal bilateral harness over the real consensus stack — the same shape as
 * the proofs/C2 `BilateralHarness`, kept local so this file stays a narrow L1
 * vector suite.
 */
class VectorHarness {
  readonly env: RuntimeReplica = createEmptyEnv(RUNTIME_SEED);
  readonly sides: Record<Side, SideRecord>;
  readonly proposals: Partial<Record<Side, AccountInput>> = {};
  readonly ackDrafts: Partial<Record<Side, {
    accountInput: AccountPeerInput;
    hashesToSign: readonly AccountConsensusHashToSign[];
  }>> = {};
  private readonly witnesses: Record<Side, Map<string, string>> = {
    alpha: new Map(),
    beta: new Map(),
  };
  private clock = 1_000;

  constructor() {
    this.env.quietRuntimeLogs = true;
    const jurisdiction = makeJurisdiction(CHAIN.name, CHAIN.chainId, CHAIN.depository, CHAIN.provider);
    installJurisdictions(this.env, jurisdiction);
    this.sides = {
      alpha: this.makeSideRecord('alpha', jurisdiction),
      beta: this.makeSideRecord('beta', jurisdiction),
    };
    for (const side of ['alpha', 'beta'] as const) this.commit(side, this.genesis(side));
    if (this.committed('alpha').currentFrame.stateHash !== this.committed('beta').currentFrame.stateHash) {
      throw new Error('HARNESS_GENESIS_DIVERGENT');
    }
  }

  /** The side of this harness's account that `side`'s entity occupies. */
  entitySide(side: Side): 'left' | 'right' {
    return isLeftEntity(this.sides[side].entityId, this.sides[PEER_OF[side]].entityId) ? 'left' : 'right';
  }

  committed(side: Side): AccountReplica {
    const account = this.sides[side].accounts.get(this.sides[PEER_OF[side]].entityId);
    if (!account) throw new Error(`HARNESS_ACCOUNT_MISSING:${side}`);
    return account;
  }

  private context(): AccountConsensusContext {
    return createAccountConsensusContext(this.env);
  }

  private security() {
    return { entityTimestamp: this.clock, finalizedJHeight: 0, owningEntityIsHub: false };
  }

  private async certifyManifest(side: Side, manifest: readonly AccountConsensusHashToSign[]): Promise<void> {
    if (manifest.length === 0) return;
    const hankos = await signEntityHashes(
      this.env,
      this.sides[side].entityId,
      this.sides[side].signerId,
      manifest.map(entry => entry.hash),
    );
    const cache = this.witnesses[side];
    manifest.forEach((entry, index) => cache.set(entry.hash.toLowerCase(), hankos[index]!));
  }

  private requireWitness(side: Side, hash: string | undefined): string {
    if (hash === undefined) throw new Error('HARNESS_WITNESS_HASH_MISSING');
    const hanko = this.witnesses[side].get(hash.toLowerCase());
    if (!hanko) throw new Error('HARNESS_WITNESS_UNDECLARED');
    return hanko;
  }

  private attachHankos(side: Side, input: AccountInput): AccountInput {
    const signed = structuredClone(input);
    const attach = (value: AccountInput): void => {
      if (value.kind === 'ack' || value.kind === 'ack_frame') {
        value.ack.frameHanko = value.ack.frameHanko ?? this.requireWitness(side, value.ack.frameHash);
        if (value.ack.disputeHanko) {
          value.ack.disputeHanko.hanko = value.ack.disputeHanko.hanko
            ?? this.requireWitness(side, value.ack.disputeHanko.hash);
        }
      }
      if (value.kind === 'frame' || value.kind === 'ack_frame') {
        value.proposal.frameHanko = value.proposal.frameHanko
          ?? this.requireWitness(side, value.proposal.frame.stateHash);
        if (value.proposal.disputeHanko) {
          value.proposal.disputeHanko.hanko = value.proposal.disputeHanko.hanko
            ?? this.requireWitness(side, value.proposal.disputeHanko.hash);
        }
      }
    };
    attach(signed);
    return signed;
  }

  private async collectReceiverResult(side: Side, result: Awaited<ReturnType<typeof applyAccountInput>>): Promise<void> {
    if (!result.ok) return;
    // Entity commit boundary: the session's J-claim accumulator nodes become
    // durable exactly when the frame's AccountInput result is committed.
    cacheCommittedAccountJClaimNodeChanges(this.env, result.accountJClaimNodeChanges);
    await this.certifyManifest(side, result.hashesToSign ?? []);
    if (result.response && result.hashesToSign && result.hashesToSign.length > 0) {
      this.ackDrafts[side] = {
        accountInput: this.attachHankos(side, result.response),
        hashesToSign: result.hashesToSign,
      };
    }
  }

  private shell(side: Side): AccountReplica {
    return forkAccountReplicaShell(this.committed(side));
  }

  private commit(side: Side, account: AccountReplica): void {
    const record = this.sides[side];
    record.accounts = record.accounts.updated(this.sides[PEER_OF[side]].entityId, account);
    record.state.accounts = record.accounts;
  }

  private genesis(side: Side): AccountReplica {
    const account = makeAccount(
      this.sides[side].entityId,
      this.sides[PEER_OF[side]].entityId,
      { chainId: CHAIN.chainId, depositoryAddress: `0x${CHAIN.depository.repeat(20)}` },
    );
    return account;
  }

  private makeSideRecord(slot: Side, jurisdiction: ReturnType<typeof makeJurisdiction>): SideRecord {
    const signerId = deriveSignerAddressSync(RUNTIME_SEED, slot).toLowerCase();
    registerSignerKey(this.env, signerId, deriveSignerKeySync(RUNTIME_SEED, slot));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    return {
      entityId,
      signerId,
      state: makeState(entityId, signerId, jurisdiction),
      accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
    };
  }

  /** Claim bytes are a pure function of (jHeight, blockByte): the same triple
   * means the same evidence in both engines. */
  buildClaimTx(jHeight: number, blockByte: number): Extract<AccountTx, { type: 'j_event_claim' }> {
    const committed = this.committed('alpha');
    const blockHash = `0x${blockByte.toString(16).padStart(2, '0').repeat(32)}`;
    return {
      type: 'j_event_claim',
      data: {
        jHeight,
        jBlockHash: blockHash,
        events: [{
          type: 'AccountSettled',
          data: {
            leftEntity: committed.state.leftEntity,
            rightEntity: committed.state.rightEntity,
            tokenId: 1,
            leftReserve: '0',
            rightReserve: '0',
            collateral: String(100 + jHeight),
            ondelta: '3',
            nonce: jHeight,
          },
          blockNumber: jHeight,
          blockHash,
          transactionHash: `0x${(blockByte + 1).toString(16).padStart(2, '0').repeat(32)}`,
          logIndex: 0,
        }],
      },
    };
  }

  payment(amount = 1n): AccountTx {
    const self = this.sides.alpha;
    const peer = this.sides.beta;
    return {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount,
        route: [peer.entityId],
        fromEntityId: self.entityId,
        toEntityId: peer.entityId,
        deliveryMode: 'direct',
      },
    };
  }

  async enqueue(side: Side, txs: readonly AccountTx[]) {
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    const shell = this.shell(side);
    const result = await applyAccountInput(this.context(), shell, { kind: 'enqueue', txs: [...txs] }, this.security());
    this.commit(side, shell);
    return result;
  }

  async admitClaim(side: Side, jHeight: number, blockByte: number) {
    return this.enqueue(side, [this.buildClaimTx(jHeight, blockByte)]);
  }

  mempoolTypes(side: Side): AccountTx['type'][] {
    return this.committed(side).mempool.map(tx => tx.type);
  }

  async propose(side: Side): Promise<ProposeAccountFrameResult> {
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    const shell = this.shell(side);
    const result = await proposeAccountFrame(this.context(), shell, this.clock, 0);
    if (isProposedAccountFrame(result)) {
      await this.certifyManifest(side, result.hashesToSign ?? []);
      this.proposals[side] = this.attachHankos(side, result.accountInput);
    }
    this.commit(side, shell);
    return result;
  }

  async deliver(side: Side): Promise<void> {
    const input = this.proposals[side];
    if (!input) return;
    const target = PEER_OF[side];
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    const shell = this.shell(target);
    const result = await applyAccountInput(this.context(), shell, input, this.security());
    await this.collectReceiverResult(target, result);
    this.commit(target, shell);
  }

  async ack(side: Side): Promise<void> {
    const draft = this.ackDrafts[side];
    if (!draft) return;
    const target = PEER_OF[side];
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    const signed = this.attachHankos(side, structuredClone(draft.accountInput));
    const shell = this.shell(target);
    const result = await applyAccountInput(this.context(), shell, signed, this.security());
    await this.collectReceiverResult(target, result);
    this.commit(target, shell);
  }
}

/** beta's own claim at `height` committed on alpha via a real peer frame. */
const setupCommittedPeerClaim = async (harness: VectorHarness, height: number, blockByte: number): Promise<void> => {
  const admitted = await harness.admitClaim('beta', height, blockByte);
  expect(admitted.ok && admitted.admittedAccountTxCount).toBe(1);
  const proposed = await harness.propose('beta');
  expect(isProposedAccountFrame(proposed)).toBe(true);
  await harness.deliver('beta');
  await harness.ack('beta');
};

describe('FX-3 j-claim admission vectors (proofs/fixes.md D4)', () => {
  test('(a) committed conflict is typed rejected at admission, account continues', async () => {
    const harness = new VectorHarness();
    await setupCommittedPeerClaim(harness, 5, 0x77);
    // The peer-committed member sits on alpha's peer side.
    const peerSide = harness.entitySide('alpha') === 'left' ? 'right' : 'left';

    const result = await harness.admitClaim('alpha', 5, 0x55);
    expect(result.ok).toBe(true);
    expect(result.ok && result.admittedAccountTxCount).toBe(0);
    expect(result.ok && result.admissionRejections).toEqual([{
      index: 0,
      code: 'ACCOUNT_TX_VALIDATION',
      message: `ACCOUNT_J_CLAIM_${peerSide.toUpperCase()}_CONFLICT:${peerSide}:5`,
    }]);
    expect(harness.mempoolTypes('alpha')).toEqual([]);
    // The account continues: ordinary work still enters the queue.
    const follow = await harness.enqueue('alpha', [harness.payment()]);
    expect(follow.ok && follow.admittedAccountTxCount).toBe(1);
    expect(harness.mempoolTypes('alpha')).toEqual(['direct_payment']);
  });

  test('(b) two conflicts in one batch: both rows typed rejected, survivors admitted; window drops two stale rows and survives', async () => {
    const harness = new VectorHarness();
    await setupCommittedPeerClaim(harness, 5, 0x77);
    const peerSide = harness.entitySide('alpha') === 'left' ? 'right' : 'left';

    const batch = await harness.enqueue('alpha', [
      harness.buildClaimTx(5, 0x55),
      harness.payment(),
      harness.buildClaimTx(5, 0x66),
    ]);
    expect(batch.ok).toBe(true);
    expect(batch.ok && batch.admittedAccountTxCount).toBe(1);
    expect(batch.ok && batch.admissionRejections?.map(rejection => rejection.index)).toEqual([0, 2]);
    for (const rejection of batch.ok ? batch.admissionRejections ?? [] : []) {
      expect(rejection.code).toBe('ACCOUNT_TX_VALIDATION');
      expect(rejection.message).toBe(`ACCOUNT_J_CLAIM_${peerSide.toUpperCase()}_CONFLICT:${peerSide}:5`);
    }
    expect(harness.mempoolTypes('alpha')).toEqual(['direct_payment']);

    // Window reading: two claims admitted while honest both go stale after an
    // incoming frame commits different evidence at the same heights.
    const staleHarness = new VectorHarness();
    const admitted = await staleHarness.enqueue('alpha', [
      staleHarness.buildClaimTx(5, 0x55),
      staleHarness.buildClaimTx(6, 0x66),
      staleHarness.payment(),
    ]);
    expect(admitted.ok && admitted.admittedAccountTxCount).toBe(3);
    const peerClaims = await staleHarness.enqueue('beta', [
      staleHarness.buildClaimTx(5, 0x77),
      staleHarness.buildClaimTx(6, 0x88),
    ]);
    expect(peerClaims.ok && peerClaims.admittedAccountTxCount).toBe(2);
    const peerProposal = await staleHarness.propose('beta');
    expect(isProposedAccountFrame(peerProposal)).toBe(true);
    await staleHarness.deliver('beta');
    await staleHarness.ack('beta');

    const proposal = await staleHarness.propose('alpha');
    expect(isProposedAccountFrame(proposal)).toBe(true);
    if (!isProposedAccountFrame(proposal)) return;
    expect(proposal.proposalDroppedTransactions.map(dropped => dropped.disposition))
      .toEqual(['removed', 'removed']);
    expect(proposal.proposalDroppedTransactions.map(dropped => dropped.code))
      .toEqual(['ACCOUNT_TX_VALIDATION', 'ACCOUNT_TX_VALIDATION']);
    expect(proposal.proposalDroppedTransactions.map(dropped => dropped.message))
      .toEqual([
        `ACCOUNT_J_CLAIM_${peerSide.toUpperCase()}_CONFLICT:${peerSide}:5`,
        `ACCOUNT_J_CLAIM_${peerSide.toUpperCase()}_CONFLICT:${peerSide}:6`,
      ]);
    expect(staleHarness.committed('alpha').pendingFrame?.accountTxs.map(tx => tx.type))
      .toEqual(['direct_payment']);
    expect(staleHarness.mempoolTypes('alpha')).toEqual([]);
  });

  test('(c) exact duplicate is idempotent against committed and queued evidence, and never double-records', async () => {
    const harness = new VectorHarness();
    await setupCommittedPeerClaim(harness, 5, 0x77);
    const committedDuplicate = await harness.admitClaim('alpha', 5, 0x77);
    expect(committedDuplicate.ok).toBe(true);
    expect(committedDuplicate.ok && committedDuplicate.admittedAccountTxCount).toBe(0);
    expect(committedDuplicate.ok && committedDuplicate.admissionRejections).toBeUndefined();
    expect(harness.mempoolTypes('alpha')).toEqual([]);

    const queuedHarness = new VectorHarness();
    const first = await queuedHarness.admitClaim('alpha', 7, 0x11);
    expect(first.ok && first.admittedAccountTxCount).toBe(1);
    const second = await queuedHarness.admitClaim('alpha', 7, 0x11);
    expect(second.ok).toBe(true);
    expect(second.ok && second.admittedAccountTxCount).toBe(0);
    expect(second.ok && second.admissionRejections).toBeUndefined();
    expect(queuedHarness.mempoolTypes('alpha')).toEqual(['j_event_claim']);

    const proposal = await queuedHarness.propose('alpha');
    expect(isProposedAccountFrame(proposal)).toBe(true);
    expect(queuedHarness.committed('alpha').pendingFrame?.accountTxs).toHaveLength(1);
  });

  test('(d) stale admitted claim is dropped after an incoming frame; only that row, typed, window continues', async () => {
    const harness = new VectorHarness();
    const admitted = await harness.enqueue('alpha', [harness.buildClaimTx(5, 0x55), harness.payment()]);
    expect(admitted.ok && admitted.admittedAccountTxCount).toBe(2);
    await setupCommittedPeerClaim(harness, 5, 0x77);
    const peerSide = harness.entitySide('alpha') === 'left' ? 'right' : 'left';

    const proposal = await harness.propose('alpha');
    expect(isProposedAccountFrame(proposal)).toBe(true);
    if (!isProposedAccountFrame(proposal)) return;
    expect(proposal.proposalDroppedTransactions).toEqual([{
      index: 0,
      txDigest: expect.any(String),
      code: 'ACCOUNT_TX_VALIDATION',
      message: `ACCOUNT_J_CLAIM_${peerSide.toUpperCase()}_CONFLICT:${peerSide}:5`,
      disposition: 'removed',
    }]);
    expect(harness.committed('alpha').pendingFrame?.accountTxs.map(tx => tx.type))
      .toEqual(['direct_payment']);
    expect(harness.mempoolTypes('alpha')).toEqual([]);
  });

  test('clause 3: conflict with an earlier queued claim is a typed reject with its own message', async () => {
    const harness = new VectorHarness();
    const first = await harness.admitClaim('alpha', 9, 0x11);
    expect(first.ok && first.admittedAccountTxCount).toBe(1);
    const conflict = await harness.admitClaim('alpha', 9, 0x22);
    expect(conflict.ok).toBe(true);
    expect(conflict.ok && conflict.admittedAccountTxCount).toBe(0);
    expect(conflict.ok && conflict.admissionRejections).toEqual([{
      index: 0,
      code: 'ACCOUNT_TX_VALIDATION',
      message: 'ACCOUNT_J_CLAIM_QUEUED_CONFLICT:9',
    }]);
    // The earlier honest claim is untouched.
    expect(harness.mempoolTypes('alpha')).toEqual(['j_event_claim']);
  });
});
