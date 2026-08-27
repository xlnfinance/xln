/**
 * proofs/C2 — hot (memoized) roots must equal cold recomputation after any
 * bounded operation sequence over a real two-replica bilateral Account.
 *
 * Real integration only: no mocks. Two lazy entities with real secp256k1
 * signer keys drive the production consensus functions
 * (`applyAccountInput`, `proposeAccountFrame`), real Hanko signing
 * (`signEntityHashes` via the QA entity boundary) and real Hanko
 * verification (`verifyHankoForHash` through `createAccountConsensusContext`).
 * The Entity-side commit boundary is reproduced per step with the production
 * `forkAccountReplicaShell` + `PersistentEntityAccountMap.updated` pair.
 *
 * Covered hot/cold pairs (see proofs/ts/report.md):
 *  - Account state root:        computeAccountStateRoot          vs computeAccountStateRootCold
 *  - Account section hashes:    computeAccountStateSectionHashes vs ...Cold
 *  - Commitment section detail: computeAccountCommitmentSectionDetail vs ...Cold
 *  - Per-collection map roots:  PersistentAccountStateMap.rootHash vs coldRootHash
 *  - Entity consensus root:     computeCanonicalEntityConsensusStateHash vs ...Cold
 *    (covers the entity account leaf hash, memoized hanko digests, mempool
 *    root, input/ACK binding memos, and entityCollectionCommitment)
 */
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';

