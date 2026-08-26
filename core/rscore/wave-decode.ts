/**
 * Strict decoder for one authoritative wave.
 *
 * The runtime relays what this returns: a frame it hands to a counterparty, a
 * verdict it acts on, an effect it publishes. Reading a field by position and
 * trusting its type would let a shifted index or a wrong-width identifier
 * travel as if it were the real thing, so every value here is checked for
 * kind, arity and length before it becomes a model object.
 *
 * The transcript re-encoder below is the other half: it rebuilds the wire
 * bytes from the decoded model and hashes them. If this file decodes a
 * transaction into something that does not encode back to the same bytes, the
 * parity digest disagrees with the engine's and the driver halts — which is
 * how a silent codec asymmetry is caught rather than shipped.
 *
 * Parity target: `crates/process/src/wire_encode.rs` (`wave`, `proposal`,
 * `input_result`, `verdict`, `tx`, `delta`, `dropped`, `account_output`).
 */

import { createHash } from '../support/platform-crypto';
import { packWireValue, type RscoreWireValue } from './process-wire-value';
import {
  decodeRscoreAccountTx,
  rscoreWireBig,
  rscoreWireBool,
  rscoreWireBytes,
  rscoreWireDecodeFail,
  rscoreWireHex,
  rscoreWireInt,
  rscoreWireList,
  rscoreWireOptionalText,
  rscoreWireText,
  rscoreWireTuple,
  rscoreWireUint,
} from './account-tx-wire-decode';
import { RSCORE_CUTOVER_VERIFY } from './cutover/verify';
import {
  decodeRscoreCheckpointChanges,
  type RscoreCheckpointChanges,
} from './checkpoint/checkpoint-wire';
import { decodeRscoreWavePostAccount } from './checkpoint/wave-checkpoint-decode';
import type { RscoreAccountCheckpointRow } from './checkpoint/wave-checkpoint-decode';
import { accountTxWire, type ShadowOutputRow } from './shadow-wire';
import type { AccountFrame, Delta } from '../types/account';

export { decodeRscoreAccountTx };

const WAVE_PARITY_DOMAIN = 'xln.rscore.wave-parity.v2';

type WaveDroppedRow = {
  index: number;
  txDigest: string;
  code: string;
  message: string;
  disposition: 'deferred' | 'removed';
};

type WaveProposal = {
  accountId: string;
  /** Absent when every transaction in the window was rejected. */
  frame: (AccountFrame & { hanko: string }) | null;
  dropped: WaveDroppedRow[];
  /** The proof this proposal travels with, when it carries one. */
  dispute: WaveDisputeDraft | null;
  /**
   * The acknowledgement this proposal also carries, which makes what the
   * publisher sends a `frame_ack` rather than a `frame`.
   */
  bundledAck: Readonly<{
    height: number;
    frameHash: string;
    dispute: WaveDisputeDraft | null;
  }> | null;
  /**
   * What the proposer publishes the moment it signs, before any
   * acknowledgement exists: the window's transaction events, which the Entity
   * frame commits, and the outputs it acts on immediately — a revealed
   * secret, a resting order. The frame's committed effects are released with
   * the peer's ack instead, which is where `ackCommitted` carries them.
   */
  events: string[];
  outputs: WaveOutput[];
  /** Exact Account-owned failures that drive same-frame Entity resolution. */
  failedHtlcLocks: Array<Readonly<{
    hashlock: string;
    lockId: string;
    reason: string;
    upstreamResolution: Readonly<{
      accountId: string;
      lockId: string;
      reason: string;
    }> | null;
  }>>;
};

/**
 * What one applied transaction made observable outside AccountState, decoded
 * into named fields with an exact arity per variant.
 *
 * The runtime publishes these: a forward becomes a payment on the next hop, a
 * revealed secret settles an upstream lock. A positional `unknown[]` would let
 * a shifted field travel as a route or an amount, so every variant is read by
 * name and re-encoded from the same model for the parity digest.
 *
 * Parity target: `account_output` in crates/process/src/wire_encode.rs, and
 * `shadowOutputRows` in shadow-wire.ts, which is the TypeScript projection
 * these are compared against.
 */
export type WaveOutput =
  | {
      kind: 'directPaymentForward';
      tokenId: number;
      amount: string;
      route: string[];
      description: string | null;
      /**
       * A forward exists only where a trusted payment commits at its gateway
       * (`AccountOutput` in types/account.ts, and the Rust handler that builds
       * it). The wire can spell `direct`; the model cannot, so a `direct`
       * forward is refused rather than carried into the runtime.
       */
      deliveryMode: 'trusted';
      trustedGatewayEntityId: string;
    }
  | { kind: 'htlcSecret'; lockId: string; hashlock: string; secret: string; tokenId: number; amount: string }
  | {
      kind: 'htlcError';
      lockId: string;
      hashlock: string;
      tokenId: number;
      amount: string;
      reason: string | null;
    }
  | { kind: 'swapOfferUpsert'; offer: WaveSwapOffer }
  | { kind: 'swapOfferRemove'; offerId: string }
  | { kind: 'swapCancelRequest'; offerId: string };

type WaveSwapOffer = {
  offerId: string;
  leftEntity: string;
  rightEntity: string;
  giveTokenId: number;
  giveTokenDecimals: number;
  giveAmount: string;
  wantTokenId: number;
  wantTokenDecimals: number;
  wantAmount: string;
  maxFee: string;
  minNetReceive: string;
  priceTicks: string;
  timeInForce: number | null;
  /** 0 when the maker is the LEFT entity, 1 when it is the RIGHT one. */
  makerIsRight: 0 | 1;
  createdHeight: number;
  quantizedGive: string;
  quantizedWant: string;
};

