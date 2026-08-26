/** Closed TypeScript boundary for one resident Rust Entity+Account round. */
import { getSwapPairOrientation, getSwapPairPolicyForDimensions } from '../../account/utils';
import type { EntityState } from '../../entity/types';
import { decodeBase64Bytes } from '../../protocol/serialization/base64';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import type { PreparedHtlcEntry } from '../../types/entity/htlc-infra-context';
import type { RscoreWireValue } from '../process-wire-value';
import { hexToWireBytes } from '../shadow-wire';
import { decodeWave, type Wave } from '../wave-decode';

type RscoreEntityOutput =
  | Readonly<{ kind: 'htlcForwardAccepted'; entityId: string; hashlock: string }>
  | Readonly<{ kind: 'htlcFailed'; entityId: string; hashlock: string; lockId: string | null; reason: string }>
  | Readonly<{
      kind: 'htlcReceived'; entityId: string; fromEntity: string; toEntity: string;
      hashlock: string; lockId: string; tokenId: number | null; amount: bigint | null;
      startedAtMs: number | null; jurisdictionId: string | null; receivedAtMs: number;
    }>
  | Readonly<{
      kind: 'htlcFinalized'; entityId: string; fromEntity: string; toEntity: string | null;
      hashlock: string; secret: string; lockId: string | null; tokenId: number | null;
      amount: bigint | null; startedAtMs: number | null; jurisdictionId: string | null;
      finalizedAtMs: number;
    }>
  | Readonly<{ kind: 'swapMatched'; entityId: string; count: number }>;

export type RscoreEntityRound = Readonly<{
  inbound: Wave;
  outbound: Wave;
  outputs: readonly RscoreEntityOutput[];
  commitments: Readonly<{
    paybookRoot: string;
    orderbookRoot: string;
    orderedOutboxDigest: string;
  }>;
  ownedSections: readonly Readonly<{ field: string; digest: string }>[];
  engineMicros: number;
}>;

const bytes = (value: string, length: number, code: string): Uint8Array =>
  hexToWireBytes(value, length, code);

const preparedWire = (entry: PreparedHtlcEntry): RscoreWireValue[] => {
  const binding = entry.binding;
  const bindingWire: RscoreWireValue[] = [
    bytes(binding.fromEntityId, 32, 'RSCORE_ENTITY_PREPARED_FROM'),
    bytes(binding.toEntityId, 32, 'RSCORE_ENTITY_PREPARED_TO'),
    [
      binding.domain.chainId,
      bytes(binding.domain.depositoryAddress, 20, 'RSCORE_ENTITY_PREPARED_DEPOSITORY'),
    ],
    bytes(binding.accountFrameHash, 32, 'RSCORE_ENTITY_PREPARED_FRAME_HASH'),
    binding.accountHeight,
    bytes(binding.lockId, 32, 'RSCORE_ENTITY_PREPARED_LOCK'),
    bytes(binding.envelopeHash, 32, 'RSCORE_ENTITY_PREPARED_ENVELOPE_HASH'),
    bytes(binding.hashlock, 32, 'RSCORE_ENTITY_PREPARED_HASHLOCK'),
    binding.tokenId,
    binding.amount.toString(),
    binding.timelock.toString(),
    binding.revealBeforeHeight,
  ];
  const outcome: RscoreWireValue[] = entry.outcome.kind === 'reject'
    ? [0, entry.outcome.reason]
    : entry.outcome.kind === 'final'
      ? [
          1,
          bytes(entry.outcome.secret, 32, 'RSCORE_ENTITY_PREPARED_SECRET'),
          entry.outcome.startedAtMs ?? null,
        ]
      : [
          2,
          bytes(entry.outcome.nextHopEntityId, 32, 'RSCORE_ENTITY_PREPARED_NEXT_HOP'),
          entry.outcome.forwardAmount.toString(),
          decodeBase64Bytes(entry.outcome.innerEnvelope.ciphertext),
        ];
  return [bindingWire, outcome];
};

const pairIds = (state: EntityState): readonly string[] =>
  state.orderbookExt === undefined
    ? []
    : [...state.orderbookExt.pairDimensions.keys()].sort();