import { applyAccountInput, proposeAccountFrame } from '../../account/consensus';
import type { AccountConsensusContext } from '../../account/consensus/context';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { isProposedAccountFrame } from '../../account/consensus/result';
import type { AccountConsensusHashToSign } from '../../account/consensus/types';
import {
  computeAccountCommitmentSectionDetail,
  computeAccountCommitmentSectionDetailCold,
  computeAccountStateRoot,
  computeAccountStateRootCold,
  computeAccountStateSectionHashes,
  computeAccountStateSectionHashesCold,
  peekAccountStateRoot,
} from '../../account/commitment/state-root';
import { isPersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import { createAccountConsensusContext } from '../../entity/account/account-consensus-context';
import { cacheCommittedAccountJClaimNodeChanges } from '../../entity/account/account-j-claim-node-store';
import {
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityAccountValueHash,
} from '../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import type { EntityState } from '../../entity/types';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../account/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { signEntityHashes } from '../../hanko/signing';
import { createEmptyEnv } from '../../runtime';
import { safeStringify } from '../../protocol/serialization';
import { LIMITS } from '../../config/constants';
import type { AccountInput, AccountPeerInput, AccountReplica, AccountTx } from '../../types/account';
import type { RuntimeReplica } from '../../runtime/types';
import { installJurisdictions, makeAccount, makeJurisdiction, makeState } from '../helpers/cross-j';
import {
  REGRESSION_SEQUENCES,
  type HarnessOp,
  type HarnessSide,
  type HarnessTxSpec,
} from './hot-vs-cold.regression';

const RUNTIME_SEED = 'proofs-hot-vs-cold:runtime';
const CHAIN = { name: 'proofs-hot-vs-cold-j', chainId: 31_337, depository: 'dd', provider: 'ee' } as const;
const STEP_MS = 1_000;
const SIDES: readonly HarnessSide[] = ['alpha', 'beta'];
const PEER_OF: Record<HarnessSide, HarnessSide> = { alpha: 'beta', beta: 'alpha' };

const STATE_COLLECTION_FIELDS = [
  'deltas', 'locks', 'pulls', 'swapOffers', 'subcontracts', 'lendingIntents',
  'requestedRebalance', 'requestedRebalanceFeeState', 'rebalanceFeePolicies',
] as const;

type SideRecord = Readonly<{
  entityId: string;
  signerId: string;
  state: EntityState;
  accounts: PersistentEntityAccountMap;
}>;

type AckDraft = Readonly<{
  accountInput: AccountPeerInput;
  hashesToSign: readonly AccountConsensusHashToSign[];
}>;

/** Deterministic two-replica bilateral harness over the real consensus stack. */
class BilateralHarness {
  readonly env: RuntimeReplica = createEmptyEnv(RUNTIME_SEED);
  readonly sides: Record<HarnessSide, SideRecord>;
  readonly proposals: Partial<Record<HarnessSide, AccountInput>> = {};
  readonly ackDrafts: Partial<Record<HarnessSide, AckDraft>> = {};
  /** Certified hanko witnesses per side (hash -> hanko), as the Entity frame records them. */
  private readonly witnesses: Record<HarnessSide, Map<string, string>> = { alpha: new Map(), beta: new Map() };
  private clock = 1_000;

  constructor() {
    this.env.quietRuntimeLogs = true;
    const jurisdiction = makeJurisdiction(CHAIN.name, CHAIN.chainId, CHAIN.depository, CHAIN.provider);
    installJurisdictions(this.env, jurisdiction);
    this.sides = {
      alpha: this.makeSideRecord('alpha', jurisdiction),
      beta: this.makeSideRecord('beta', jurisdiction),
    };
    for (const side of SIDES) this.commit(side, this.genesis(side));
    // Identical deterministic genesis on both replicas: the frame chain and
    // the bilateral agreement invariant start from one shared truth.
    const alpha = this.committed('alpha');
    const beta = this.committed('beta');
    if (alpha.currentFrame.stateHash !== beta.currentFrame.stateHash) {
      throw new Error('HARNESS_GENESIS_DIVERGENT');
    }
  }

  committed(side: HarnessSide): AccountReplica {
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

  /**
   * Entity hanko-witness boundary (core/entity/consensus/input/hanko-witness.ts
   * reduced to single-signer lazy entities): every manifest hash is signed once
   * at certification and cached; later drafts (e.g. a frame_ack bundling an
   * already-certified ACK) reuse the exact cached witness bytes.
   */
  private async certifyManifest(side: HarnessSide, manifest: readonly AccountConsensusHashToSign[]): Promise<void> {
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

  private attachHankos(side: HarnessSide, input: AccountInput): AccountInput {
    const signed = structuredClone(input);
    this.attachInPlace(side, undefined, signed);
    return signed;
  }

  /**
   * In-place witness attachment, mirroring
   * attachAccountInputHankos(..., persistAccountWitness=true): the signed Hanko
   * is persisted on the Account envelope (reusable ACK cache / pending input)
   * and currentFrameHanko ends on the newest attached witness.
   */
  private attachInPlace(side: HarnessSide, account: AccountReplica | undefined, input: AccountInput): void {
    const requireWitness = (hash: string | undefined): string => {
      if (hash === undefined) throw new Error(`HARNESS_WITNESS_HASH_MISSING:${this.sides[side].entityId}`);
      const hanko = this.witnesses[side].get(hash.toLowerCase());
      if (!hanko) throw new Error(`HARNESS_WITNESS_UNDECLARED:${this.sides[side].entityId}:${hash}`);
      return hanko;
    };
    if (input.kind === 'ack' || input.kind === 'frame_ack') {
      const ack = input.ack;
      ack.frameHanko = ack.frameHanko ?? requireWitness(ack.frameHash);
      if (account) account.currentFrameHanko = ack.frameHanko;
      if (ack.disputeHanko) {
        ack.disputeHanko.hanko = ack.disputeHanko.hanko ?? requireWitness(ack.disputeHanko.hash);
        if (account) account.currentDisputeProofHanko = ack.disputeHanko.hanko;
      }
    }
    if (input.kind === 'frame' || input.kind === 'frame_ack') {
      const proposal = input.proposal;
      proposal.frameHanko = proposal.frameHanko ?? requireWitness(proposal.frame.stateHash);
      if (account) account.currentFrameHanko = proposal.frameHanko;
      if (proposal.disputeHanko) {
        proposal.disputeHanko.hanko = proposal.disputeHanko.hanko ?? requireWitness(proposal.disputeHanko.hash);
        if (account) account.currentDisputeProofHanko = proposal.disputeHanko.hanko;
      }
    }
  }

  /** Persist certified witnesses onto the Account envelope like the Entity frame does. */
  private persistWitnesses(side: HarnessSide, shell: AccountReplica): void {
    if (shell.lastOutboundFrameAck) {
      this.attachInPlace(side, shell, shell.lastOutboundFrameAck.response);
    }
    if (shell.pendingAccountInput) {
      this.attachInPlace(side, shell, shell.pendingAccountInput);
    }
  }

  private async collectReceiverResult(
    target: HarnessSide,
    shell: AccountReplica,
    result: Awaited<ReturnType<typeof applyAccountInput>>,
  ): Promise<void> {
    if (!result.ok) return;
    // Entity commit boundary: the session's J-claim accumulator nodes become
    // durable exactly when the frame's AccountInput result is committed.
    cacheCommittedAccountJClaimNodeChanges(this.env, result.accountJClaimNodeChanges);
    await this.certifyManifest(target, result.hashesToSign ?? []);
    if (result.response && result.hashesToSign && result.hashesToSign.length > 0) {
      this.persistWitnesses(target, shell);
      this.ackDrafts[target] = {
        accountInput: this.attachHankos(target, result.response),
        hashesToSign: result.hashesToSign,
      };
    }
  }

  /** Production Entity write boundary: fork the committed shell, mutate, reseal. */
  private shell(side: HarnessSide): AccountReplica {
    return forkAccountReplicaShell(this.committed(side));
  }

  private commit(side: HarnessSide, account: AccountReplica): void {
    const record = this.sides[side];
    record.accounts = record.accounts.updated(this.sides[PEER_OF[side]].entityId, account);
    record.state.accounts = record.accounts;
  }

  private genesis(side: HarnessSide): AccountReplica {
    const account = makeAccount(
      this.sides[side].entityId,
      this.sides[PEER_OF[side]].entityId,
      { chainId: CHAIN.chainId, depositoryAddress: `0x${CHAIN.depository.repeat(20)}` },
    );
    // Fund every generated token row so direct payments commit instead of
    // being dropped for zero capacity; identical on both replicas.
    for (const [tokenId, delta] of [...account.state.deltas.entries()]) {
      account.state.deltas = account.state.deltas.updated(tokenId, { ...delta, collateral: 10n ** 12n });
    }
    const extraRow = account.state.deltas.get(1);
    if (!extraRow) throw new Error('HARNESS_GENESIS_DELTA_MISSING');
    for (let tokenId = 2; tokenId <= 8; tokenId += 1) {
      account.state.deltas = account.state.deltas.updated(tokenId, { ...extraRow, collateral: 10n ** 12n });
    }
    account.currentFrame.accountStateRoot = computeAccountStateRoot(account.state);
    account.currentFrame.stateHash = computeFrameHash(account.currentFrame);
    return account;
  }

  private makeSideRecord(slot: HarnessSide, jurisdiction: ReturnType<typeof makeJurisdiction>): SideRecord {
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

  /** Admit a j_event_claim whose bytes are a pure function of (jHeight, blockByte). */
  async admitClaim(side: HarnessSide, jHeight: number, blockByte: number): Promise<Awaited<ReturnType<typeof applyAccountInput>>> {
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    const shell = this.shell(side);
    const blockHash = `0x${blockByte.toString(16).padStart(2, '0').repeat(32)}`;
    const committed = this.committed(side);
    const tx: AccountTx = {
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
            collateral: '0',
            ondelta: '0',
            nonce: jHeight,
          },
          blockNumber: jHeight,
          blockHash,
          transactionHash: `0x${(blockByte + 1).toString(16).padStart(2, '0').repeat(32)}`,
          logIndex: 0,
        }],
      },
    };
    const result = await applyAccountInput(this.context(), shell, { kind: 'enqueue', txs: [tx] }, this.security());
    this.commit(side, shell);
    return result;
  }

  mempoolTypes(side: HarnessSide): AccountTx['type'][] {
    return this.committed(side).mempool.map(tx => tx.type);
  }

  pendingTxTypes(side: HarnessSide): AccountTx['type'][] {
    return this.committed(side).pendingFrame?.accountTxs.map(tx => tx.type) ?? [];
  }

  private instantiate(side: HarnessSide, spec: HarnessTxSpec): AccountTx {
    const self = this.sides[side];
    const peer = this.sides[PEER_OF[side]];
    switch (spec.kind) {
      case 'payment':
        return {
          type: 'direct_payment',
          data: {
            tokenId: spec.tokenId,
            amount: spec.amount,
            route: [peer.entityId],
            fromEntityId: self.entityId,
            toEntityId: peer.entityId,
            deliveryMode: 'direct',
          },
        };
      case 'credit':
        return { type: 'set_credit_limit', data: { tokenId: spec.tokenId, amount: spec.amount } };
      case 'delta':
        return { type: 'add_delta', data: { tokenId: spec.tokenId } };
    }
  }

  async step(op: HarnessOp): Promise<void> {
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    switch (op.kind) {
      case 'admit': {
        const shell = this.shell(op.side);
        await applyAccountInput(
          this.context(),
          shell,
          { kind: 'enqueue', txs: op.txs.map(tx => this.instantiate(op.side, tx)) },
          this.security(),
        );
        this.commit(op.side, shell);
        return;
      }
      case 'jclaim': {
        // Honest observation stream: one canonical claim per jHeight, derived
        // deterministically, so peers only ever see duplicate/idempotent claims.
        await this.admitClaim(op.side, op.jHeight, 0x11 + (op.jHeight % 5));
        return;
      }
      case 'propose': {
        const shell = this.shell(op.side);
        const result = await proposeAccountFrame(this.context(), shell, this.clock, 0);
        if (isProposedAccountFrame(result)) {
          await this.certifyManifest(op.side, result.hashesToSign ?? []);
          this.persistWitnesses(op.side, shell);
          this.proposals[op.side] = this.attachHankos(op.side, result.accountInput);
        }
        this.commit(op.side, shell);
        return;
      }
      case 'deliver': {
        const input = this.proposals[op.side];
        if (!input) return;
        const target = PEER_OF[op.side];
        const shell = this.shell(target);
        const result = await applyAccountInput(this.context(), shell, input, this.security());
        // The receiving Entity certifies the whole result manifest (ACK hash
        // included) even when the ACK itself is delivered much later.
        await this.collectReceiverResult(target, shell, result);
        this.commit(target, shell);
        return;
      }
      case 'ack': {
        const draft = this.ackDrafts[op.side];
        if (!draft) return;
        const signed = this.attachHankos(op.side, draft.accountInput);
        const target = PEER_OF[op.side];
        const shell = this.shell(target);
        const result = await applyAccountInput(this.context(), shell, signed, this.security());
        await this.collectReceiverResult(target, shell, result);
        this.commit(target, shell);
        return;
      }
    }
  }

  /** Hot/cold equality plus free replica invariants, after every operation. */
  checkAll(label: string): void {
    for (const side of SIDES) {
      const account = this.committed(side);
      this.checkAccountRoots(account, `${label} ${side}.committed`);
      const hot = computeCanonicalEntityConsensusStateHash(this.sides[side].state);
      const cold = computeCanonicalEntityConsensusStateHashCold(this.sides[side].state);
      expect(hot, `${label} ${side}.entityRoot hot-vs-cold`).toBe(cold);
      this.checkInvariants(account, `${label} ${side}.invariant`);
    }
    const alpha = this.committed('alpha');
    const beta = this.committed('beta');
    if (!alpha.pendingFrame && !beta.pendingFrame && alpha.currentHeight === beta.currentHeight) {
      expect(alpha.currentFrame.stateHash, `${label} agreement.frameHash`).toBe(beta.currentFrame.stateHash);
      expect(computeAccountStateRootCold(alpha.state), `${label} agreement.stateRoot`).toBe(computeAccountStateRootCold(beta.state));
    }
  }

  private checkAccountRoots(account: AccountReplica, label: string): void {
    const hotRoot = computeAccountStateRoot(account.state);
    const coldRoot = computeAccountStateRootCold(account.state);
    expect(hotRoot, `${label} stateRoot hot-vs-cold`).toBe(coldRoot);
    expect(computeAccountStateRoot(account.state), `${label} stateRoot hot-repeat`).toBe(coldRoot);
    expect(computeAccountStateSectionHashes(account.state), `${label} sectionHashes hot-vs-cold`)
      .toEqual(computeAccountStateSectionHashesCold(account.state));
    expect(computeAccountCommitmentSectionDetail(account.state), `${label} commitmentDetail hot-vs-cold`)
      .toEqual(computeAccountCommitmentSectionDetailCold(account.state));
    const memo = peekAccountStateRoot(account.state);
    if (memo !== undefined) {
      expect(memo, `${label} stateRoot memo-vs-cold`).toBe(coldRoot);
    }
    for (const field of STATE_COLLECTION_FIELDS) {
      const map = (account.state as Record<string, unknown>)[field];
      if (!isPersistentAccountStateMap(map)) continue;
      expect(map.rootHash(), `${label} map ${field} hot-vs-cold`).toBe(map.coldRootHash());
    }
    expect(account.pendingWithdrawals.rootHash(), `${label} map pendingWithdrawals hot-vs-cold`)
      .toBe(account.pendingWithdrawals.coldRootHash());
    expect(account.shadow.rebalance.policy.rootHash(), `${label} map shadowPolicy hot-vs-cold`)
      .toBe(account.shadow.rebalance.policy.coldRootHash());
    expect(account.shadow.rebalance.submittedAtByToken.rootHash(), `${label} map shadowSubmitted hot-vs-cold`)
      .toBe(account.shadow.rebalance.submittedAtByToken.coldRootHash());
  }

  private checkInvariants(account: AccountReplica, label: string): void {
    expect(computeAccountStateRootCold(account.state), `${label} liveRoot==currentFrame.root`)
      .toBe(account.currentFrame.accountStateRoot);
    expect(account.currentFrame.height, `${label} frameHeight==currentHeight`).toBe(account.currentHeight);
    if (account.pendingFrame) {
      expect(account.pendingFrame.height, `${label} pendingHeight==current+1`)
        .toBe(account.currentHeight + 1);
    }
    expect(account.mempool.length, `${label} mempoolBound`)
      .toBeLessThanOrEqual(LIMITS.ACCOUNT_MEMPOOL_SIZE);
  }
}

