/**
 * Low-level decoder for the AccountTx process-wire contract.
 *
 * Checkpoint recovery and live wave decoding both consume these exact rows.
 * Keeping the decoder below either higher-level path prevents recovery from
 * depending back on the wave/checkpoint graph and keeps one canonical codec.
 */
import { HTLC_OPAQUE_CIPHERTEXT_VERSION } from '../protocol/htlc/multi-recipient';
import type { AccountTx } from '../types/account';
import { jEventClaimFromWire } from './process/j-claim-wire';

export const rscoreWireDecodeFail = (code: string): never => {
  throw new Error(`RSCORE_WAVE_DECODE:${code}`);
};

export const rscoreWireTuple = (value: unknown, arity: number, code: string): unknown[] => {
  if (!Array.isArray(value)) return rscoreWireDecodeFail(`${code}:tuple`);
  if (value.length !== arity) {
    return rscoreWireDecodeFail(`${code}:arity:${value.length}:${arity}`);
  }
  return value;
};

export const rscoreWireList = (value: unknown, code: string): unknown[] =>
  Array.isArray(value) ? value : rscoreWireDecodeFail(`${code}:list`);

export const rscoreWireInt = (value: unknown, code: string): number => {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
      return rscoreWireDecodeFail(`${code}:unsafeInteger`);
    }
    return Number(value);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return rscoreWireDecodeFail(`${code}:integer`);
  }
  return value;
};

export const rscoreWireUint = (value: unknown, code: string): number => {
  const parsed = rscoreWireInt(value, code);
  return parsed < 0 ? rscoreWireDecodeFail(`${code}:unsigned`) : parsed;
};

export const rscoreWireText = (value: unknown, code: string): string =>
  typeof value === 'string' ? value : rscoreWireDecodeFail(`${code}:text`);

export const rscoreWireBool = (value: unknown, code: string): boolean =>
  typeof value === 'boolean' ? value : rscoreWireDecodeFail(`${code}:bool`);

const rscoreWireFlag = (value: unknown, code: string): boolean => {
  const parsed = rscoreWireInt(value, code);
  if (parsed !== 0 && parsed !== 1) return rscoreWireDecodeFail(`${code}:flag:${parsed}`);
  return parsed === 1;
};

export const rscoreWireOptionalText = (value: unknown, code: string): string | null =>
  value === null ? null : rscoreWireText(value, code);

export const rscoreWireBytes = (value: unknown, code: string, length?: number): Uint8Array => {
  if (!(value instanceof Uint8Array)) return rscoreWireDecodeFail(`${code}:bytes`);
  if (length !== undefined && value.byteLength !== length) {
    return rscoreWireDecodeFail(`${code}:length:${value.byteLength}:${length}`);
  }
  return value;
};

export const rscoreWireHex = (value: unknown, code: string, length?: number): string =>
  `0x${Buffer.from(rscoreWireBytes(value, code, length)).toString('hex')}`;

export const rscoreWireBig = (value: unknown, code: string): bigint => {
  const raw = rscoreWireText(value, code);
  if (!/^-?\d+$/.test(raw)) return rscoreWireDecodeFail(`${code}:bigint`);
  return BigInt(raw);
};

const DELIVERY_MODES = ['direct', 'trusted'] as const;
const HTLC_DELIVERY_MODES = ['instant', 'async'] as const;