const pairPolicyWire = (state: EntityState, pairId: string): RscoreWireValue[] => {
  const dimensions = state.orderbookExt?.pairDimensions.get(pairId);
  if (dimensions === undefined) throw new Error(`RSCORE_ENTITY_PAIR_DIMENSIONS_MISSING:${pairId}`);
  const match = /^(\d+)\/(\d+)$/.exec(pairId);
  if (match === null) throw new Error(`RSCORE_ENTITY_PAIR_ID_UNSUPPORTED:${pairId}`);
  const tokenA = Number(match[1]);
  const tokenB = Number(match[2]);
  if (!Number.isSafeInteger(tokenA) || !Number.isSafeInteger(tokenB)) {
    throw new Error(`RSCORE_ENTITY_PAIR_ID_INVALID:${pairId}`);
  }
  const { baseTokenId, quoteTokenId } = getSwapPairOrientation(tokenA, tokenB);
  const policy = getSwapPairPolicyForDimensions(
    baseTokenId,
    quoteTokenId,
    dimensions.baseTokenDecimals,
    dimensions.quoteTokenDecimals,
  );
  return [
    pairId,
    policy.priceStepTicks,
    policy.bookBucketWidthTicks,
    policy.mmMidPriceTicks.toString(),
  ];
};

export const entityDeterministicContextWire = (
  state: EntityState,
  context: EntityInfraContext,
  jurisdictionId?: string,
): RscoreWireValue[] => {
  const rawFee = state.hubRebalanceConfig?.swapTakerFeeBps;
  const swapTakerFeeBps = Number.isFinite(Number(rawFee))
    ? Math.max(0, Math.min(10_000, Math.floor(Number(rawFee))))
    : 0;
  return [
    (state.orderbookExt?.hubProfile.minTradeSize ?? 0n).toString(),
    swapTakerFeeBps,
    jurisdictionId ?? null,
    pairIds(state).map(pairId => pairPolicyWire(state, pairId)),
    context.htlc.entries.map(preparedWire),
  ];
};