const runSequence = async (ops: readonly HarnessOp[], label: string): Promise<void> => {
  const harness = new BilateralHarness();
  harness.checkAll(`${label} step-0(genesis)`);
  for (const [index, op] of ops.entries()) {
    try {
      await harness.step(op);
      harness.checkAll(`${label} step-${index + 1}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${label} failed at step ${index + 1}: ${safeStringify(op)}\n${message}`,
        { cause: error },
      );
    }
  }
};

// ── fast-check generators (bounded op model) ─────────────────────────────

const sideArb = fc.constantFrom('alpha', 'beta') as fc.Arbitrary<HarnessSide>;
const tokenIdArb = fc.integer({ min: 1, max: 8 });
const txSpecArb = fc.oneof(
  fc.record({ kind: fc.constant('payment' as const), tokenId: tokenIdArb, amount: fc.bigInt({ min: 0n, max: 5_000n }) }),
  fc.record({ kind: fc.constant('credit' as const), tokenId: tokenIdArb, amount: fc.bigInt({ min: 0n, max: 1_000_000n }) }),
  fc.record({ kind: fc.constant('delta' as const), tokenId: tokenIdArb }),
);
const opArb = fc.oneof(
  { weight: 22, arbitrary: fc.record({ kind: fc.constant('admit' as const), side: sideArb, txs: fc.array(txSpecArb, { minLength: 1, maxLength: 5 }) }) },
  { weight: 30, arbitrary: fc.record({ kind: fc.constant('propose' as const), side: sideArb }) },
  { weight: 20, arbitrary: fc.record({ kind: fc.constant('deliver' as const), side: sideArb }) },
  { weight: 16, arbitrary: fc.record({ kind: fc.constant('ack' as const), side: sideArb }) },
  { weight: 12, arbitrary: fc.record({ kind: fc.constant('jclaim' as const), side: sideArb, jHeight: fc.integer({ min: 1, max: 5 }) }) },
);
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 40 });