export const decodeRscoreAccountTx = (value: unknown): AccountTx => {
  const row = rscoreWireList(value, 'tx');
  switch (rscoreWireInt(row[0], 'tx.tag')) {
    case 0: {
      const fields = rscoreWireTuple(row, 9, 'tx.directPayment');
      const deliveryMode = DELIVERY_MODES[rscoreWireInt(fields[7], 'tx.deliveryMode')];
      if (deliveryMode === undefined) return rscoreWireDecodeFail('tx.deliveryMode:unknown');
      const description = rscoreWireOptionalText(fields[4], 'tx.description');
      const gateway = rscoreWireOptionalText(fields[8], 'tx.trustedGateway');
      return {
        type: 'direct_payment',
        data: {
          tokenId: rscoreWireInt(fields[1], 'tx.tokenId'),
          amount: rscoreWireBig(fields[2], 'tx.amount'),
          route: rscoreWireList(fields[3], 'tx.route')
            .map(hop => rscoreWireText(hop, 'tx.route.hop')),
          ...(description === null ? {} : { description }),
          fromEntityId: rscoreWireText(fields[5], 'tx.fromEntityId'),
          toEntityId: rscoreWireText(fields[6], 'tx.toEntityId'),
          deliveryMode,
          ...(gateway === null ? {} : { trustedGatewayEntityId: gateway }),
        },
      } as AccountTx;
    }
    case 1: {
      const fields = rscoreWireTuple(row, 9, 'tx.htlcLock');
      const mode = fields[7] === null
        ? null
        : HTLC_DELIVERY_MODES[rscoreWireInt(fields[7], 'tx.htlcDeliveryMode')];
      if (mode === undefined) return rscoreWireDecodeFail('tx.htlcDeliveryMode:unknown');
      const envelope = fields[8] === null ? null : rscoreWireBytes(fields[8], 'tx.envelope');
      return {
        type: 'htlc_lock',
        data: {
          lockId: rscoreWireText(fields[1], 'tx.lockId'),
          hashlock: rscoreWireHex(fields[2], 'tx.hashlock', 32),
          timelock: rscoreWireBig(fields[3], 'tx.timelock'),
          revealBeforeHeight: rscoreWireInt(fields[4], 'tx.revealBeforeHeight'),
          amount: rscoreWireBig(fields[5], 'tx.amount'),
          tokenId: rscoreWireInt(fields[6], 'tx.tokenId'),
          ...(mode === null ? {} : { deliveryMode: mode }),
          // The wire carries only the ciphertext: the version is the one
          // constant this profile accepts, and the engine's own canonical
          // form states it. A decoded envelope that omitted it would
          // re-encode into a different canonical transaction than the one
          // that arrived.
          ...(envelope === null
            ? {}
            : {
                envelope: {
                  version: HTLC_OPAQUE_CIPHERTEXT_VERSION,
                  ciphertext: Buffer.from(envelope).toString('base64'),
                },
              }),
        },
      } as AccountTx;
    }
    case 2: {
      const fields = rscoreWireTuple(row, 4, 'tx.htlcResolve');
      const outcome = rscoreWireInt(fields[2], 'tx.htlcOutcome');
      if (outcome === 0) {
        return {
          type: 'htlc_resolve',
          data: {
            lockId: rscoreWireText(fields[1], 'tx.lockId'),
            outcome: 'secret',
            secret: rscoreWireHex(fields[3], 'tx.secret', 32),
          },
        } as AccountTx;
      }
      if (outcome !== 1) return rscoreWireDecodeFail('tx.htlcOutcome:unknown');
      const reason = rscoreWireOptionalText(fields[3], 'tx.reason');
      return {
        type: 'htlc_resolve',
        data: {
          lockId: rscoreWireText(fields[1], 'tx.lockId'),
          outcome: 'error',
          ...(reason === null ? {} : { reason }),
        },
      } as AccountTx;
    }
    case 3: {
      const fields = rscoreWireTuple(row, 2, 'tx.addDelta');
      return {
        type: 'add_delta',
        data: { tokenId: rscoreWireInt(fields[1], 'tx.tokenId') },
      } as AccountTx;
    }
    case 4: {
      const fields = rscoreWireTuple(row, 3, 'tx.setCreditLimit');
      return {
        type: 'set_credit_limit',
        data: {
          tokenId: rscoreWireInt(fields[1], 'tx.tokenId'),
          amount: rscoreWireBig(fields[2], 'tx.amount'),
        },
      } as AccountTx;
    }
    case 5: {
      const fields = rscoreWireTuple(row, 6, 'tx.rebalancePolicy');
      return {
        type: 'rebalance_policy',
        data: {
          tokenId: rscoreWireInt(fields[1], 'tx.tokenId'),
          policyVersion: rscoreWireInt(fields[2], 'tx.policyVersion'),
          baseFee: rscoreWireBig(fields[3], 'tx.baseFee'),
          liquidityFeeBps: rscoreWireBig(fields[4], 'tx.liquidityFeeBps'),
          gasFee: rscoreWireBig(fields[5], 'tx.gasFee'),
        },
      } as AccountTx;
    }
    case 6: {
      const fields = rscoreWireTuple(row, 12, 'tx.swapOffer');
      const timeInForce = fields[10] === null ? null : rscoreWireInt(fields[10], 'tx.timeInForce');
      const priceTicks = fields[11] === null ? null : rscoreWireBig(fields[11], 'tx.priceTicks');
      return {
        type: 'swap_offer',
        data: {
          offerId: rscoreWireText(fields[1], 'tx.offerId'),
          giveTokenId: rscoreWireInt(fields[2], 'tx.giveTokenId'),
          giveTokenDecimals: rscoreWireInt(fields[3], 'tx.giveTokenDecimals'),
          giveAmount: rscoreWireBig(fields[4], 'tx.giveAmount'),
          wantTokenId: rscoreWireInt(fields[5], 'tx.wantTokenId'),
          wantTokenDecimals: rscoreWireInt(fields[6], 'tx.wantTokenDecimals'),
          wantAmount: rscoreWireBig(fields[7], 'tx.wantAmount'),
          maxFee: rscoreWireBig(fields[8], 'tx.maxFee'),
          minNetReceive: rscoreWireBig(fields[9], 'tx.minNetReceive'),
          ...(timeInForce === null ? {} : { timeInForce }),
          ...(priceTicks === null ? {} : { priceTicks }),
        },
      } as AccountTx;
    }
    case 7: {
      const fields = rscoreWireTuple(row, 2, 'tx.swapCancelRequest');
      return {
        type: 'swap_cancel_request',
        data: { offerId: rscoreWireText(fields[1], 'tx.offerId') },
      } as AccountTx;
    }
    case 8:
      return decodeSwapResolve(row);
    case 9:
      return jEventClaimFromWire(row);
    default:
      return rscoreWireDecodeFail('tx.tag:unknown');
  }
};