/**
 * The recovery proof an acknowledgement or proposal travels with.
 *
 * It rides on the verdict because the publisher sends it: reading it back out
 * of the account afterwards would mean the account body has to come back
 * across the wire for every operation, which is the whole cost this avoids.
 */
export type WaveDisputeDraft = {
  hash: string;
  proofBodyHash: string;
  nonce: number;
  proposerIsLeft: boolean;
};

type WaveFrameVerdict =
  | {
      kind: 'frameCommitted';
      height: number;
      stateHash: string;
      ackHanko: string;
      /** The proof our acknowledgement of this frame carries, if any. */
      ackDispute: WaveDisputeDraft | null;
      outputs: WaveOutput[];
      /**
       * Present when our own same-height proposal lost the collision: the
       * frame it discarded and how much of it went back on the queue. The
       * publisher names both in the events the Entity frame commits.
       */
      rolledBack: Readonly<{ height: number; restored: number; proposed: number }> | null;
      committedFrame: WaveCommittedFrame;
      /**
       * Exactly what the committed transactions said they did. The Entity
       * frame hashes these strings, so the publisher relays them rather than
       * writing its own.
       */
      events: string[];
    }
  | { kind: 'frameCollisionIgnored'; height: number; queued: number }
  | {
      kind: 'frameDuplicate';
      height: number;
      stateHash: string;
      ackHanko: string;
      ackDispute: WaveDisputeDraft | null;
    }
  | { kind: 'frameStale'; height: number; currentHeight: number }
  | { kind: 'frameRejected'; reason: string };

type WaveAckVerdict =
  | {
      kind: 'ackCommitted';
      height: number;
      stateHash: string;
      outputs: WaveOutput[];
      committedFrame: WaveCommittedFrame;
      /** The pending frame's own events, released with its outputs. */
      events: string[];
    }
  | { kind: 'ackStale'; height: number }
  | { kind: 'ackRejected'; reason: string };

type WaveVerdict =
  | WaveFrameVerdict
  | WaveAckVerdict
  /**
   * The child types are deliberately narrower than `WaveVerdict`: Rust can
   * emit only one ACK verdict followed by one frame verdict here. Accepting a
   * recursive FrameAck or a generic Failed child would create wire states the
   * authoritative transition never produced.
   */
  | { kind: 'frameAckApplied'; ackVerdict: WaveAckVerdict; frameVerdict: WaveFrameVerdict }
  | { kind: 'frameAckRejected'; phase: 'ack' | 'frame'; reason: string }
  | { kind: 'failed'; message: string };

type WaveCommittedFrame = Readonly<{
  frame: AccountFrame;
  committedViaNewFrame: boolean;
}>;

type WaveInputResult = { operationIndex: number; accountId: string; verdict: WaveVerdict };

type WaveAdmissionVerdict =
  | { kind: 'admitted'; count: number }
  | { kind: 'rejected'; code: string; message: string };

type WaveAdmissionResult = Readonly<{
  operationIndex: number;
  accountId: string;
  verdict: WaveAdmissionVerdict;
}>;

export type Wave = {
  revision: number;
  accountsRoot: string;
  applied: WaveInputResult[];
  admissions: WaveAdmissionResult[];
  proposals: WaveProposal[];
  touched: { accountId: string; entityAccountLeaf: string }[];
  /**
   * Full checkpoint node rows for touched Accounts. These are not RestoreExact
   * rows: storage must apply their node changes before constructing the
   * 9-field materialized restore row.
   */
  postAccounts: RscoreAccountCheckpointRow[];
  /** Exact H=1 read models for Accounts first authenticated by this inbound. */
  createdAccounts: RscoreAccountCheckpointRow[];
  /** Exact incremental checkpoint piggybacked on a due outbound visit. */
  checkpoint: RscoreCheckpointChanges | null;
  parityDigest: string;
  /**
   * Wall microseconds inside the engine, so a caller can separate the cost of
   * the work from the cost of reaching it. Deliberately outside the parity
   * digest: it measures this run, not what the two engines must agree on.
   */
  engineMicros: number;
};

// --------------------------------------------------------------- the decoder