const tuple = (value: unknown, length: number, code: string): readonly unknown[] => {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${code}_ARITY`);
  return value;
};

const integer = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
};

const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const optionalText = (value: unknown, code: string): string | null =>
  value === null ? null : text(value, code);

const digest = (value: unknown, length: number, code: string): string => {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) throw new Error(code);
  return `0x${Buffer.from(value).toString('hex')}`;
};

const optionalDigest = (value: unknown, length: number, code: string): string | null =>
  value === null ? null : digest(value, length, code);

const optionalInteger = (value: unknown, code: string): number | null =>
  value === null ? null : integer(value, code);

const optionalBigint = (value: unknown, code: string): bigint | null =>
  value === null ? null : BigInt(text(value, code));

const entityOutput = (value: unknown): RscoreEntityOutput => {
  if (!Array.isArray(value) || !Number.isSafeInteger(value[0])) {
    throw new Error('RSCORE_ENTITY_OUTPUT_INVALID');
  }
  switch (value[0]) {
    case 0: {
      const row = tuple(value, 3, 'RSCORE_ENTITY_FORWARD_ACCEPTED');
      return {
        kind: 'htlcForwardAccepted',
        entityId: digest(row[1], 32, 'RSCORE_ENTITY_OUTPUT_ENTITY'),
        hashlock: digest(row[2], 32, 'RSCORE_ENTITY_OUTPUT_HASHLOCK'),
      };
    }
    case 1: {
      const row = tuple(value, 5, 'RSCORE_ENTITY_HTLC_FAILED');
      return {
        kind: 'htlcFailed',
        entityId: digest(row[1], 32, 'RSCORE_ENTITY_OUTPUT_ENTITY'),
        hashlock: digest(row[2], 32, 'RSCORE_ENTITY_OUTPUT_HASHLOCK'),
        lockId: optionalDigest(row[3], 32, 'RSCORE_ENTITY_OUTPUT_LOCK'),
        reason: text(row[4], 'RSCORE_ENTITY_OUTPUT_REASON'),
      };
    }
    case 2: {
      const row = tuple(value, 11, 'RSCORE_ENTITY_HTLC_RECEIVED');
      return {
        kind: 'htlcReceived',
        entityId: digest(row[1], 32, 'RSCORE_ENTITY_OUTPUT_ENTITY'),
        fromEntity: digest(row[2], 32, 'RSCORE_ENTITY_OUTPUT_FROM'),
        toEntity: digest(row[3], 32, 'RSCORE_ENTITY_OUTPUT_TO'),
        hashlock: digest(row[4], 32, 'RSCORE_ENTITY_OUTPUT_HASHLOCK'),
        lockId: digest(row[5], 32, 'RSCORE_ENTITY_OUTPUT_LOCK'),
        tokenId: optionalInteger(row[6], 'RSCORE_ENTITY_OUTPUT_TOKEN'),
        amount: optionalBigint(row[7], 'RSCORE_ENTITY_OUTPUT_AMOUNT'),
        startedAtMs: optionalInteger(row[8], 'RSCORE_ENTITY_OUTPUT_STARTED'),
        jurisdictionId: optionalText(row[9], 'RSCORE_ENTITY_OUTPUT_JURISDICTION'),
        receivedAtMs: integer(row[10], 'RSCORE_ENTITY_OUTPUT_RECEIVED_AT'),
      };
    }
    case 3: {
      const row = tuple(value, 12, 'RSCORE_ENTITY_HTLC_FINALIZED');
      return {
        kind: 'htlcFinalized',
        entityId: digest(row[1], 32, 'RSCORE_ENTITY_OUTPUT_ENTITY'),
        fromEntity: digest(row[2], 32, 'RSCORE_ENTITY_OUTPUT_FROM'),
        toEntity: optionalDigest(row[3], 32, 'RSCORE_ENTITY_OUTPUT_TO'),
        hashlock: digest(row[4], 32, 'RSCORE_ENTITY_OUTPUT_HASHLOCK'),
        secret: digest(row[5], 32, 'RSCORE_ENTITY_OUTPUT_SECRET'),
        lockId: optionalDigest(row[6], 32, 'RSCORE_ENTITY_OUTPUT_LOCK'),
        tokenId: optionalInteger(row[7], 'RSCORE_ENTITY_OUTPUT_TOKEN'),
        amount: optionalBigint(row[8], 'RSCORE_ENTITY_OUTPUT_AMOUNT'),
        startedAtMs: optionalInteger(row[9], 'RSCORE_ENTITY_OUTPUT_STARTED'),
        jurisdictionId: optionalText(row[10], 'RSCORE_ENTITY_OUTPUT_JURISDICTION'),
        finalizedAtMs: integer(row[11], 'RSCORE_ENTITY_OUTPUT_FINALIZED_AT'),
      };
    }
    case 4: {
      const row = tuple(value, 3, 'RSCORE_ENTITY_SWAP_MATCHED');
      return {
        kind: 'swapMatched',
        entityId: digest(row[1], 32, 'RSCORE_ENTITY_OUTPUT_ENTITY'),
        count: integer(row[2], 'RSCORE_ENTITY_OUTPUT_SWAP_COUNT'),
      };
    }
    default: throw new Error(`RSCORE_ENTITY_OUTPUT_TAG:${String(value[0])}`);
  }
};

const sections = (value: unknown): ReadonlyArray<Readonly<{ field: string; digest: string }>> => {
  if (!Array.isArray(value)) throw new Error('RSCORE_ENTITY_SECTIONS_INVALID');
  let previous = '';
  return value.map(raw => {
    const row = tuple(raw, 2, 'RSCORE_ENTITY_SECTION');
    const field = text(row[0], 'RSCORE_ENTITY_SECTION_FIELD');
    if (field <= previous) throw new Error(`RSCORE_ENTITY_SECTION_ORDER:${field}`);
    previous = field;
    return { field, digest: digest(row[1], 32, 'RSCORE_ENTITY_SECTION_DIGEST') };
  });
};

export const decodeEntityRound = (value: unknown): RscoreEntityRound => {
  const row = tuple(value, 6, 'RSCORE_ENTITY_ROUND');
  const commitments = tuple(row[3], 3, 'RSCORE_ENTITY_COMMITMENTS');
  if (!Array.isArray(row[2])) throw new Error('RSCORE_ENTITY_OUTPUTS_INVALID');
  return {
    inbound: decodeWave(row[0]),
    outbound: decodeWave(row[1]),
    outputs: row[2].map(entityOutput),
    commitments: {
      paybookRoot: digest(commitments[0], 32, 'RSCORE_ENTITY_PAYBOOK_ROOT'),
      orderbookRoot: digest(commitments[1], 32, 'RSCORE_ENTITY_ORDERBOOK_ROOT'),
      orderedOutboxDigest: digest(commitments[2], 32, 'RSCORE_ENTITY_OUTBOX_DIGEST'),
    },
    ownedSections: sections(row[4]),
    engineMicros: integer(row[5], 'RSCORE_ENTITY_ENGINE_MICROS'),
  };
};