const optionalBig = (value: unknown, code: string): bigint | null =>
  value === null ? null : rscoreWireBig(value, code);

const optionalInt = (value: unknown, code: string): number | null =>
  value === null ? null : rscoreWireInt(value, code);

const decodeSwapResolve = (row: readonly unknown[]): AccountTx => {
  const fields = rscoreWireTuple(row, 18, 'tx.swapResolve');
  const fillNumerator = optionalBig(fields[3], 'tx.fillNumerator');
  const fillDenominator = optionalBig(fields[4], 'tx.fillDenominator');
  const comment = rscoreWireOptionalText(fields[6], 'tx.comment');
  const restingGiveTokenId = optionalInt(fields[7], 'tx.restingGiveTokenId');
  const restingWantTokenId = optionalInt(fields[8], 'tx.restingWantTokenId');
  const feeTokenId = optionalInt(fields[9], 'tx.feeTokenId');
  const feeAmount = optionalBig(fields[10], 'tx.feeAmount');
  const executionGiveAmount = optionalBig(fields[11], 'tx.executionGiveAmount');
  const executionWantAmount = optionalBig(fields[12], 'tx.executionWantAmount');
  const restingPriceTicks = optionalBig(fields[13], 'tx.restingPriceTicks');
  const restingGive = optionalBig(fields[14], 'tx.restingGiveAmount');
  const restingWant = optionalBig(fields[15], 'tx.restingWantAmount');
  const quantizedGive = optionalBig(fields[16], 'tx.restingQuantizedGive');
  const quantizedWant = optionalBig(fields[17], 'tx.restingQuantizedWant');
  return {
    type: 'swap_resolve',
    data: {
      offerId: rscoreWireText(fields[1], 'tx.offerId'),
      fillRatio: rscoreWireInt(fields[2], 'tx.fillRatio'),
      ...(fillNumerator === null ? {} : { fillNumerator }),
      ...(fillDenominator === null ? {} : { fillDenominator }),
      cancelRemainder: rscoreWireFlag(fields[5], 'tx.cancelRemainder'),
      ...(comment === null ? {} : { comment }),
      ...(restingGiveTokenId === null ? {} : { restingGiveTokenId }),
      ...(restingWantTokenId === null ? {} : { restingWantTokenId }),
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