const decodeWavePayload = (value: unknown): Wave => {
  const fields = rscoreWireTuple(value, 11, 'wave');
  const applied = rscoreWireList(fields[2], 'wave.applied').map(decodeInputResult);
  const admissions = rscoreWireList(fields[3], 'wave.admissions').map(decodeAdmissionResult);
  const proposals = rscoreWireList(fields[4], 'wave.proposals').map(decodeProposal);
  const touched = rscoreWireList(fields[5], 'wave.touched').map(row => {
    const pair = rscoreWireTuple(row, 2, 'wave.touched.row');
    return {
      accountId: rscoreWireHex(pair[0], 'wave.touched.accountId', 32),
      entityAccountLeaf: rscoreWireHex(pair[1], 'wave.touched.leaf', 32),
    };
  });
  const postAccounts = rscoreWireList(fields[6], 'wave.postAccounts').map(decodeRscoreWavePostAccount);
  const createdAccounts = rscoreWireList(fields[7], 'wave.createdAccounts')
    .map(decodeRscoreWavePostAccount);
  const checkpoint = fields[8] === null ? null : decodeRscoreCheckpointChanges(fields[8]);
  // The generic checkpoint decoder protects the durable token/row envelope.
  // Run the full Account-row decoder here as well so malformed node changes
  // cannot wait until storage to fail after Entity has consumed this reply.
  const checkpointAccounts = (checkpoint?.accounts ?? []).map(decodeRscoreWavePostAccount);
  for (const [name, rows] of [['applied', applied], ['admissions', admissions]] as const) {
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous === undefined || current === undefined) {
        return rscoreWireDecodeFail(`wave.${name}:operationBounds:${index}`);
      }
      if (previous.operationIndex >= current.operationIndex) {
        return rscoreWireDecodeFail(`wave.${name}:operationOrder`);
      }
    }
  }
  const operationIndices = [...applied, ...admissions].map(row => row.operationIndex);
  if (new Set(operationIndices).size !== operationIndices.length) {
    return rscoreWireDecodeFail('wave.operationIndex:duplicate');
  }
  const touchedKeys = touched.map(row => row.accountId);
  const postKeys = postAccounts.map(row => row.accountId);
  const createdKeys = createdAccounts.map(row => row.accountId);
  const checkpointKeys = checkpointAccounts.map(row => row.accountId);
  if (new Set(touchedKeys).size !== touchedKeys.length) return rscoreWireDecodeFail('wave.touched:duplicate');
  if (new Set(postKeys).size !== postKeys.length) return rscoreWireDecodeFail('wave.postAccounts:duplicate');
  if (new Set(createdKeys).size !== createdKeys.length) {
    return rscoreWireDecodeFail('wave.createdAccounts:duplicate');
  }
  if (new Set(checkpointKeys).size !== checkpointKeys.length) {
    return rscoreWireDecodeFail('wave.checkpointAccounts:duplicate');
  }
  for (let index = 1; index < checkpointKeys.length; index += 1) {
    const previous = checkpointKeys[index - 1];
    const current = checkpointKeys[index];
    if (previous === undefined || current === undefined || previous >= current) {
      return rscoreWireDecodeFail('wave.checkpointAccounts:order');
    }
  }
  // Final bodies are optional, but whenever present they describe this exact
  // round head and therefore bind one-for-one to its touched leaves.
  const touchedById = new Map(touched.map(row => [row.accountId, row]));
  if (postAccounts.length !== 0 && touched.length !== postAccounts.length) {
    return rscoreWireDecodeFail('wave.postAccounts:length');
  }
  for (const [index, post] of postAccounts.entries()) {
    const touchedRow = touchedById.get(post.accountId);
    if (
      touchedRow === undefined ||
      touchedRow.accountId !== post.accountId ||
      touchedRow.entityAccountLeaf !== post.entityAccountLeaf
    ) {
      return rscoreWireDecodeFail(`wave.postAccounts:binding:${index}`);
    }
  }
  for (const [index, created] of createdAccounts.entries()) {
    const committedH1 = applied.some(row => {
      if (row.accountId !== created.accountId) return false;
      const verdict = row.verdict.kind === 'frameAckApplied'
        ? row.verdict.frameVerdict
        : row.verdict;
      return verdict.kind === 'frameCommitted' && verdict.height === 1;
    });
    if (!touchedById.has(created.accountId) || !committedH1) {
      return rscoreWireDecodeFail(`wave.createdAccounts:binding:${index}`);
    }
  }
  return {
    revision: rscoreWireUint(fields[0], 'wave.revision'),
    accountsRoot: rscoreWireHex(fields[1], 'wave.accountsRoot', 32),
    applied,
    admissions,
    proposals,
    touched,
    postAccounts,
    createdAccounts,
    checkpoint,
    parityDigest: rscoreWireHex(fields[9], 'wave.parityDigest', 32),
    engineMicros: rscoreWireUint(fields[10], 'wave.engineMicros'),
  };
};

/** Decode and bind every relayed field to Rust's cumulative wave digest. */
export const decodeWave = (value: unknown): Wave => {
  const wave = decodeWavePayload(value);
  if (!RSCORE_CUTOVER_VERIFY) return wave;
  const computed = waveParityDigest(wave);
  if (computed !== wave.parityDigest) {
    return rscoreWireDecodeFail(`wave.parityDigest:${wave.parityDigest}:${computed}`);
  }
  return wave;
};

/** Build fixture digests through the same decoder without accepting them. */
export const waveParityDigestFromWireForTests = (value: unknown): string =>
  waveParityDigest(decodeWavePayload(value));

const decodeRolledBack = (
  value: unknown,
  field: string,
): Readonly<{ height: number; restored: number; proposed: number }> | null => {
  if (value === null) return null;
  const row = rscoreWireTuple(value, 3, field);
  return {
    height: rscoreWireInt(row[0], `${field}.height`),
    restored: rscoreWireInt(row[1], `${field}.restored`),
    proposed: rscoreWireInt(row[2], `${field}.proposed`),
  };
};

const decodeDisputeDraft = (value: unknown, field: string): WaveDisputeDraft | null => {
  if (value === null) return null;
  const row = rscoreWireTuple(value, 4, field);
  return {
    hash: rscoreWireHex(row[0], `${field}.hash`, 32),
    proofBodyHash: rscoreWireHex(row[1], `${field}.proofBodyHash`, 32),
    nonce: rscoreWireInt(row[2], `${field}.nonce`),
    proposerIsLeft: rscoreWireBool(row[3], `${field}.proposerIsLeft`),
  };
};

const decodeBundledAck = (value: unknown): WaveProposal['bundledAck'] => {
  if (value === null) return null;
  const row = rscoreWireTuple(value, 3, 'proposal.bundledAck');
  return {
    height: rscoreWireInt(row[0], 'proposal.bundledAck.height'),
    frameHash: rscoreWireHex(row[1], 'proposal.bundledAck.frameHash', 32),
    dispute: decodeDisputeDraft(row[2], 'proposal.bundledAck.dispute'),
  };
};

