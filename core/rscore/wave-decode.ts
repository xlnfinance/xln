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
import { packWireValue, type RscoreWireValue } from './client';
import { accountTxWire, type ShadowOutputRow } from './shadow-wire';
import type { AccountFrame, AccountTx, Delta } from '../types/account';

const WAVE_PARITY_DOMAIN = 'xln.rscore.wave-parity.v1';

export type WaveDroppedRow = {
  index: number;
  txDigest: string;
  code: string;
  message: string;
  disposition: 'deferred' | 'removed';
};

export type WaveProposal = {
  accountId: string;
  /** Absent when every transaction in the window was rejected. */
  frame: (AccountFrame & { hanko: string }) | null;
  dropped: WaveDroppedRow[];
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

export type WaveSwapOffer = {
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

export type WaveVerdict =
  | { kind: 'frameCommitted'; height: number; stateHash: string; ackHanko: string; outputs: WaveOutput[]; rolledBackTxs: number }
  | { kind: 'frameCollisionIgnored'; height: number }
  | { kind: 'frameDuplicate'; height: number; stateHash: string; ackHanko: string }
  | { kind: 'frameStale'; height: number; currentHeight: number }
  | { kind: 'frameRejected'; reason: string }
  | { kind: 'ackCommitted'; height: number; stateHash: string; outputs: WaveOutput[] }
  | { kind: 'ackStale'; height: number }
  | { kind: 'ackRejected'; reason: string }
  | { kind: 'failed'; message: string };

export type WaveInputResult = { inputIndex: number; accountId: string; verdict: WaveVerdict };

export type Wave = {
  revision: number;
  accountsRoot: string;
  applied: WaveInputResult[];
  proposals: WaveProposal[];
  touched: { accountId: string; entityAccountLeaf: string }[];
  parityDigest: string;
  /**
   * Wall microseconds inside the engine, so a caller can separate the cost of
   * the work from the cost of reaching it. Deliberately outside the parity
   * digest: it measures this run, not what the two engines must agree on.
   */
  engineMicros: number;
};

// ------------------------------------------------------------- strict reads

const fail = (code: string): never => {
  throw new Error(`RSCORE_WAVE_DECODE:${code}`);
};

const tupleOf = (value: unknown, arity: number, code: string): unknown[] => {
  if (!Array.isArray(value)) return fail(`${code}:tuple`);
  if (value.length !== arity) return fail(`${code}:arity:${value.length}:${arity}`);
  return value;
};

const list = (value: unknown, code: string): unknown[] =>
  Array.isArray(value) ? value : fail(`${code}:list`);

/**
 * A wire integer as a safe JavaScript number. The engine speaks 64-bit
 * heights and timestamps; silently rounding one past 2^53 would make a frame
 * that hashes differently on the two sides.
 */
const int = (value: unknown, code: string): number => {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
      return fail(`${code}:unsafeInteger`);
    }
    return Number(value);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail(`${code}:integer`);
  return value;
};

const text = (value: unknown, code: string): string =>
  typeof value === 'string' ? value : fail(`${code}:text`);

const bool = (value: unknown, code: string): boolean =>
  typeof value === 'boolean' ? value : fail(`${code}:bool`);

/** A wire flag: 0 or 1, never a msgpack boolean. */
const flag = (value: unknown, code: string): boolean => {
  const parsed = int(value, code);
  if (parsed !== 0 && parsed !== 1) return fail(`${code}:flag:${parsed}`);
  return parsed === 1;
};

const optionalText = (value: unknown, code: string): string | null =>
  value === null ? null : text(value, code);

const bytes = (value: unknown, code: string, length?: number): Uint8Array => {
  if (!(value instanceof Uint8Array)) return fail(`${code}:bytes`);
  if (length !== undefined && value.byteLength !== length) {
    return fail(`${code}:length:${value.byteLength}:${length}`);
  }
  return value;
};

const hex = (value: unknown, code: string, length?: number): string =>
  `0x${Buffer.from(bytes(value, code, length)).toString('hex')}`;

/** A decimal string the engine wrote from a big integer. */
const big = (value: unknown, code: string): bigint => {
  const raw = text(value, code);
  if (!/^-?\d+$/.test(raw)) return fail(`${code}:bigint`);
  return BigInt(raw);
};

// --------------------------------------------------------------- the decoder

export const decodeWave = (value: unknown): Wave => {
  const fields = tupleOf(value, 7, 'wave');
  return {
    revision: int(fields[0], 'wave.revision'),
    accountsRoot: hex(fields[1], 'wave.accountsRoot', 32),
    applied: list(fields[2], 'wave.applied').map(decodeInputResult),
    proposals: list(fields[3], 'wave.proposals').map(decodeProposal),
    touched: list(fields[4], 'wave.touched').map(row => {
      const pair = tupleOf(row, 2, 'wave.touched.row');
      return {
        accountId: hex(pair[0], 'wave.touched.accountId', 32),
        entityAccountLeaf: hex(pair[1], 'wave.touched.leaf', 32),
      };
    }),
    parityDigest: hex(fields[5], 'wave.parityDigest', 32),
    engineMicros: int(fields[6], 'wave.engineMicros'),
  };
};

const decodeProposal = (value: unknown): WaveProposal => {
  const row = tupleOf(value, 3, 'proposal');
  return {
    accountId: hex(row[0], 'proposal.accountId', 32),
    frame: row[1] === null ? null : decodeFrame(row[1]),
    dropped: list(row[2], 'proposal.dropped').map(decodeDropped),
  };
};

const decodeFrame = (value: unknown): AccountFrame & { hanko: string } => {
  const row = tupleOf(value, 10, 'frame');
  return {
    height: int(row[0], 'frame.height'),
    timestamp: int(row[1], 'frame.timestamp'),
    jHeight: int(row[2], 'frame.jHeight'),
    accountTxs: list(row[3], 'frame.txs').map(decodeAccountTx),
    prevFrameHash: text(row[4], 'frame.prevFrameHash'),
    accountStateRoot: hex(row[5], 'frame.accountStateRoot', 32),
    byLeft: bool(row[6], 'frame.byLeft'),
    deltas: list(row[7], 'frame.deltas').map(decodeDelta),
    stateHash: hex(row[8], 'frame.stateHash', 32),
    hanko: `0x${Buffer.from(bytes(row[9], 'frame.hanko')).toString('hex')}`,
  };
};

const decodeDelta = (value: unknown): Delta => {
  const row = tupleOf(value, 10, 'delta');
  return {
    tokenId: int(row[0], 'delta.tokenId'),
    collateral: big(row[1], 'delta.collateral'),
    ondelta: big(row[2], 'delta.ondelta'),
    offdelta: big(row[3], 'delta.offdelta'),
    leftCreditLimit: big(row[4], 'delta.leftCreditLimit'),
    rightCreditLimit: big(row[5], 'delta.rightCreditLimit'),
    leftAllowance: big(row[6], 'delta.leftAllowance'),
    rightAllowance: big(row[7], 'delta.rightAllowance'),
    leftHold: big(row[8], 'delta.leftHold'),
    rightHold: big(row[9], 'delta.rightHold'),
  };
};

const DISPOSITIONS = ['deferred', 'removed'] as const;

const decodeDropped = (value: unknown): WaveDroppedRow => {
  const row = tupleOf(value, 5, 'dropped');
  const disposition = DISPOSITIONS[int(row[4], 'dropped.disposition')];
  if (disposition === undefined) return fail('dropped.disposition:unknown');
  return {
    index: int(row[0], 'dropped.index'),
    txDigest: hex(row[1], 'dropped.txDigest', 32),
    code: text(row[2], 'dropped.code'),
    message: text(row[3], 'dropped.message'),
    disposition,
  };
};

const decodeInputResult = (value: unknown): WaveInputResult => {
  const row = tupleOf(value, 3, 'inputResult');
  return {
    inputIndex: int(row[0], 'inputResult.inputIndex'),
    accountId: hex(row[1], 'inputResult.accountId', 32),
    verdict: decodeVerdict(row[2]),
  };
};

const decodeVerdict = (value: unknown): WaveVerdict => {
  const row = list(value, 'verdict');
  switch (int(row[0], 'verdict.tag')) {
    case 0: {
      const fields = tupleOf(row, 6, 'verdict.frameCommitted');
      return {
        kind: 'frameCommitted',
        height: int(fields[1], 'verdict.height'),
        stateHash: hex(fields[2], 'verdict.stateHash', 32),
        ackHanko: `0x${Buffer.from(bytes(fields[3], 'verdict.ackHanko')).toString('hex')}`,
        outputs: list(fields[4], 'verdict.outputs').map(decodeOutput),
        rolledBackTxs: int(fields[5], 'verdict.rolledBackTxs'),
      };
    }
    case 1: {
      const fields = tupleOf(row, 2, 'verdict.collision');
      return { kind: 'frameCollisionIgnored', height: int(fields[1], 'verdict.height') };
    }
    case 2: {
      const fields = tupleOf(row, 4, 'verdict.duplicate');
      return {
        kind: 'frameDuplicate',
        height: int(fields[1], 'verdict.height'),
        stateHash: hex(fields[2], 'verdict.stateHash', 32),
        ackHanko: `0x${Buffer.from(bytes(fields[3], 'verdict.ackHanko')).toString('hex')}`,
      };
    }
    case 3: {
      const fields = tupleOf(row, 3, 'verdict.stale');
      return {
        kind: 'frameStale',
        height: int(fields[1], 'verdict.height'),
        currentHeight: int(fields[2], 'verdict.currentHeight'),
      };
    }
    case 4: {
      const fields = tupleOf(row, 2, 'verdict.rejected');
      return { kind: 'frameRejected', reason: text(fields[1], 'verdict.reason') };
    }
    case 5: {
      const fields = tupleOf(row, 4, 'verdict.ackCommitted');
      return {
        kind: 'ackCommitted',
        height: int(fields[1], 'verdict.height'),
        stateHash: hex(fields[2], 'verdict.stateHash', 32),
        outputs: list(fields[3], 'verdict.outputs').map(decodeOutput),
      };
    }
    case 6: {
      const fields = tupleOf(row, 2, 'verdict.ackStale');
      return { kind: 'ackStale', height: int(fields[1], 'verdict.height') };
    }
    case 7: {
      const fields = tupleOf(row, 2, 'verdict.ackRejected');
      return { kind: 'ackRejected', reason: text(fields[1], 'verdict.reason') };
    }
    case 8: {
      const fields = tupleOf(row, 2, 'verdict.failed');
      return { kind: 'failed', message: text(fields[1], 'verdict.message') };
    }
    default:
      return fail('verdict.tag:unknown');
  }
};

/**
 * Effects stay in their wire shape: they are compared against the rows the
 * TypeScript engine produced for the same frame, and re-modelling them here
 * would only add a second place for the two shapes to drift.
 */
const decodeOutput = (value: unknown): WaveOutput => {
  const row = list(value, 'output');
  switch (int(row[0], 'output.tag')) {
    case 0: {
      const fields = tupleOf(row, 7, 'output.directPaymentForward');
      return {
        kind: 'directPaymentForward',
        tokenId: int(fields[1], 'output.tokenId'),
        amount: big(fields[2], 'output.amount').toString(),
        route: list(fields[3], 'output.route').map((hop, index) => text(hop, `output.route.${index}`)),
        description: optionalText(fields[4], 'output.description'),
        deliveryMode: int(fields[5], 'output.deliveryMode') === 1
          ? 'trusted'
          : fail(`output.deliveryMode:${String(fields[5])}`),
        trustedGatewayEntityId: text(fields[6], 'output.trustedGatewayEntityId'),
      };
    }
    case 1: {
      const fields = tupleOf(row, 6, 'output.htlcSecret');
      return {
        kind: 'htlcSecret',
        lockId: text(fields[1], 'output.lockId'),
        hashlock: text(fields[2], 'output.hashlock'),
        secret: text(fields[3], 'output.secret'),
        tokenId: int(fields[4], 'output.tokenId'),
        amount: big(fields[5], 'output.amount').toString(),
      };
    }
    case 2: {
      const fields = tupleOf(row, 6, 'output.htlcError');
      return {
        kind: 'htlcError',
        lockId: text(fields[1], 'output.lockId'),
        hashlock: text(fields[2], 'output.hashlock'),
        tokenId: int(fields[3], 'output.tokenId'),
        amount: big(fields[4], 'output.amount').toString(),
        reason: optionalText(fields[5], 'output.reason'),
      };
    }
    case 3: {
      const fields = tupleOf(row, 18, 'output.swapOfferUpsert');
      const makerIsRight = int(fields[14], 'output.makerIsRight');
      if (makerIsRight !== 0 && makerIsRight !== 1) return fail(`output.makerIsRight:${makerIsRight}`);
      return {
        kind: 'swapOfferUpsert',
        offer: {
          offerId: text(fields[1], 'output.offerId'),
          leftEntity: text(fields[2], 'output.leftEntity'),
          rightEntity: text(fields[3], 'output.rightEntity'),
          giveTokenId: int(fields[4], 'output.giveTokenId'),
          giveTokenDecimals: int(fields[5], 'output.giveTokenDecimals'),
          giveAmount: big(fields[6], 'output.giveAmount').toString(),
          wantTokenId: int(fields[7], 'output.wantTokenId'),
          wantTokenDecimals: int(fields[8], 'output.wantTokenDecimals'),
          wantAmount: big(fields[9], 'output.wantAmount').toString(),
          maxFee: big(fields[10], 'output.maxFee').toString(),
          minNetReceive: big(fields[11], 'output.minNetReceive').toString(),
          priceTicks: big(fields[12], 'output.priceTicks').toString(),
          timeInForce: fields[13] === null ? null : int(fields[13], 'output.timeInForce'),
          makerIsRight,
          createdHeight: int(fields[15], 'output.createdHeight'),
          quantizedGive: big(fields[16], 'output.quantizedGive').toString(),
          quantizedWant: big(fields[17], 'output.quantizedWant').toString(),
        },
      };
    }
    case 4: {
      const fields = tupleOf(row, 2, 'output.swapOfferRemove');
      return { kind: 'swapOfferRemove', offerId: text(fields[1], 'output.offerId') };
    }
    case 5: {
      const fields = tupleOf(row, 2, 'output.swapCancelRequest');
      return { kind: 'swapCancelRequest', offerId: text(fields[1], 'output.offerId') };
    }
    default:
      return fail(`output.tag:${String(row[0])}`);
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

// ------------------------------------------------------- the inverse tx codec

const DELIVERY_MODES = ['direct', 'trusted'] as const;
const HTLC_DELIVERY_MODES = ['instant', 'async'] as const;

export const decodeAccountTx = (value: unknown): AccountTx => {
  const row = list(value, 'tx');
  switch (int(row[0], 'tx.tag')) {
    case 0: {
      const fields = tupleOf(row, 9, 'tx.directPayment');
      const deliveryMode = DELIVERY_MODES[int(fields[7], 'tx.deliveryMode')];
      if (deliveryMode === undefined) return fail('tx.deliveryMode:unknown');
      const gateway = optionalText(fields[8], 'tx.trustedGateway');
      return {
        type: 'direct_payment',
        data: {
          tokenId: int(fields[1], 'tx.tokenId'),
          amount: big(fields[2], 'tx.amount'),
          route: list(fields[3], 'tx.route').map(hop => text(hop, 'tx.route.hop')),
          ...(optionalText(fields[4], 'tx.description') === null
            ? {}
            : { description: text(fields[4], 'tx.description') }),
          fromEntityId: text(fields[5], 'tx.fromEntityId'),
          toEntityId: text(fields[6], 'tx.toEntityId'),
          deliveryMode,
          ...(gateway === null ? {} : { trustedGatewayEntityId: gateway }),
        },
      } as AccountTx;
    }
    case 1: {
      const fields = tupleOf(row, 9, 'tx.htlcLock');
      const mode = fields[7] === null
        ? null
        : HTLC_DELIVERY_MODES[int(fields[7], 'tx.htlcDeliveryMode')];
      if (mode === undefined) return fail('tx.htlcDeliveryMode:unknown');
      const envelope = fields[8] === null ? null : bytes(fields[8], 'tx.envelope');
      return {
        type: 'htlc_lock',
        data: {
          lockId: text(fields[1], 'tx.lockId'),
          hashlock: hex(fields[2], 'tx.hashlock', 32),
          timelock: big(fields[3], 'tx.timelock'),
          revealBeforeHeight: int(fields[4], 'tx.revealBeforeHeight'),
          amount: big(fields[5], 'tx.amount'),
          tokenId: int(fields[6], 'tx.tokenId'),
          ...(mode === null ? {} : { deliveryMode: mode }),
          ...(envelope === null
            ? {}
            : { envelope: { ciphertext: Buffer.from(envelope).toString('base64') } }),
        },
      } as AccountTx;
    }
    case 2: {
      const fields = tupleOf(row, 4, 'tx.htlcResolve');
      const outcome = int(fields[2], 'tx.htlcOutcome');
      if (outcome === 0) {
        return {
          type: 'htlc_resolve',
          data: {
            lockId: text(fields[1], 'tx.lockId'),
            // The tag is the discriminator TypeScript models as a field, and
            // a resolve without it is not the transaction that was sent.
            outcome: 'secret',
            secret: hex(fields[3], 'tx.secret', 32),
          },
        } as AccountTx;
      }
      if (outcome !== 1) return fail('tx.htlcOutcome:unknown');
      const reason = optionalText(fields[3], 'tx.reason');
      return {
        type: 'htlc_resolve',
        data: {
          lockId: text(fields[1], 'tx.lockId'),
          outcome: 'error',
          ...(reason === null ? {} : { reason }),
        },
      } as AccountTx;
    }
    case 3: {
      const fields = tupleOf(row, 2, 'tx.addDelta');
      return { type: 'add_delta', data: { tokenId: int(fields[1], 'tx.tokenId') } } as AccountTx;
    }
    case 4: {
      const fields = tupleOf(row, 3, 'tx.setCreditLimit');
      return {
        type: 'set_credit_limit',
        data: { tokenId: int(fields[1], 'tx.tokenId'), amount: big(fields[2], 'tx.amount') },
      } as AccountTx;
    }
    case 5: {
      const fields = tupleOf(row, 6, 'tx.rebalancePolicy');
      return {
        type: 'rebalance_policy',
        data: {
          tokenId: int(fields[1], 'tx.tokenId'),
          policyVersion: int(fields[2], 'tx.policyVersion'),
          baseFee: big(fields[3], 'tx.baseFee'),
          liquidityFeeBps: big(fields[4], 'tx.liquidityFeeBps'),
          gasFee: big(fields[5], 'tx.gasFee'),
        },
      } as AccountTx;
    }
    case 6: {
      const fields = tupleOf(row, 12, 'tx.swapOffer');
      const timeInForce = fields[10] === null ? null : int(fields[10], 'tx.timeInForce');
      const priceTicks = fields[11] === null ? null : big(fields[11], 'tx.priceTicks');
      return {
        type: 'swap_offer',
        data: {
          offerId: text(fields[1], 'tx.offerId'),
          giveTokenId: int(fields[2], 'tx.giveTokenId'),
          giveTokenDecimals: int(fields[3], 'tx.giveTokenDecimals'),
          giveAmount: big(fields[4], 'tx.giveAmount'),
          wantTokenId: int(fields[5], 'tx.wantTokenId'),
          wantTokenDecimals: int(fields[6], 'tx.wantTokenDecimals'),
          wantAmount: big(fields[7], 'tx.wantAmount'),
          maxFee: big(fields[8], 'tx.maxFee'),
          minNetReceive: big(fields[9], 'tx.minNetReceive'),
          ...(timeInForce === null ? {} : { timeInForce }),
          ...(priceTicks === null ? {} : { priceTicks }),
        },
      } as AccountTx;
    }
    case 7: {
      const fields = tupleOf(row, 2, 'tx.swapCancelRequest');
      return {
        type: 'swap_cancel_request',
        data: { offerId: text(fields[1], 'tx.offerId') },
      } as AccountTx;
    }
    case 8:
      return decodeSwapResolve(row);
    default:
      return fail('tx.tag:unknown');
  }
};

const decodeSwapResolve = (row: readonly unknown[]): AccountTx => {
  const fields = tupleOf(row, 15, 'tx.swapResolve');
  const optionalBig = (value: unknown, code: string): bigint | null =>
    value === null ? null : big(value, code);
  const optionalInt = (value: unknown, code: string): number | null =>
    value === null ? null : int(value, code);
  // Every field but the offer, the coarse ratio and the cancel flag is
  // optional on the wire, and each one absent is a different transaction from
  // that one present: reading them as required turned a legitimate partial
  // fill into a decode failure.
  const fillNumerator = optionalBig(fields[3], 'tx.fillNumerator');
  const fillDenominator = optionalBig(fields[4], 'tx.fillDenominator');
  const feeTokenId = optionalInt(fields[6], 'tx.feeTokenId');
  const feeAmount = optionalBig(fields[7], 'tx.feeAmount');
  const executionGiveAmount = optionalBig(fields[8], 'tx.executionGiveAmount');
  const executionWantAmount = optionalBig(fields[9], 'tx.executionWantAmount');
  const restingPriceTicks = optionalBig(fields[10], 'tx.restingPriceTicks');
  const restingGive = optionalBig(fields[11], 'tx.restingGiveAmount');
  const restingWant = optionalBig(fields[12], 'tx.restingWantAmount');
  const quantizedGive = optionalBig(fields[13], 'tx.restingQuantizedGive');
  const quantizedWant = optionalBig(fields[14], 'tx.restingQuantizedWant');
  return {
    type: 'swap_resolve',
    data: {
      offerId: text(fields[1], 'tx.offerId'),
      fillRatio: int(fields[2], 'tx.fillRatio'),
      ...(fillNumerator === null ? {} : { fillNumerator }),
      ...(fillDenominator === null ? {} : { fillDenominator }),
      // 0/1, matching both encoders. Reading a boolean here rejected every
      // swap_resolve either engine produced.
      cancelRemainder: flag(fields[5], 'tx.cancelRemainder'),
      ...(feeTokenId === null ? {} : { feeTokenId }),
      ...(feeAmount === null ? {} : { feeAmount }),
      ...(executionGiveAmount === null ? {} : { executionGiveAmount }),
      ...(executionWantAmount === null ? {} : { executionWantAmount }),
      ...(restingPriceTicks === null ? {} : { restingPriceTicks }),
      ...(restingGive === null ? {} : { restingGiveAmount: restingGive }),
      ...(restingWant === null ? {} : { restingWantAmount: restingWant }),
      ...(quantizedGive === null ? {} : { restingQuantizedGive: quantizedGive }),
      ...(quantizedWant === null ? {} : { restingQuantizedWant: quantizedWant }),
    },
  } as AccountTx;
};

// ------------------------------------------------------------ the transcript

const hexToBytes = (value: string, code: string): Uint8Array => {
  const raw = value.startsWith('0x') ? value.slice(2) : value;
  if (raw.length % 2 !== 0 || !/^[0-9a-f]*$/.test(raw)) fail(`${code}:hex`);
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

const frameWire = (frame: AccountFrame & { hanko: string }): RscoreWireValue => [
  frame.height,
  frame.timestamp,
  frame.jHeight,
  frame.accountTxs.map(tx => {
    const wire = accountTxWire(tx);
    if (wire === null) return fail('transcript.tx:unsupported');
    return wire;
  }),
  frame.prevFrameHash,
  hexToBytes(frame.accountStateRoot, 'transcript.accountStateRoot'),
  frame.byLeft,
  frame.deltas.map(deltaWire),
  hexToBytes(frame.stateHash, 'transcript.stateHash'),
  hexToBytes(frame.hanko, 'transcript.hanko'),
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

const verdictWire = (verdict: WaveVerdict): RscoreWireValue => {
  switch (verdict.kind) {
    case 'frameCommitted':
      return [
        0,
        verdict.height,
        hexToBytes(verdict.stateHash, 'transcript.stateHash'),
        hexToBytes(verdict.ackHanko, 'transcript.ackHanko'),
        verdict.outputs.map(outputWire),
        verdict.rolledBackTxs,
      ];
    case 'frameCollisionIgnored':
      return [1, verdict.height];
    case 'frameDuplicate':
      return [
        2,
        verdict.height,
        hexToBytes(verdict.stateHash, 'transcript.stateHash'),
        hexToBytes(verdict.ackHanko, 'transcript.ackHanko'),
      ];
    case 'frameStale':
      return [3, verdict.height, verdict.currentHeight];
    case 'frameRejected':
      return [4, verdict.reason];
    case 'ackCommitted':
      return [
        5,
        verdict.height,
        hexToBytes(verdict.stateHash, 'transcript.stateHash'),
        verdict.outputs.map(outputWire),
      ];
    case 'ackStale':
      return [6, verdict.height];
    case 'ackRejected':
      return [7, verdict.reason];
    case 'failed':
      return [8, verdict.message];
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
      row.inputIndex,
      hexToBytes(row.accountId, 'transcript.accountId'),
      verdictWire(row.verdict),
    ]),
    wave.proposals.map(row => [
      hexToBytes(row.accountId, 'transcript.accountId'),
      row.frame === null ? null : frameWire(row.frame),
      row.dropped.map(droppedWire),
    ]),
  ];
  const digest = createHash('sha256');
  digest.update(WAVE_PARITY_DOMAIN);
  digest.update(packWireValue(transcript));
  return `0x${digest.digest('hex')}`;
};
