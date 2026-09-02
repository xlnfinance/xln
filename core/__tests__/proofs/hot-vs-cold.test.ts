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
 * `forkAccountReplicaShell` + `PersistentEntityAccountMap.updated` pair, and
 * once per run with the full `EntityAccountCandidateMap` overlay
 * (projection/hash projection reuse, frozen-shell re-seal,
 * `dropCachedProjection`, `sealCandidate`) plus the engine leaf-registry
 * remember/peek/forget triangle (c2-adversary A4).
 *
 * Covered hot/cold pairs (see proofs/ts/report.md):
 *  - Account state root:        computeAccountStateRoot          vs computeAccountStateRootCold
 *  - Account section hashes:    computeAccountStateSectionHashes vs ...Cold
 *  - Commitment section detail: computeAccountCommitmentSectionDetail vs ...Cold
 *  - Per-collection map roots:  PersistentAccountStateMap.rootHash vs coldRootHash
 *    (all 12 collections; genesis instantiates the four optional namespaces so
 *    the map-level check cannot silently skip them; non-empty coverage comes
 *    from HTLC lock/resolve, swap offer/cancel, cross-j pull lock, rebalance
 *    policy/request/refund and j-event finality generators — c2-adversary A2)
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
import { isPersistentAccountStateMap, PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import { createAccountConsensusContext } from '../../entity/account/account-consensus-context';
import { cacheCommittedAccountJClaimNodeChanges } from '../../entity/account/account-j-claim-node-store';
import {
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityAccountValueHash,
  invalidateEntityAccountCommitment,
} from '../../entity/consensus/state-root';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../entity/state/persistent-account-map';
import { engineAccountValueHash } from '../../rscore/engine-leaf/leaf-cache';
import {
  forgetEngineAccountLeaf,
  peekEngineAccountLeaf,
  rememberEngineAccountLeaf,
} from '../../rscore/engine-leaf/leaf-registry';
import type { EntityState } from '../../entity/types';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../account/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { signEntityHashes } from '../../hanko/signing';
import { createEmptyEnv } from '../../runtime';
import { safeStringify } from '../../protocol/serialization';
import { isLeftEntity } from '../../account/utils';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import {
  buildCrossJurisdictionPullBinding,
  cloneCrossJurisdictionRoute,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../extensions/cross-j';
import { getJurisdictionStackId } from '../../jurisdiction/machine/jurisdiction-stack';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import { LIMITS } from '../../config/constants';
import type { AccountInput, AccountReplica, AccountTx } from '../../types/account';
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
const GENESIS_COLLATERAL = 10n ** 12n;
/** HTLC timelock far above any in-run clock; reveal window far above frame jHeight. */
const HTLC_TIMELOCK_MS = 10n ** 12n;
const HTLC_REVEAL_BEFORE_HEIGHT = 1 << 20;

const STATE_COLLECTION_FIELDS = [
  'deltas', 'locks', 'pulls', 'swapOffers', 'subcontracts', 'lendingIntents',
  'requestedRebalance', 'requestedRebalanceFeeState', 'rebalanceFeePolicies',
] as const;
const ENVELOPE_COLLECTION_FIELDS = [
  'pendingWithdrawals', 'rebalanceShadowPolicy', 'rebalanceShadowSubmitted',
] as const;
type TrackedCollection = (typeof STATE_COLLECTION_FIELDS)[number] | (typeof ENVELOPE_COLLECTION_FIELDS)[number];

/** Per-test coverage accumulator (c2-adversary A7: measure, do not assume). */
export type CoverageLedger = Readonly<{
  nonEmpty: Set<TrackedCollection>;
  shrank: Set<TrackedCollection>;
  opCounts: Map<string, number>;
}>;

const newCoverageLedger = (): CoverageLedger & { nonEmpty: Set<TrackedCollection>; shrank: Set<TrackedCollection>; opCounts: Map<string, number> } =>
  ({ nonEmpty: new Set(), shrank: new Set(), opCounts: new Map() });

const collectionSizes = (account: AccountReplica): Record<TrackedCollection, number> => ({
  deltas: account.state.deltas.size,
  locks: account.state.locks.size,
  pulls: account.state.pulls?.size ?? 0,
  swapOffers: account.state.swapOffers.size,
  subcontracts: account.state.subcontracts?.size ?? 0,
  lendingIntents: account.state.lendingIntents?.size ?? 0,
  requestedRebalance: account.state.requestedRebalance.size,
  requestedRebalanceFeeState: account.state.requestedRebalanceFeeState.size,
  rebalanceFeePolicies: account.state.rebalanceFeePolicies?.size ?? 0,
  pendingWithdrawals: account.pendingWithdrawals.size,
  rebalanceShadowPolicy: account.shadow.rebalance.policy.size,
  rebalanceShadowSubmitted: account.shadow.rebalance.submittedAtByToken.size,
});

const htlcSecretHex = (lockId: number): string =>
  `0x${(lockId & 0xff).toString(16).padStart(2, '0').repeat(32)}`;

type SideRecord = Readonly<{
  entityId: string;
  signerId: string;
  state: EntityState;
  accounts: PersistentEntityAccountMap;
}>;

type AckDraft = Readonly<{
  accountInput: AccountInput;
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
  private readonly coverage: ReturnType<typeof newCoverageLedger>;
  private readonly previousSizes = new Map<HarnessSide, Record<TrackedCollection, number>>();
  private clock = 1_000;

  constructor(coverage: ReturnType<typeof newCoverageLedger> = newCoverageLedger()) {
    this.coverage = coverage;
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

  /** Which bilateral slot `side`'s entity occupies in its own view of the account. */
  entitySide(side: HarnessSide): 'left' | 'right' {
    return isLeftEntity(this.sides[side].entityId, this.sides[PEER_OF[side]].entityId) ? 'left' : 'right';
  }

  private context(): AccountConsensusContext {
    return createAccountConsensusContext(this.env);
  }

  /**
   * Production security-context resolution (core/account/consensus/index.ts):
   * provided ?? context.entityClock?.finalizedJHeight ??
   * account.state.lastFinalizedJHeight ?? 0. The harness context carries no
   * entityClock, so the certified Account clock is authoritative and advances
   * after every bilaterally finalized j-event claim (c2-adversary A5).
   */
  private security(side: HarnessSide) {
    return {
      entityTimestamp: this.clock,
      finalizedJHeight: this.committed(side).state.lastFinalizedJHeight ?? 0,
      owningEntityIsHub: false,
    };
  }

  /**
   * Entity hanko-witness boundary (core/entity/consensus/input/hanko-witness.ts
   * reduced to single-signer lazy entities): every manifest hash is signed once
   * at certification and cached; later drafts (e.g. a ack_frame bundling an
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
    // An ack_frame may carry a bare proposal (no piggybacked ACK) — see
    // AccountInput `ack?: AccountAckFrame`.
    const ack = input.kind === 'ack' || input.kind === 'ack_frame' ? input.ack : undefined;
    if (ack) {
      ack.frameHanko = ack.frameHanko ?? requireWitness(ack.frameHash);
      if (account) account.currentFrameHanko = ack.frameHanko;
      if (ack.disputeHanko) {
        ack.disputeHanko.hanko = ack.disputeHanko.hanko ?? requireWitness(ack.disputeHanko.hash);
        if (account) account.currentDisputeProofHanko = ack.disputeHanko.hanko;
      }
    }
    if (input.kind === 'ack_frame') {
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
    if (shell.lastOutboundAckFrame) {
      this.attachInPlace(side, shell, shell.lastOutboundAckFrame.response);
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
      account.state.deltas = account.state.deltas.updated(tokenId, { ...delta, collateral: GENESIS_COLLATERAL });
    }
    const extraRow = account.state.deltas.get(1);
    if (!extraRow) throw new Error('HARNESS_GENESIS_DELTA_MISSING');
    // Fund only runtime-registered tokens (getKnownTokenIds = 1..5): an
    // unregistered row with withdrawable collateral makes
    // classifyAccountWork -> getDefaultRebalancePolicyForToken throw
    // TOKEN_METADATA_UNAVAILABLE at the Entity-map commit boundary (reported
    // as hardening finding C2-H1; production code is out of scope here).
    // The row value must carry its own tokenId: drafts built from a copied
    // row commit back at draft.tokenId, so a copied tokenId-1 value would
    // silently redirect token-N writes onto the token-1 row.
    for (let tokenId = 2; tokenId <= 5; tokenId += 1) {
      account.state.deltas = account.state.deltas.updated(tokenId, { ...extraRow, tokenId, collateral: GENESIS_COLLATERAL });
    }
    // c2-adversary A2 item 3: instantiate the four optional namespaces so the
    // per-collection hot/cold check can never silently skip them.
    account.state.pulls = PersistentAccountStateMap.empty('pulls');
    account.state.subcontracts = PersistentAccountStateMap.empty('subcontracts');
    account.state.lendingIntents = PersistentAccountStateMap.empty('lendingIntents');
    account.state.rebalanceFeePolicies = PersistentAccountStateMap.empty('rebalanceFeePolicies');
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

  /** Claim bytes are a pure function of (side pair, jHeight, blockByte). */
  buildClaimTx(side: HarnessSide, jHeight: number, blockByte: number): AccountTx {
    const committed = this.committed(side);
    const blockHash = `0x${blockByte.toString(16).padStart(2, '0').repeat(32)}`;
    // Strictly increasing collateral per jHeight so a bilateral finalize of a
    // token with a pending collateral request exercises the j-finality
    // requestedRebalance clear (put/del) branch instead of always no-op.
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
            collateral: String(GENESIS_COLLATERAL + BigInt(jHeight)),
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
  }

  paymentTx(side: HarnessSide, amount: bigint): AccountTx {
    const self = this.sides[side];
    const peer = this.sides[PEER_OF[side]];
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

  /** Admit a j_event_claim whose bytes are a pure function of (jHeight, blockByte). */
  async admitClaim(side: HarnessSide, jHeight: number, blockByte: number): Promise<Awaited<ReturnType<typeof applyAccountInput>>> {
    return this.admitRaw(side, [this.buildClaimTx(side, jHeight, blockByte)]);
  }

  /** Raw enqueue of prebuilt transactions (vector pins mix claims and payments). */
  async admitRaw(side: HarnessSide, txs: readonly AccountTx[]): Promise<Awaited<ReturnType<typeof applyAccountInput>>> {
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    const shell = this.shell(side);
    const result = await applyAccountInput(this.context(), shell, { kind: 'enqueue', txs: [...txs] }, this.security(side));
    this.commit(side, shell);
    return result;
  }

  mempoolTypes(side: HarnessSide): AccountTx['type'][] {
    return this.committed(side).mempool.map(tx => tx.type);
  }

  pendingTxTypes(side: HarnessSide): AccountTx['type'][] {
    return this.committed(side).pendingFrame?.accountTxs.map(tx => tx.type) ?? [];
  }

  /**
   * Production-shaped cross-j pull lock for one order leg: the resting route
   * and its binding are built by the production canonicalizers
   * (withCanonicalCrossJurisdictionRouteHash + buildCrossJurisdictionPullBinding),
   * exactly as the Entity command planner would emit them.
   */
  buildPullLockTx(side: HarnessSide, orderNum: number, tokenId: number, amount: bigint): AccountTx {
    const account = this.committed(side);
    const orderId = `ord${orderNum}`;
    const fullHash = `0x${((orderNum * 17 + 3) & 0xff).toString(16).padStart(2, '0').repeat(32)}`;
    const partialRoot = `0x${((orderNum * 29 + 7) & 0xff).toString(16).padStart(2, '0').repeat(32)}`;
    const left = account.state.leftEntity;
    const right = account.state.rightEntity;
    const route: CrossJurisdictionSwapRoute = withCanonicalCrossJurisdictionRouteHash({
      orderId,
      makerEntityId: left,
      hubEntityId: left,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      source: {
        jurisdiction: getJurisdictionStackId(account.state.domain),
        entityId: left,
        counterpartyEntityId: right,
        tokenId,
        amount,
      },
      target: {
        jurisdiction: `stack:${CHAIN.chainId + 1}:0x${'ee'.repeat(20)}`,
        entityId: right,
        counterpartyEntityId: left,
        tokenId,
        amount,
      },
      sourcePull: { pullId: `${orderId}s`, tokenId, amount, signedAmount: -amount, fullHash, partialRoot },
      targetPull: { pullId: `${orderId}t`, tokenId, amount, signedAmount: -amount, fullHash, partialRoot },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 20_000,
    });
    return {
      type: 'cross_pull_lock',
      data: {
        pullId: `${orderId}s`,
        tokenId,
        amount: -amount,
        fullHash,
        partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
        crossJurisdictionRoute: cloneCrossJurisdictionRoute(route),
      },
    };
  }

  /**
   * Turn one tx spec into 0..1 concrete transactions. REMOVE-family specs
   * (htlc_resolve / swap_cancel / rebalance_refund) are stateful commands:
   * they resolve to a transaction only when their target entry exists in
   * committed state AND the admitting side holds the handler's authority
   * (beneficiary / maker's counterparty / non-requester). Otherwise the op is
   * a deterministic no-op — the same precondition discipline the audit asked
   * for instead of blind type-dropping.
   */
  private instantiate(side: HarnessSide, spec: HarnessTxSpec, batchPullIds: Set<string>): readonly AccountTx[] {
    const self = this.sides[side];
    const peer = this.sides[PEER_OF[side]];
    const byLeft = isLeftEntity(self.entityId, peer.entityId);
    switch (spec.kind) {
      case 'payment':
        return [{
          type: 'direct_payment',
          data: {
            tokenId: spec.tokenId,
            amount: spec.amount,
            route: [peer.entityId],
            fromEntityId: self.entityId,
            toEntityId: peer.entityId,
            deliveryMode: 'direct',
          },
        }];
      case 'credit':
        return [{ type: 'set_credit_limit', data: { tokenId: spec.tokenId, amount: spec.amount } }];
      case 'delta':
        return [{ type: 'add_delta', data: { tokenId: spec.tokenId } }];
      case 'htlc_lock':
        {
        const lockId = hashHtlcSecret(htlcSecretHex(spec.lockId));
        return [{
          type: 'htlc_lock',
          data: {
            lockId,
            hashlock: lockId,
            timelock: HTLC_TIMELOCK_MS,
            revealBeforeHeight: HTLC_REVEAL_BEFORE_HEIGHT,
            amount: spec.amount,
            tokenId: spec.tokenId,
            ...(spec.mode === 'none' ? {} : { deliveryMode: spec.mode }),
          },
        }];
        }
      case 'htlc_resolve': {
        const lockId = hashHtlcSecret(htlcSecretHex(spec.lockId));
        const lock = this.committed(side).state.locks.get(lockId);
        if (!lock) return [];
        if (spec.outcome === 'secret') {
          return [{ type: 'htlc_resolve', data: { lockId, outcome: 'secret', secret: htlcSecretHex(spec.lockId) } }];
        }
        // Before expiry only the beneficiary may release an active lock.
        if (byLeft === lock.senderIsLeft) return [];
        return [{ type: 'htlc_resolve', data: { lockId, outcome: 'error', reason: 'proof-fail' } }];
      }
      case 'swap_offer': {
        if (spec.giveTokenId === spec.wantTokenId) return [];
        return [{
          type: 'swap_offer',
          data: {
            offerId: `offer${spec.offerId}`,
            giveTokenId: spec.giveTokenId,
            giveTokenDecimals: 2,
            giveAmount: spec.amount,
            wantTokenId: spec.wantTokenId,
            wantTokenDecimals: 2,
            wantAmount: spec.amount,
            maxFee: spec.amount / 2n,
            minNetReceive: spec.amount - spec.amount / 2n,
          },
        }];
      }
      case 'swap_cancel': {
        const offerId = `offer${spec.offerId}`;
        const offer = this.committed(side).state.swapOffers.get(offerId);
        if (!offer || offer.crossJurisdiction) return [];
        if (byLeft === offer.makerIsLeft) return []; // only the counterparty resolves
        return [{ type: 'swap_resolve', data: { offerId, fillRatio: 0, cancelRemainder: true } }];
      }
      case 'cross_pull_lock': {
        const account = this.committed(side);
        const orderId = `ord${spec.orderId}`;
        const pullId = `${orderId}s`;
        // Model bound (finding C2-H2): the Entity command planner never emits
        // two live pulls for one order leg, and a second same-pullId
        // cross_pull_lock — which local enqueue DOES admit (fingerprint dedup
        // only catches exact bytes) — trips the proposal halt_runtime
        // tripwire CROSS_J_PULL_LOCK_PROPOSAL_FAILED. The random model keeps
        // the planner invariant; the halt itself is pinned in its own test.
        const queuedDuplicate = [...account.mempool, ...(account.pendingFrame?.accountTxs ?? [])]
          .some(tx => tx.type === 'cross_pull_lock' && tx.data.pullId === pullId)
          || batchPullIds.has(pullId);
        if (account.state.pulls?.has(pullId) || queuedDuplicate) return [];
        batchPullIds.add(pullId);
        return [this.buildPullLockTx(side, spec.orderId, spec.tokenId, spec.amount)];
      }
      case 'rebalance_policy':
        return [{
          type: 'rebalance_policy',
          data: {
            tokenId: spec.tokenId,
            policyVersion: spec.policyVersion,
            baseFee: spec.baseFee,
            liquidityFeeBps: spec.liquidityFeeBps,
            gasFee: spec.gasFee,
          },
        }];
      case 'request_collateral': {
        // A pending request is immutable until finalized or refunded.
        if ((this.committed(side).state.requestedRebalance.get(spec.tokenId) ?? 0n) > 0n) return [];
        return [{
          type: 'request_collateral',
          data: { tokenId: spec.tokenId, amount: spec.amount, feeAmount: spec.feeAmount, policyVersion: 1 },
        }];
      }
      case 'rebalance_refund': {
        const account = this.committed(side);
        const feeState = account.state.requestedRebalanceFeeState.get(spec.tokenId);
        if (!feeState || (account.state.requestedRebalance.get(spec.tokenId) ?? 0n) <= 0n) return [];
        if (byLeft === feeState.requestedByLeft) return []; // requester cannot refund itself
        return [{
          type: 'rebalance_refund',
          data: {
            requestId: feeState.requestId,
            requestTokenId: spec.tokenId,
            amount: feeState.feePaidUpfront,
            reason: 'manual',
          },
        }];
      }
    }
  }

  private async proposeRaw(side: HarnessSide): Promise<ReturnType<typeof proposeAccountFrame>> {
    this.clock += STEP_MS;
    this.env.state.timestamp = this.clock;
    const shell = this.shell(side);
    const result = await proposeAccountFrame(this.context(), shell, this.clock, 0);
    if (isProposedAccountFrame(result)) {
      await this.certifyManifest(side, result.hashesToSign ?? []);
      this.persistWitnesses(side, shell);
      this.proposals[side] = this.attachHankos(side, result.accountInput);
    }
    this.commit(side, shell);
    return result;
  }

  async step(op: HarnessOp): Promise<ReturnType<typeof proposeAccountFrame> | undefined> {
    this.coverage.opCounts.set(op.kind, (this.coverage.opCounts.get(op.kind) ?? 0) + 1);
    switch (op.kind) {
      case 'admit': {
        const batchPullIds = new Set<string>();
        const txs = op.txs.flatMap(tx => this.instantiate(op.side, tx, batchPullIds));
        await this.admitRaw(op.side, txs);
        return undefined;
      }
      case 'jclaim': {
        // Observation stream with generated bytes: exact duplicates and same-
        // height conflicts are both generatable (c2-adversary A3). Conflicts
        // take the FX-3 typed admission rejection, never a halt.
        await this.admitClaim(op.side, op.jHeight, op.blockByte);
        return undefined;
      }
      case 'propose':
        return this.proposeRaw(op.side);
      case 'deliver': {
        const input = this.proposals[op.side];
        if (!input) return undefined;
        const target = PEER_OF[op.side];
        this.clock += STEP_MS;
        this.env.state.timestamp = this.clock;
        const shell = this.shell(target);
        const result = await applyAccountInput(this.context(), shell, input, this.security(target));
        // The receiving Entity certifies the whole result manifest (ACK hash
        // included) even when the ACK itself is delivered much later.
        await this.collectReceiverResult(target, shell, result);
        this.commit(target, shell);
        return undefined;
      }
      case 'ack': {
        const draft = this.ackDrafts[op.side];
        if (!draft) return undefined;
        const signed = this.attachHankos(op.side, draft.accountInput);
        const target = PEER_OF[op.side];
        this.clock += STEP_MS;
        this.env.state.timestamp = this.clock;
        const shell = this.shell(target);
        const result = await applyAccountInput(this.context(), shell, signed, this.security(target));
        await this.collectReceiverResult(target, shell, result);
        this.commit(target, shell);
        return undefined;
      }
    }
  }

  /**
   * Entity overlay memo layer (c2-adversary A4), exercised on a scratch
   * overlay so committed replica state is untouched:
   *  - engine leaf registry remember -> peek-fed fold == recomputed fold;
   *  - candidate map hash projection (read twice: cache reuse) == committed root;
   *  - multi-account dirty fold (2 leaves) sealed == plain rebuild;
   *  - frozen-shell re-seal via set(committed)+getForWrite (claimed_resealed);
   *  - write boundary forgets the remembered engine leaf;
   *  - real enqueue on the forked shell + dropCachedProjection + re-seal;
   *  - invalidateEntityAccountCommitment on both committed and candidate maps.
   */
  async exerciseEntityOverlay(side: HarnessSide, label: string): Promise<void> {
    const record = this.sides[side];
    const ownerId = record.entityId;
    const peerId = this.sides[PEER_OF[side]].entityId;
    const account = this.committed(side);

    const recomputedLeaf = computeEntityAccountValueHash(account);
    rememberEngineAccountLeaf(ownerId, peerId, recomputedLeaf);
    expect(peekEngineAccountLeaf(ownerId, peerId), `${label} ${side} overlay.leafRegistry.peek`).toBe(recomputedLeaf);
    const rememberedRoot = PersistentEntityAccountMap.fromEntries(
      [[peerId, account]], ownerId, engineAccountValueHash(ownerId),
    ).rootHash();
    const recomputedRoot = PersistentEntityAccountMap.fromEntries(
      [[peerId, account]], ownerId, computeEntityAccountValueHash,
    ).rootHash();
    expect(rememberedRoot, `${label} ${side} overlay.leafRegistry.remembered==recomputed`).toBe(recomputedRoot);

    const overlay = new EntityAccountCandidateMap(record.accounts);
    expect(overlay.rootHash(), `${label} ${side} overlay.root==committed`).toBe(record.accounts.rootHash());
    expect(overlay.rootHash(), `${label} ${side} overlay.rootStable`).toBe(record.accounts.rootHash());
    const scratchAccountId = `0x${'ab'.repeat(32)}`;
    overlay.set(scratchAccountId, account);
    const overlayEntries = [...overlay];
    const sealed = overlay.sealCandidate();
    expect(sealed.size, `${label} ${side} overlay.sealedSize`).toBe(record.accounts.size + 1);
    expect(sealed.rootHash(), `${label} ${side} overlay.multiAccountSeal==rebuild`).toBe(
      PersistentEntityAccountMap.fromEntries(overlayEntries, ownerId, computeEntityAccountValueHash).rootHash(),
    );

    // Frozen committed leaf placed back into the shells: getForWrite must fork
    // it (claimed_resealed) and drop the remembered engine digest.
    const frozenLeaf = sealed.get(peerId);
    const overlay2 = new EntityAccountCandidateMap(sealed);
    overlay2.set(peerId, frozenLeaf);
    const fork = overlay2.getForWrite(peerId);
    if (!fork) throw new Error(`HARNESS_OVERLAY_RESEAL_MISSING:${side}`);
    expect(fork === frozenLeaf, `${label} ${side} overlay.resealIsFork`).toBe(false);
    expect(peekEngineAccountLeaf(ownerId, peerId), `${label} ${side} overlay.writeBoundaryForgets`).toBeUndefined();

    // Real production write on the forked shell, then explicit projection drop
    // (the boundary invalidateEntityAccountCommitment uses for in-place edits).
    await applyAccountInput(
      this.context(), fork,
      { kind: 'enqueue', txs: [this.paymentTx(side, 1n)] },
      { entityTimestamp: this.clock, finalizedJHeight: fork.state.lastFinalizedJHeight ?? 0, owningEntityIsHub: false },
    );
    overlay2.dropCachedProjection();
    const overlay2Entries = [...overlay2];
    const sealed2 = overlay2.sealCandidate();
    expect(sealed2.rootHash(), `${label} ${side} overlay.postWriteSeal==rebuild`).toBe(
      PersistentEntityAccountMap.fromEntries(overlay2Entries, ownerId, computeEntityAccountValueHash).rootHash(),
    );
    // The mempool is coordination state, not certified financial state
    // (state-root.ts ACCOUNT_ENTITY_EXCLUDED_FIELDS): a queued tx must leave the
    // committed Entity root exactly where it was, hot and cold alike.
    expect(sealed2.rootHash(), `${label} ${side} overlay.mempoolWriteKeepsRoot`).toBe(sealed.rootHash());
    expect(fork.mempool.length, `${label} ${side} overlay.mempoolWriteAdmitted`).toBe(frozenLeaf.mempool.length + 1);

    // invalidateEntityAccountCommitment: committed map (forget + type check)
    // and candidate map (forget + dropCachedProjection) both stay active-safe.
    invalidateEntityAccountCommitment({ ...record.state, accounts: record.accounts }, peerId);
    const overlay3 = new EntityAccountCandidateMap(record.accounts);
    overlay3.rootHash(); // populate the cached hash projection
    invalidateEntityAccountCommitment({ ...record.state, accounts: overlay3 }, peerId);
    expect(overlay3.sealCandidate().rootHash(), `${label} ${side} overlay.invalidateKeepsRoot`).toBe(record.accounts.rootHash());

    // Leave the registry exactly as production would: nothing remembered for
    // accounts this harness owns.
    forgetEngineAccountLeaf(ownerId, peerId);
    forgetEngineAccountLeaf(ownerId, scratchAccountId);
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
      this.observeCoverage(side, account);
    }
    const alpha = this.committed('alpha');
    const beta = this.committed('beta');
    if (!alpha.pendingFrame && !beta.pendingFrame && alpha.currentHeight === beta.currentHeight) {
      expect(alpha.currentFrame.stateHash, `${label} agreement.frameHash`).toBe(beta.currentFrame.stateHash);
      expect(computeAccountStateRootCold(alpha.state), `${label} agreement.stateRoot`).toBe(computeAccountStateRootCold(beta.state));
    }
  }

  private observeCoverage(side: HarnessSide, account: AccountReplica): void {
    const sizes = collectionSizes(account);
    for (const [field, size] of Object.entries(sizes) as [TrackedCollection, number][]) {
      if (size > 0) this.coverage.nonEmpty.add(field);
    }
    const previous = this.previousSizes.get(side);
    if (previous) {
      for (const [field, size] of Object.entries(sizes) as [TrackedCollection, number][]) {
        if (previous[field] > size) this.coverage.shrank.add(field);
      }
    }
    this.previousSizes.set(side, sizes);
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
      // c2-adversary A2: genesis instantiates every namespace, so a missing or
      // non-persistent collection is a harness bug, not a skip.
      if (!isPersistentAccountStateMap(map)) {
        throw new Error(`HARNESS_COLLECTION_NOT_PERSISTENT:${field}`);
      }
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

const runSequence = async (
  ops: readonly HarnessOp[],
  label: string,
  coverage: ReturnType<typeof newCoverageLedger> = newCoverageLedger(),
): Promise<void> => {
  const harness = new BilateralHarness(coverage);
  harness.checkAll(`${label} step-0(genesis)`);
  await harness.exerciseEntityOverlay('alpha', `${label} overlay-0`);
  const midpoint = Math.floor(ops.length / 2);
  for (const [index, op] of ops.entries()) {
    try {
      await harness.step(op);
      harness.checkAll(`${label} step-${index + 1}`);
      if (index + 1 === midpoint) {
        await harness.exerciseEntityOverlay('beta', `${label} overlay-mid`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${label} failed at step ${index + 1}: ${safeStringify(op)}\n${message}`,
        { cause: error },
      );
    }
  }
  await harness.exerciseEntityOverlay('alpha', `${label} overlay-end`);
  await harness.exerciseEntityOverlay('beta', `${label} overlay-end`);
};

// ── fast-check generators (bounded op model) ─────────────────────────────

const sideArb = fc.constantFrom('alpha', 'beta') as fc.Arbitrary<HarnessSide>;
// Registered runtime tokens only (getKnownTokenIds = 1..5): unregistered ids
// with collateral halt the Entity work-mask classifier (C2-H1).
const tokenIdArb = fc.integer({ min: 1, max: 5 });
const lockIdArb = fc.integer({ min: 1, max: 6 });
const offerIdArb = fc.integer({ min: 1, max: 4 });
const swapTokenPairArb = fc.tuple(tokenIdArb, tokenIdArb)
  .filter(([give, want]) => give !== want);
const swapAmountArb = fc.integer({ min: 1, max: 1_000 }).map(units => BigInt(units * 2));
const txSpecArb = fc.oneof(
  { weight: 20, arbitrary: fc.record({ kind: fc.constant('payment' as const), tokenId: tokenIdArb, amount: fc.bigInt({ min: 0n, max: 5_000n }) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('credit' as const), tokenId: tokenIdArb, amount: fc.bigInt({ min: 0n, max: 1_000_000n }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('delta' as const), tokenId: tokenIdArb }) },
  { weight: 10, arbitrary: fc.record({ kind: fc.constant('htlc_lock' as const), lockId: lockIdArb, tokenId: tokenIdArb, amount: fc.bigInt({ min: 1n, max: 2_000n }), mode: fc.constantFrom('instant' as const, 'async' as const, 'none' as const) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('htlc_resolve' as const), lockId: lockIdArb, outcome: fc.constantFrom('secret' as const, 'error' as const) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('swap_offer' as const), offerId: offerIdArb, giveTokenId: swapTokenPairArb.map(([give]) => give), wantTokenId: swapTokenPairArb.map(([, want]) => want), amount: swapAmountArb }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('swap_cancel' as const), offerId: offerIdArb }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('cross_pull_lock' as const), orderId: fc.integer({ min: 1, max: 3 }), tokenId: tokenIdArb, amount: fc.bigInt({ min: 10n, max: 2_000n }) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('rebalance_policy' as const), tokenId: tokenIdArb, policyVersion: fc.integer({ min: 1, max: 3 }), baseFee: fc.bigInt({ min: 0n, max: 5n }), liquidityFeeBps: fc.bigInt({ min: 0n, max: 100n }), gasFee: fc.bigInt({ min: 0n, max: 3n }) }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('request_collateral' as const), tokenId: tokenIdArb, amount: fc.bigInt({ min: 20n, max: 500n }), feeAmount: fc.bigInt({ min: 1n, max: 9n }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('rebalance_refund' as const), tokenId: tokenIdArb }) },
);
const opArb = fc.oneof(
  { weight: 28, arbitrary: fc.record({ kind: fc.constant('admit' as const), side: sideArb, txs: fc.array(txSpecArb, { minLength: 1, maxLength: 5 }) }) },
  { weight: 24, arbitrary: fc.record({ kind: fc.constant('propose' as const), side: sideArb }) },
  { weight: 16, arbitrary: fc.record({ kind: fc.constant('deliver' as const), side: sideArb }) },
  { weight: 12, arbitrary: fc.record({ kind: fc.constant('ack' as const), side: sideArb }) },
  { weight: 20, arbitrary: fc.record({ kind: fc.constant('jclaim' as const), side: sideArb, jHeight: fc.integer({ min: 1, max: 9 }), blockByte: fc.integer({ min: 0, max: 255 }) }) },
);
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 40 });

describe('proofs/C2 hot-vs-cold account roots', () => {
  test('regression corpus keeps every covered protocol path hot==cold', async () => {
    const coverage = newCoverageLedger();
    for (const sequence of REGRESSION_SEQUENCES) {
      await runSequence(sequence.ops, `regression:${sequence.name}`, coverage);
    }
    // Coverage floors (c2-adversary A2/A7): the corpus must make every
    // in-profile-writable state collection non-empty and shrink every
    // collection with an in-profile REMOVE op (Patricia delete path on a
    // non-empty tree).
    for (const field of [
      'deltas', 'locks', 'pulls', 'swapOffers', 'requestedRebalance',
      'requestedRebalanceFeeState', 'rebalanceFeePolicies',
    ] as const) {
      expect(coverage.nonEmpty.has(field), `corpus non-empty ${field}`).toBe(true);
    }
    for (const field of ['locks', 'swapOffers', 'requestedRebalance', 'requestedRebalanceFeeState'] as const) {
      expect(coverage.shrank.has(field), `corpus delete-path ${field}`).toBe(true);
    }
    // No in-profile tx writes these (lending is out of profile per FX-2;
    // subcontracts/pendingWithdrawals/shadow maps have no Account-machine
    // writer): their map-level hot==cold is checked, non-emptiness is a
    // documented residual gap, not an asserted property.
  });

  test('conflicting j_event_claim is typed rejected at admission, committed roots stay hot==cold', async () => {
    // fast-check (seed 42, run 79 / seed 31337, run 43) found that a locally
    // admitted second j_event_claim with the same jHeight but different event
    // bytes used to be a bare propose throw (C2 finding F1). FX-3 (D4) moved
    // the verdict to admission itself: the conflicting claim never enters the
    // mempool and the enqueue result carries the typed rejection, so this pin
    // asserts the typed admission verdict instead of the earlier
    // admit-then-drop-at-propose expectation. The proposal-window drop half
    // of D4 (stale admitted claims) is pinned below and by the FX-3 vector
    // suite core/__tests__/account/j-claims/j-claim-admission-vectors.test.ts.
    //
    // Minimal sequence is 7 ops (c2-adversary A8): admitClaim, propose,
    // deliver, ack, admitClaim(conflict), admit payment, propose. The payment
    // is load-bearing: without a second valid tx a propose that drops the
    // claim would return an empty proposal and could not discriminate
    // "typed reject + continue" from "nothing to propose".
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
    const surviving = await harness.step({ kind: 'propose', side: 'alpha' });
    expect(surviving, 'finding-pin propose did not throw and did propose').toBeDefined();
    expect(harness.mempoolTypes('alpha')).toEqual([]);
    expect(harness.pendingTxTypes('alpha')).toEqual(['direct_payment']);
    harness.checkAll('conflict-rejected');
  });

  test('D4 j-claim vectors: typed rejects and window drops stay hot==cold', async () => {
    // Owner decision D4 (proofs/readme.md): four mandatory vectors. The L1
    // verdict suite is core/__tests__/account/j-claims/j-claim-admission-
    // vectors.test.ts; this pin re-runs them through the C2 harness so every
    // typed-rejection and window-drop boundary is also checked hot==cold
    // after each step.
    const commitPeerClaim = async (harness: BilateralHarness, height: number, blockByte: number): Promise<void> => {
      const admitted = await harness.admitClaim('beta', height, blockByte);
      expect(admitted.ok && admitted.admittedAccountTxCount).toBe(1);
      await harness.step({ kind: 'propose', side: 'beta' });
      await harness.step({ kind: 'deliver', side: 'beta' });
      await harness.step({ kind: 'ack', side: 'alpha' });
      harness.checkAll(`d4-commit-${height}`);
    };

    // (b) two conflicts in ONE batch: both rows typed rejected at their own
    // indexes, the survivor payment admitted, mempool clean.
    const batchHarness = new BilateralHarness();
    await commitPeerClaim(batchHarness, 5, 0x77);
    const peerSide = batchHarness.entitySide('alpha') === 'left' ? 'right' : 'left';
    const batch = await batchHarness.admitRaw('alpha', [
      batchHarness.buildClaimTx('alpha', 5, 0x55),
      batchHarness.paymentTx('alpha', 1n),
      batchHarness.buildClaimTx('alpha', 5, 0x66),
    ]);
    expect(batch.ok).toBe(true);
    expect(batch.ok ? batch.admittedAccountTxCount : undefined).toBe(1);
    expect(batch.ok ? batch.admissionRejections?.map(rejection => rejection.index) : undefined)
      .toEqual([0, 2]);
    for (const rejection of batch.ok ? batch.admissionRejections ?? [] : []) {
      expect(rejection.code).toBe('ACCOUNT_TX_VALIDATION');
      expect(rejection.message).toBe(`ACCOUNT_J_CLAIM_${peerSide.toUpperCase()}_CONFLICT:${peerSide}:5`);
    }
    expect(batchHarness.mempoolTypes('alpha')).toEqual(['direct_payment']);
    batchHarness.checkAll('d4-two-conflicts');

    // (c) the same observation the peer already committed is not a duplicate
    // on our side: it is the closing half of the 2-of-2 agreement, so it is
    // admitted once (j-claim-transition.ts planAccountJClaimLocalAdmission).
    // Re-admitting it while it is queued is the idempotent skip, no rejection row.
    const closingHalf = await batchHarness.admitClaim('alpha', 5, 0x77);
    expect(closingHalf.ok).toBe(true);
    expect(closingHalf.ok ? closingHalf.admittedAccountTxCount : undefined).toBe(1);
    expect(closingHalf.ok ? closingHalf.admissionRejections : 'absent').toBeUndefined();
    const duplicate = await batchHarness.admitClaim('alpha', 5, 0x77);
    expect(duplicate.ok).toBe(true);
    expect(duplicate.ok ? duplicate.admittedAccountTxCount : undefined).toBe(0);
    expect(duplicate.ok ? duplicate.admissionRejections : 'absent').toBeUndefined();
    expect(batchHarness.mempoolTypes('alpha')).toEqual(['direct_payment', 'j_event_claim']);
    batchHarness.checkAll('d4-exact-duplicate');

    // (d) stale admitted claim after an incoming frame: the proposal window
    // drops exactly that row with a typed disposition and the account lives on.
    const staleHarness = new BilateralHarness();
    const admitted = await staleHarness.admitRaw('alpha', [
      staleHarness.buildClaimTx('alpha', 5, 0x55),
      staleHarness.paymentTx('alpha', 1n),
    ]);
    expect(admitted.ok && admitted.admittedAccountTxCount).toBe(2);
    await commitPeerClaim(staleHarness, 5, 0x77);
    const stalePeerSide = staleHarness.entitySide('alpha') === 'left' ? 'right' : 'left';
    const proposal = await staleHarness.step({ kind: 'propose', side: 'alpha' });
    expect(proposal).toBeDefined();
    expect(proposal && 'proposalDroppedTransactions' in proposal ? proposal.proposalDroppedTransactions : undefined)
      .toEqual([{
        index: 0,
        txDigest: expect.any(String),
        code: 'ACCOUNT_TX_VALIDATION',
        message: `ACCOUNT_J_CLAIM_${stalePeerSide.toUpperCase()}_CONFLICT:${stalePeerSide}:5`,
        disposition: 'removed',
      }]);
    expect(staleHarness.pendingTxTypes('alpha')).toEqual(['direct_payment']);
    expect(staleHarness.mempoolTypes('alpha')).toEqual([]);
    staleHarness.checkAll('d4-stale-window-drop');
  });

  test('duplicate-pullId cross_pull_lock halts at proposal (finding C2-H2, current behavior)', async () => {
    // Found by the hardened generator (seed 20260826, 100 runs): local enqueue
    // admits two cross_pull_lock txs with the same pullId but different
    // amounts (mempool fingerprint dedup only catches exact bytes), and the
    // second one then trips the deliberate proposal tripwire
    // CROSS_J_PULL_LOCK_PROPOSAL_FAILED (halt_runtime) instead of a typed
    // row rejection. Production pulls come from the deterministic Entity
    // command planner, but a current board may submit AccountTx directly —
    // the same authority class as F1/FX-3. Availability candidate on owner
    // decision; this pin holds the current halt behavior and proves the
    // committed roots stay hot==cold up to the halt.
    const harness = new BilateralHarness();
    const first = await harness.admitRaw('alpha', [harness.buildPullLockTx('alpha', 2, 4, 150n)]);
    expect(first.ok && first.admittedAccountTxCount).toBe(1);
    harness.checkAll('c2-h2 step-1');
    const second = await harness.admitRaw('alpha', [harness.buildPullLockTx('alpha', 2, 4, 1_213n)]);
    expect(second.ok && second.admittedAccountTxCount).toBe(1);
    harness.checkAll('c2-h2 step-2');
    await expect(harness.step({ kind: 'propose', side: 'alpha' })).rejects.toThrow('CROSS_J_PULL_LOCK_PROPOSAL_FAILED');
    harness.checkAll('c2-h2 halted-but-committed-roots-consistent');
  });

  for (const { seed, runs } of [
    { seed: 42, runs: Number(process.env.XLN_C2_RUNS ?? 100) },
    { seed: 2026_0826, runs: Number(process.env.XLN_C2_RUNS ?? 100) },
    { seed: 31_337, runs: Number(process.env.XLN_C2_RUNS ?? 100) },
  ]) {
    test(`fast-check: hot roots equal cold recomputation (seed ${seed}, ${runs} runs, <=40 ops)`, { timeout: 1_200_000 }, async () => {
      const coverage = newCoverageLedger();
      await fc.assert(
        fc.asyncProperty(opsArb, async ops => runSequence(ops, `seed:${seed}`, coverage)),
        { seed, numRuns: runs, endOnFailure: true },
      );
      // Observed (not asserted) coverage for the report: per-seed floors are
      // pinned only in the deterministic corpus test above.
      console.log(
        `seed ${seed} coverage: nonEmpty=[${[...coverage.nonEmpty].sort().join(',')}] `
        + `shrank=[${[...coverage.shrank].sort().join(',')}] `
        + `ops={${[...coverage.opCounts.entries()].map(([kind, count]) => `${kind}:${count}`).join(',')}}`,
      );
    });
  }
});