const decodeProposal = (value: unknown): WaveProposal => {
  const row = rscoreWireTuple(value, 8, 'proposal');
  return {
    accountId: rscoreWireHex(row[0], 'proposal.accountId', 32),
    frame: row[1] === null ? null : decodeFrame(row[1]),
    dropped: rscoreWireList(row[2], 'proposal.dropped').map(decodeDropped),
    dispute: decodeDisputeDraft(row[3], 'proposal.dispute'),
    bundledAck: decodeBundledAck(row[4]),
    events: rscoreWireList(row[5], 'proposal.events')
      .map((entry, index) => rscoreWireText(entry, `proposal.events.${index}`)),
    outputs: rscoreWireList(row[6], 'proposal.outputs').map(decodeOutput),
    failedHtlcLocks: rscoreWireList(row[7], 'proposal.failedHtlcLocks')
      .map((entry, index) => {
        const field = `proposal.failedHtlcLocks.${index}`;
        const failed = rscoreWireTuple(entry, 4, field);
        const resolution = failed[3] === null
          ? null
          : rscoreWireTuple(failed[3], 3, `${field}.upstreamResolution`);
        return {
          hashlock: rscoreWireHex(failed[0], `${field}.hashlock`, 32),
          lockId: rscoreWireText(failed[1], `${field}.lockId`),
          reason: rscoreWireText(failed[2], `${field}.reason`),
          upstreamResolution: resolution === null ? null : {
            accountId: rscoreWireHex(resolution[0], `${field}.upstreamResolution.accountId`, 32),
            lockId: rscoreWireText(resolution[1], `${field}.upstreamResolution.lockId`),
            reason: rscoreWireText(resolution[2], `${field}.upstreamResolution.reason`),
          },
        };
      }),
  };
};

const decodeFrameFields = (row: readonly unknown[], field: string): AccountFrame => ({
  height: rscoreWireInt(row[0], `${field}.height`),
  timestamp: rscoreWireInt(row[1], `${field}.timestamp`),
  jHeight: rscoreWireInt(row[2], `${field}.jHeight`),
  accountTxs: rscoreWireList(row[3], `${field}.txs`).map(decodeRscoreAccountTx),
  prevFrameHash: rscoreWireText(row[4], `${field}.prevFrameHash`),
  accountStateRoot: rscoreWireHex(row[5], `${field}.accountStateRoot`, 32),
  byLeft: rscoreWireBool(row[6], `${field}.byLeft`),
  deltas: rscoreWireList(row[7], `${field}.deltas`).map(decodeDelta),
  stateHash: rscoreWireHex(row[8], `${field}.stateHash`, 32),
});

const decodeFrame = (value: unknown): AccountFrame & { hanko: string } => {
  const row = rscoreWireTuple(value, 10, 'frame');
  return {
    ...decodeFrameFields(row, 'frame'),
    hanko: `0x${Buffer.from(rscoreWireBytes(row[9], 'frame.hanko')).toString('hex')}`,
  };
};

const decodeCommittedFrame = (value: unknown): WaveCommittedFrame => {
  const row = rscoreWireTuple(value, 2, 'committedFrame');
  return {
    frame: decodeFrameFields(rscoreWireTuple(row[0], 9, 'committedFrame.frame'), 'committedFrame.frame'),
    committedViaNewFrame: rscoreWireBool(row[1], 'committedFrame.committedViaNewFrame'),
  };
};

const assertCommittedFrameBinding = (
  evidence: WaveCommittedFrame,
  height: number,
  stateHash: string,
  committedViaNewFrame: boolean,
): WaveCommittedFrame => {
  if (
    evidence.frame.height !== height ||
    evidence.frame.stateHash !== stateHash ||
    evidence.committedViaNewFrame !== committedViaNewFrame
  ) {
    return rscoreWireDecodeFail(
      `committedFrame.binding:${height}:${stateHash}:${String(committedViaNewFrame)}`,
    );
  }
  return evidence;
};

const decodeDelta = (value: unknown): Delta => {
  const row = rscoreWireTuple(value, 10, 'delta');
  return {
    tokenId: rscoreWireInt(row[0], 'delta.tokenId'),
    collateral: rscoreWireBig(row[1], 'delta.collateral'),
    ondelta: rscoreWireBig(row[2], 'delta.ondelta'),
    offdelta: rscoreWireBig(row[3], 'delta.offdelta'),
    leftCreditLimit: rscoreWireBig(row[4], 'delta.leftCreditLimit'),
    rightCreditLimit: rscoreWireBig(row[5], 'delta.rightCreditLimit'),
    leftAllowance: rscoreWireBig(row[6], 'delta.leftAllowance'),
    rightAllowance: rscoreWireBig(row[7], 'delta.rightAllowance'),
    leftHold: rscoreWireBig(row[8], 'delta.leftHold'),
    rightHold: rscoreWireBig(row[9], 'delta.rightHold'),
  };
};

const DISPOSITIONS = ['deferred', 'removed'] as const;

const decodeDropped = (value: unknown): WaveDroppedRow => {
  const row = rscoreWireTuple(value, 5, 'dropped');
  const disposition = DISPOSITIONS[rscoreWireInt(row[4], 'dropped.disposition')];
  if (disposition === undefined) return rscoreWireDecodeFail('dropped.disposition:unknown');
  return {
    index: rscoreWireInt(row[0], 'dropped.index'),
    txDigest: rscoreWireHex(row[1], 'dropped.txDigest', 32),
    code: rscoreWireText(row[2], 'dropped.code'),
    message: rscoreWireText(row[3], 'dropped.message'),
    disposition,
  };
};

const decodeInputResult = (value: unknown): WaveInputResult => {
  const row = rscoreWireTuple(value, 3, 'inputResult');
  return {
    operationIndex: rscoreWireUint(row[0], 'inputResult.operationIndex'),
    accountId: rscoreWireHex(row[1], 'inputResult.accountId', 32),
    verdict: decodeVerdict(row[2]),
  };
};