describe('proofs/C2 hot-vs-cold account roots', () => {
  test('regression corpus keeps every covered protocol path hot==cold', async () => {
    for (const sequence of REGRESSION_SEQUENCES) {
      await runSequence(sequence.ops, `regression:${sequence.name}`);
    }
  });

  test('conflicting j_event_claim is typed rejected at admission, committed roots stay hot==cold', async () => {
    // fast-check (seed 42, run 79 / seed 31337, run 43) found that a locally
    // admitted second j_event_claim with the same jHeight but different event
    // bytes used to be a bare propose throw (C2 finding F1). FX-3 (D4) moved
    // the verdict to admission itself: the conflicting claim never enters the
    // mempool and the enqueue result carries the typed rejection, so this pin
    // asserts the typed admission verdict instead of the earlier
    // admit-then-drop-at-propose expectation. The proposal-window drop half
    // of D4 (stale admitted claims) is pinned by the FX-3 vector suite
    // core/__tests__/account/j-claims/j-claim-admission-vectors.test.ts.
    const harness = new BilateralHarness();
    await harness.admitClaim('alpha', 2, 0x11);
    harness.checkAll('finding-pin step-1');
    await harness.step({ kind: 'propose', side: 'alpha' });
    harness.checkAll('finding-pin step-2');
    await harness.step({ kind: 'deliver', side: 'alpha' });
    harness.checkAll('finding-pin step-3');
    await harness.step({ kind: 'ack', side: 'beta' });
    harness.checkAll('finding-pin step-4');
    const conflict = await harness.admitClaim('alpha', 2, 0x2a);
    harness.checkAll('finding-pin step-5');
    // Typed admission verdict: no throw, row rejected, nothing queued. The
    // committed member is alpha's own claim, so the conflict names alpha's
    // side of the bilateral pair.
    expect(conflict.ok).toBe(true);
    expect(conflict.ok ? conflict.admittedAccountTxCount : undefined).toBe(0);
    const alphaAccount = harness.committed('alpha');
    const alphaSide = harness.sides.alpha.entityId === alphaAccount.state.leftEntity ? 'left' : 'right';
    expect(conflict.ok ? conflict.admissionRejections : undefined).toEqual([{
      index: 0,
      code: 'ACCOUNT_TX_VALIDATION',
      message: `ACCOUNT_J_CLAIM_${alphaSide.toUpperCase()}_CONFLICT:${alphaSide}:2`,
    }]);
    await harness.step({
      kind: 'admit',
      side: 'alpha',
      txs: [{ kind: 'payment', tokenId: 1, amount: 1n }],
    });
    expect(harness.mempoolTypes('alpha')).toEqual(['direct_payment']);
    await expect(harness.step({ kind: 'propose', side: 'alpha' })).resolves.toBeUndefined();
    expect(harness.mempoolTypes('alpha')).toEqual([]);
    expect(harness.pendingTxTypes('alpha')).toEqual(['direct_payment']);
    harness.checkAll('conflict-rejected');
  });

  for (const { seed, runs } of [
    { seed: 42, runs: Number(process.env.XLN_C2_RUNS ?? 100) },
    { seed: 2026_0826, runs: Number(process.env.XLN_C2_RUNS ?? 100) },
    { seed: 31_337, runs: Number(process.env.XLN_C2_RUNS ?? 100) },
  ]) {
    test(`fast-check: hot roots equal cold recomputation (seed ${seed}, ${runs} runs, <=40 ops)`, { timeout: 1_200_000 }, async () => {
      await fc.assert(
        fc.asyncProperty(opsArb, async ops => runSequence(ops, `seed:${seed}`)),
        { seed, numRuns: runs, endOnFailure: true },
      );
    });
  }
});