const decodeAdmissionResult = (value: unknown): WaveAdmissionResult => {
  const row = rscoreWireTuple(value, 3, 'admissionResult');
  const verdict = rscoreWireList(row[2], 'admissionResult.verdict');
  const tag = rscoreWireUint(verdict[0], 'admissionResult.verdict.tag');
  if (tag === 0) {
    const fields = rscoreWireTuple(verdict, 2, 'admissionResult.admitted');
    return {
      operationIndex: rscoreWireUint(row[0], 'admissionResult.operationIndex'),
      accountId: rscoreWireHex(row[1], 'admissionResult.accountId', 32),
      verdict: { kind: 'admitted', count: rscoreWireUint(fields[1], 'admissionResult.count') },
    };
  }
  if (tag === 1) {
    const fields = rscoreWireTuple(verdict, 3, 'admissionResult.rejected');
    return {
      operationIndex: rscoreWireUint(row[0], 'admissionResult.operationIndex'),
      accountId: rscoreWireHex(row[1], 'admissionResult.accountId', 32),
      verdict: {
        kind: 'rejected',
        code: rscoreWireText(fields[1], 'admissionResult.code'),
        message: rscoreWireText(fields[2], 'admissionResult.message'),
      },
    };
  }
  return rscoreWireDecodeFail(`admissionResult.verdict.tag:${tag}`);
};

const decodeFrameVerdict = (value: unknown, field: string): WaveFrameVerdict => {
  const row = rscoreWireList(value, field);
  const tag = rscoreWireInt(row[0], `${field}.tag`);
  switch (tag) {
    case 0: {
      const fields = rscoreWireTuple(row, 9, `${field}.frameCommitted`);
      const height = rscoreWireInt(fields[1], `${field}.height`);
      const stateHash = rscoreWireHex(fields[2], `${field}.stateHash`, 32);
      return {
        kind: 'frameCommitted',
        height,
        stateHash,
        ackHanko: `0x${Buffer.from(rscoreWireBytes(fields[3], `${field}.ackHanko`)).toString('hex')}`,
        outputs: rscoreWireList(fields[4], `${field}.outputs`).map(decodeOutput),
        rolledBack: decodeRolledBack(fields[5], `${field}.rolledBack`),
        committedFrame: assertCommittedFrameBinding(
          decodeCommittedFrame(fields[6]),
          height,
          stateHash,
          true,
        ),
        events: rscoreWireList(fields[7], `${field}.events`)
          .map((entry, index) => rscoreWireText(entry, `${field}.events.${index}`)),
        ackDispute: decodeDisputeDraft(fields[8], `${field}.ackDispute`),
      };
    }
    case 1: {
      const fields = rscoreWireTuple(row, 3, `${field}.collision`);
      return {
        kind: 'frameCollisionIgnored',
        height: rscoreWireInt(fields[1], `${field}.height`),
        queued: rscoreWireInt(fields[2], `${field}.queued`),
      };
    }
    case 2: {
      const fields = rscoreWireTuple(row, 5, `${field}.duplicate`);
      return {
        kind: 'frameDuplicate',
        height: rscoreWireInt(fields[1], `${field}.height`),
        stateHash: rscoreWireHex(fields[2], `${field}.stateHash`, 32),
        ackHanko: `0x${Buffer.from(rscoreWireBytes(fields[3], `${field}.ackHanko`)).toString('hex')}`,
        ackDispute: decodeDisputeDraft(fields[4], `${field}.ackDispute`),
      };
    }
    case 3: {
      const fields = rscoreWireTuple(row, 3, `${field}.stale`);
      return {
        kind: 'frameStale',
        height: rscoreWireInt(fields[1], `${field}.height`),
        currentHeight: rscoreWireInt(fields[2], `${field}.currentHeight`),
      };
    }
    case 4: {
      const fields = rscoreWireTuple(row, 2, `${field}.rejected`);
      return { kind: 'frameRejected', reason: rscoreWireText(fields[1], `${field}.reason`) };
    }
    default:
      return rscoreWireDecodeFail(`${field}.tag:${tag}:frameDomain`);
  }
};

const decodeAckVerdict = (value: unknown, field: string): WaveAckVerdict => {
  const row = rscoreWireList(value, field);
  const tag = rscoreWireInt(row[0], `${field}.tag`);
  switch (tag) {
    case 5: {
      const fields = rscoreWireTuple(row, 6, `${field}.ackCommitted`);
      const height = rscoreWireInt(fields[1], `${field}.height`);
      const stateHash = rscoreWireHex(fields[2], `${field}.stateHash`, 32);
      return {
        kind: 'ackCommitted',
        height,
        stateHash,
        outputs: rscoreWireList(fields[3], `${field}.outputs`).map(decodeOutput),
        committedFrame: assertCommittedFrameBinding(
          decodeCommittedFrame(fields[4]),
          height,
          stateHash,
          false,
        ),
        events: rscoreWireList(fields[5], `${field}.events`)
          .map((entry, index) => rscoreWireText(entry, `${field}.events.${index}`)),
      };
    }
    case 6: {
      const fields = rscoreWireTuple(row, 2, `${field}.ackStale`);
      return { kind: 'ackStale', height: rscoreWireInt(fields[1], `${field}.height`) };
    }
    case 7: {
      const fields = rscoreWireTuple(row, 2, `${field}.ackRejected`);
      return { kind: 'ackRejected', reason: rscoreWireText(fields[1], `${field}.reason`) };
    }
    default:
      return rscoreWireDecodeFail(`${field}.tag:${tag}:ackDomain`);
  }
};

const FRAME_ACK_PHASES = ['ack', 'frame'] as const;

const decodeVerdict = (value: unknown): WaveVerdict => {
  const row = rscoreWireList(value, 'verdict');
  const tag = rscoreWireInt(row[0], 'verdict.tag');
  if (tag >= 0 && tag <= 4) return decodeFrameVerdict(row, 'verdict');
  if (tag >= 5 && tag <= 7) return decodeAckVerdict(row, 'verdict');
  switch (tag) {
    case 8: {
      const fields = rscoreWireTuple(row, 2, 'verdict.failed');
      return { kind: 'failed', message: rscoreWireText(fields[1], 'verdict.message') };
    }
    case 9: {
      const fields = rscoreWireTuple(row, 3, 'verdict.frameAckApplied');
      return {
        kind: 'frameAckApplied',
        ackVerdict: decodeAckVerdict(fields[1], 'verdict.frameAckApplied.ackVerdict'),
        frameVerdict: decodeFrameVerdict(fields[2], 'verdict.frameAckApplied.frameVerdict'),
      };
    }
    case 10: {
      const fields = rscoreWireTuple(row, 3, 'verdict.frameAckRejected');
      const phaseValue = rscoreWireInt(fields[1], 'verdict.frameAckRejected.phase');
      const phase = FRAME_ACK_PHASES[phaseValue];
      if (phase === undefined) {
        return rscoreWireDecodeFail(`verdict.frameAckRejected.phase:${phaseValue}`);
      }
      return {
        kind: 'frameAckRejected',
        phase,
        reason: rscoreWireText(fields[2], 'verdict.frameAckRejected.reason'),
      };
    }
    default:
      return rscoreWireDecodeFail('verdict.tag:unknown');
  }
};

/**
 * Effects stay in their wire shape: they are compared against the rows the
 * TypeScript engine produced for the same frame, and re-modelling them here
 * would only add a second place for the two shapes to drift.
 */
const decodeOutput = (value: unknown): WaveOutput => {
  const row = rscoreWireList(value, 'output');
  switch (rscoreWireInt(row[0], 'output.tag')) {
    case 0: {
      const fields = rscoreWireTuple(row, 7, 'output.directPaymentForward');
      return {
        kind: 'directPaymentForward',
        tokenId: rscoreWireInt(fields[1], 'output.tokenId'),
        amount: rscoreWireBig(fields[2], 'output.amount').toString(),
        route: rscoreWireList(fields[3], 'output.route').map((hop, index) => rscoreWireText(hop, `output.route.${index}`)),
        description: rscoreWireOptionalText(fields[4], 'output.description'),
        deliveryMode: rscoreWireInt(fields[5], 'output.deliveryMode') === 1
          ? 'trusted'
          : rscoreWireDecodeFail(`output.deliveryMode:${String(fields[5])}`),
        trustedGatewayEntityId: rscoreWireText(fields[6], 'output.trustedGatewayEntityId'),
      };
    }
    case 1: {
      const fields = rscoreWireTuple(row, 6, 'output.htlcSecret');
      return {
        kind: 'htlcSecret',
        lockId: rscoreWireText(fields[1], 'output.lockId'),
        hashlock: rscoreWireText(fields[2], 'output.hashlock'),
        secret: rscoreWireText(fields[3], 'output.secret'),
        tokenId: rscoreWireInt(fields[4], 'output.tokenId'),
        amount: rscoreWireBig(fields[5], 'output.amount').toString(),
      };
    }
    case 2: {
      const fields = rscoreWireTuple(row, 6, 'output.htlcError');
      return {
        kind: 'htlcError',
        lockId: rscoreWireText(fields[1], 'output.lockId'),
        hashlock: rscoreWireText(fields[2], 'output.hashlock'),
        tokenId: rscoreWireInt(fields[3], 'output.tokenId'),
        amount: rscoreWireBig(fields[4], 'output.amount').toString(),
        reason: rscoreWireOptionalText(fields[5], 'output.reason'),
      };
    }
    case 3: {
      const fields = rscoreWireTuple(row, 18, 'output.swapOfferUpsert');
      const makerIsRight = rscoreWireInt(fields[14], 'output.makerIsRight');
      if (makerIsRight !== 0 && makerIsRight !== 1) return rscoreWireDecodeFail(`output.makerIsRight:${makerIsRight}`);
      return {
        kind: 'swapOfferUpsert',
        offer: {
          offerId: rscoreWireText(fields[1], 'output.offerId'),
          leftEntity: rscoreWireText(fields[2], 'output.leftEntity'),
          rightEntity: rscoreWireText(fields[3], 'output.rightEntity'),
          giveTokenId: rscoreWireInt(fields[4], 'output.giveTokenId'),
          giveTokenDecimals: rscoreWireInt(fields[5], 'output.giveTokenDecimals'),
          giveAmount: rscoreWireBig(fields[6], 'output.giveAmount').toString(),
          wantTokenId: rscoreWireInt(fields[7], 'output.wantTokenId'),
          wantTokenDecimals: rscoreWireInt(fields[8], 'output.wantTokenDecimals'),
          wantAmount: rscoreWireBig(fields[9], 'output.wantAmount').toString(),
          maxFee: rscoreWireBig(fields[10], 'output.maxFee').toString(),
          minNetReceive: rscoreWireBig(fields[11], 'output.minNetReceive').toString(),
          priceTicks: rscoreWireBig(fields[12], 'output.priceTicks').toString(),
          timeInForce: fields[13] === null ? null : rscoreWireInt(fields[13], 'output.timeInForce'),
          makerIsRight,
          createdHeight: rscoreWireInt(fields[15], 'output.createdHeight'),
          quantizedGive: rscoreWireBig(fields[16], 'output.quantizedGive').toString(),
          quantizedWant: rscoreWireBig(fields[17], 'output.quantizedWant').toString(),
        },
      };
    }
    case 4: {
      const fields = rscoreWireTuple(row, 2, 'output.swapOfferRemove');
      return { kind: 'swapOfferRemove', offerId: rscoreWireText(fields[1], 'output.offerId') };
    }
    case 5: {
      const fields = rscoreWireTuple(row, 2, 'output.swapCancelRequest');
      return { kind: 'swapCancelRequest', offerId: rscoreWireText(fields[1], 'output.offerId') };
    }
    default:
      return rscoreWireDecodeFail(`output.tag:${String(row[0])}`);
  }
};

/**
 * The output codec on its own, for the corpus that holds every variant to its
 * arity and to the bytes it arrived as. The wave path reaches these through
 * `decodeWave`; nothing else should.
 */
export const decodeWaveOutputForTests = (value: unknown): WaveOutput => decodeOutput(value);
export const waveOutputWireForTests = (output: WaveOutput): RscoreWireValue => outputWire(output);

/**
 * The same output as the row `shadowOutputRows` builds from the TypeScript
 * transition, so the driver compares two projections of the same shape rather
 * than eyeballing two different ones.
 */
export const waveOutputRow = (output: WaveOutput): ShadowOutputRow => {
  switch (output.kind) {
    case 'directPaymentForward':
      return [
        'forward',
        output.tokenId,
        output.amount,
        output.route,
        output.description,
        output.deliveryMode,
        output.trustedGatewayEntityId,
      ];
    case 'htlcSecret':
      return ['secret', output.lockId, output.hashlock, output.secret, output.tokenId, output.amount];
    case 'htlcError':
      return ['error', output.lockId, output.hashlock, output.tokenId, output.amount, output.reason];
    case 'swapOfferUpsert': {
      const offer = output.offer;
      return [
        'offerUpsert',
        offer.offerId,
        offer.leftEntity,
        offer.rightEntity,
        offer.giveTokenId,
        offer.giveTokenDecimals,
        offer.giveAmount,
        offer.wantTokenId,
        offer.wantTokenDecimals,
        offer.wantAmount,
        offer.maxFee,
        offer.minNetReceive,
        offer.priceTicks,
        offer.timeInForce,
        offer.makerIsRight,
        offer.createdHeight,
        offer.quantizedGive,
        offer.quantizedWant,
      ];
    }
    case 'swapOfferRemove':
      return ['offerRemove', output.offerId];
    case 'swapCancelRequest':
      return ['cancelRequest', output.offerId];
  }
};

// ------------------------------------------------------------ the transcript

const hexToBytes = (value: string, code: string): Uint8Array => {
  const raw = value.startsWith('0x') ? value.slice(2) : value;
  if (raw.length % 2 !== 0 || !/^[0-9a-f]*$/.test(raw)) rscoreWireDecodeFail(`${code}:hex`);
  return Uint8Array.from(Buffer.from(raw, 'hex'));
};

const deltaWire = (delta: Delta): RscoreWireValue[] => [
  delta.tokenId,
  delta.collateral.toString(),
  delta.ondelta.toString(),
  delta.offdelta.toString(),
  delta.leftCreditLimit.toString(),
  delta.rightCreditLimit.toString(),
  delta.leftAllowance.toString(),
  delta.rightAllowance.toString(),
  delta.leftHold.toString(),
  delta.rightHold.toString(),
];

const frameBodyWire = (frame: AccountFrame): RscoreWireValue[] => [
  frame.height,
  frame.timestamp,
  frame.jHeight,
  frame.accountTxs.map(tx => {
    const wire = accountTxWire(tx);
    if (wire === null) return rscoreWireDecodeFail('transcript.tx:unsupported');
    return wire;
  }),
  frame.prevFrameHash,
  hexToBytes(frame.accountStateRoot, 'transcript.accountStateRoot'),
  frame.byLeft,
  frame.deltas.map(deltaWire),
  hexToBytes(frame.stateHash, 'transcript.stateHash'),
];

const frameWire = (frame: AccountFrame & { hanko: string }): RscoreWireValue => [
  ...frameBodyWire(frame),
  hexToBytes(frame.hanko, 'transcript.hanko'),
];

const committedFrameWire = (evidence: WaveCommittedFrame): RscoreWireValue => [
  frameBodyWire(evidence.frame),
  evidence.committedViaNewFrame,
];

const droppedWire = (row: WaveDroppedRow): RscoreWireValue => [
  row.index,
  hexToBytes(row.txDigest, 'transcript.txDigest'),
  row.code,
  row.message,
  row.disposition === 'deferred' ? 0 : 1,
];

const outputWire = (output: WaveOutput): RscoreWireValue => {
  switch (output.kind) {
    case 'directPaymentForward':
      return [
        0,
        output.tokenId,
        output.amount,
        [...output.route],
        output.description,
        1,
        output.trustedGatewayEntityId,
      ];
    case 'htlcSecret':
      return [1, output.lockId, output.hashlock, output.secret, output.tokenId, output.amount];
    case 'htlcError':
      return [2, output.lockId, output.hashlock, output.tokenId, output.amount, output.reason];
    case 'swapOfferUpsert': {
      const offer = output.offer;
      return [
        3,
        offer.offerId,
        offer.leftEntity,
        offer.rightEntity,
        offer.giveTokenId,
        offer.giveTokenDecimals,
        offer.giveAmount,
        offer.wantTokenId,
        offer.wantTokenDecimals,
        offer.wantAmount,
        offer.maxFee,
        offer.minNetReceive,
        offer.priceTicks,
        offer.timeInForce,
        offer.makerIsRight,
        offer.createdHeight,
        offer.quantizedGive,
        offer.quantizedWant,
      ];
    }
    case 'swapOfferRemove':
      return [4, output.offerId];
    case 'swapCancelRequest':
      return [5, output.offerId];
  }
};

const disputeDraftWire = (draft: WaveDisputeDraft | null): RscoreWireValue =>
  draft === null
    ? null
    : [
        hexToBytes(draft.hash, 'transcript.dispute.hash'),
        hexToBytes(draft.proofBodyHash, 'transcript.dispute.proofBodyHash'),
        draft.nonce,
        draft.proposerIsLeft,
      ];

const frameVerdictWire = (verdict: WaveFrameVerdict): RscoreWireValue => {
  switch (verdict.kind) {
    case 'frameCommitted':
      return [
        0,
        verdict.height,
        hexToBytes(verdict.stateHash, 'transcript.stateHash'),
        hexToBytes(verdict.ackHanko, 'transcript.ackHanko'),
        verdict.outputs.map(outputWire),
        verdict.rolledBack === null
          ? null
          : [verdict.rolledBack.height, verdict.rolledBack.restored, verdict.rolledBack.proposed],
        committedFrameWire(verdict.committedFrame),
        [...verdict.events],
        disputeDraftWire(verdict.ackDispute),
      ];
    case 'frameCollisionIgnored':
      return [1, verdict.height, verdict.queued];
    case 'frameDuplicate':
      return [
        2,
        verdict.height,
        hexToBytes(verdict.stateHash, 'transcript.stateHash'),
        hexToBytes(verdict.ackHanko, 'transcript.ackHanko'),
        disputeDraftWire(verdict.ackDispute),
      ];
    case 'frameStale':
      return [3, verdict.height, verdict.currentHeight];
    case 'frameRejected':
      return [4, verdict.reason];
  }
};

const ackVerdictWire = (verdict: WaveAckVerdict): RscoreWireValue => {
  switch (verdict.kind) {
    case 'ackCommitted':
      return [
        5,
        verdict.height,
        hexToBytes(verdict.stateHash, 'transcript.stateHash'),
        verdict.outputs.map(outputWire),
        committedFrameWire(verdict.committedFrame),
        [...verdict.events],
      ];
    case 'ackStale':
      return [6, verdict.height];
    case 'ackRejected':
      return [7, verdict.reason];
  }
};

const verdictWire = (verdict: WaveVerdict): RscoreWireValue => {
  switch (verdict.kind) {
    case 'frameCommitted':
    case 'frameCollisionIgnored':
    case 'frameDuplicate':
    case 'frameStale':
    case 'frameRejected':
      return frameVerdictWire(verdict);
    case 'ackCommitted':
    case 'ackStale':
    case 'ackRejected':
      return ackVerdictWire(verdict);
    case 'frameAckApplied':
      return [
        9,
        ackVerdictWire(verdict.ackVerdict),
        frameVerdictWire(verdict.frameVerdict),
      ];
    case 'frameAckRejected':
      return [10, verdict.phase === 'ack' ? 0 : 1, verdict.reason];
    case 'failed':
      return [8, verdict.message];
  }
};

const admissionVerdictWire = (verdict: WaveAdmissionVerdict): RscoreWireValue => {
  switch (verdict.kind) {
    case 'admitted': return [0, verdict.count];
    case 'rejected': return [1, verdict.code, verdict.message];
  }
};

/**
 * The wave's whole result in one hash, rebuilt from the decoded model rather
 * than from the bytes that arrived. Equal to the engine's digest only if this
 * side decoded every field into something that encodes back identically —
 * which is the property the driver actually needs before it relays a frame.
 *
 * Parity target: `parity_digest` (crates/process/src/wire_encode.rs).
 */
export const waveParityDigest = (wave: Wave): string => {
  const transcript: RscoreWireValue = [
    hexToBytes(wave.accountsRoot, 'transcript.accountsRoot'),
    wave.touched.map(row => [
      hexToBytes(row.accountId, 'transcript.accountId'),
      hexToBytes(row.entityAccountLeaf, 'transcript.leaf'),
    ]),
    wave.applied.map(row => [
      row.operationIndex,
      hexToBytes(row.accountId, 'transcript.accountId'),
      verdictWire(row.verdict),
    ]),
    wave.admissions.map(row => [
      row.operationIndex,
      hexToBytes(row.accountId, 'transcript.accountId'),
      admissionVerdictWire(row.verdict),
    ]),
    wave.proposals.map(row => [
      hexToBytes(row.accountId, 'transcript.accountId'),
      row.frame === null ? null : frameWire(row.frame),
      row.dropped.map(droppedWire),
      disputeDraftWire(row.dispute),
      row.bundledAck === null
        ? null
        : [
            row.bundledAck.height,
            hexToBytes(row.bundledAck.frameHash, 'transcript.bundledAck.frameHash'),
            disputeDraftWire(row.bundledAck.dispute),
          ],
      [...row.events],
      row.outputs.map(outputWire),
      row.failedHtlcLocks.map(failed => [
        hexToBytes(failed.hashlock, 'transcript.failedHtlcLock.hashlock'),
        failed.lockId,
        failed.reason,
        failed.upstreamResolution === null
          ? null
          : [
              hexToBytes(
                failed.upstreamResolution.accountId,
                'transcript.failedHtlcLock.upstreamResolution.accountId',
              ),
              failed.upstreamResolution.lockId,
              failed.upstreamResolution.reason,
            ],
      ]),
    ]),
    wave.createdAccounts.map(row => [
      hexToBytes(row.accountId, 'transcript.createdAccountId'),
      hexToBytes(row.entityAccountLeaf, 'transcript.createdAccountLeaf'),
    ]),
  ];
  const digest = createHash('sha256');
  digest.update(WAVE_PARITY_DOMAIN);
  digest.update(packWireValue(transcript));
  return `0x${digest.digest('hex')}`;
};
