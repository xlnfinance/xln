/** Exact process-wire projection for Account J-event claim consensus. */

import { canonicalJurisdictionEventsHash } from '../../jurisdiction/machine/event-observation';
import { requireCanonicalJurisdictionEvents } from '../../jurisdiction/machine/events/event-normalization';
import type { AccountTx } from '../../types/account';
import type {
  AccountJClaimNode,
  AccountJClaimProof,
  AccountJClaimRecord,
} from '../../types/finance/account-j-claims';
import type { JurisdictionEvent } from '../../types/jurisdiction-events';
import type { RscoreWireValue } from '../client';

type ClaimTx = Extract<AccountTx, { type: 'j_event_claim' }>;
type Settled = Extract<JurisdictionEvent, { type: 'AccountSettled' }>;

const fail = (code: string): never => {
  throw new Error(`RSCORE_J_CLAIM_WIRE_${code}`);
};

const tuple = (value: unknown, arity: number, code: string): unknown[] => {
  if (!Array.isArray(value) || value.length !== arity) {
    return fail(`${code}_ARITY:${Array.isArray(value) ? value.length : 'not-array'}:${arity}`);
  }
  return value;
};

const list = (value: unknown, code: string): unknown[] =>
  Array.isArray(value) ? value : fail(`${code}_LIST`);

const integer = (value: unknown, code: string): number => {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    return fail(`${code}_INTEGER:${String(value)}`);
  }
  return number;
};

const text = (value: unknown, code: string): string =>
  typeof value === 'string' ? value : fail(`${code}_TEXT`);

const big = (value: unknown, code: string): bigint => {
  const raw = text(value, code);
  if (!/^-?\d+$/.test(raw)) return fail(`${code}_BIGINT:${raw}`);
  return BigInt(raw);
};

const bytes = (value: unknown, length: number, code: string): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    return fail(`${code}_BYTES:${value instanceof Uint8Array ? value.byteLength : 'not-bytes'}:${length}`);
  }
  return value;
};

const hexBytes = (value: string, length: number, code: string): Uint8Array => {
  const normalized = String(value).trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${length * 2}}$`).test(normalized)) {
    return fail(`${code}_HEX:${normalized || 'missing'}`);
  }
  return Buffer.from(normalized.slice(2), 'hex');
};

const hex = (value: unknown, length: number, code: string): string =>
  `0x${Buffer.from(bytes(value, length, code)).toString('hex')}`;

const optionalInteger = (value: unknown, code: string): number | undefined =>
  value === null ? undefined : integer(value, code);

const optionalHex = (value: unknown, length: number, code: string): string | undefined =>
  value === null ? undefined : hex(value, length, code);

const metadataWire = (event: Settled): RscoreWireValue[] => [
  event.blockNumber ?? null,
  event.blockHash === undefined ? null : hexBytes(event.blockHash, 32, 'EVENT_BLOCK_HASH'),
  event.transactionHash === undefined
    ? null
    : hexBytes(event.transactionHash, 32, 'EVENT_TRANSACTION_HASH'),
  event.logIndex ?? null,
  event.eventIndex ?? null,
];

const eventWire = (event: JurisdictionEvent): RscoreWireValue[] => {
  if (event.type !== 'AccountSettled') return fail(`EVENT_UNSUPPORTED:${event.type}`);
  return [
    0,
    metadataWire(event),
    hexBytes(event.data.leftEntity, 32, 'EVENT_LEFT_ENTITY'),
    hexBytes(event.data.rightEntity, 32, 'EVENT_RIGHT_ENTITY'),
    integer(event.data.tokenId, 'EVENT_TOKEN_ID'),
    String(event.data.leftReserve),
    String(event.data.rightReserve),
    String(event.data.collateral),
    String(event.data.ondelta),
    integer(event.data.nonce, 'EVENT_NONCE'),
  ];
};

const eventFromWire = (value: unknown): Settled => {
  const fields = tuple(value, 10, 'EVENT');
  if (integer(fields[0], 'EVENT_TAG') !== 0) return fail(`EVENT_TAG:${String(fields[0])}`);
  const metadata = tuple(fields[1], 5, 'EVENT_METADATA');
  const blockNumber = optionalInteger(metadata[0], 'EVENT_BLOCK_NUMBER');
  const blockHash = optionalHex(metadata[1], 32, 'EVENT_BLOCK_HASH');
  const transactionHash = optionalHex(metadata[2], 32, 'EVENT_TRANSACTION_HASH');
  const logIndex = optionalInteger(metadata[3], 'EVENT_LOG_INDEX');
  const eventIndex = optionalInteger(metadata[4], 'EVENT_INDEX');
  return {
    type: 'AccountSettled',
    data: {
      leftEntity: hex(fields[2], 32, 'EVENT_LEFT_ENTITY'),
      rightEntity: hex(fields[3], 32, 'EVENT_RIGHT_ENTITY'),
      tokenId: integer(fields[4], 'EVENT_TOKEN_ID'),
      leftReserve: big(fields[5], 'EVENT_LEFT_RESERVE').toString(),
      rightReserve: big(fields[6], 'EVENT_RIGHT_RESERVE').toString(),
      collateral: big(fields[7], 'EVENT_COLLATERAL').toString(),
      ondelta: big(fields[8], 'EVENT_ONDELTA').toString(),
      nonce: integer(fields[9], 'EVENT_NONCE'),
    },
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(blockHash === undefined ? {} : { blockHash }),
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(logIndex === undefined ? {} : { logIndex }),
    ...(eventIndex === undefined ? {} : { eventIndex }),
  };
};

const recordWire = (record: AccountJClaimRecord): RscoreWireValue[] => [
  hexBytes(record.accountKey, 32, 'RECORD_ACCOUNT_KEY'),
  record.side === 'left' ? 0 : 1,
  record.jHeight,
  hexBytes(record.jBlockHash, 32, 'RECORD_BLOCK_HASH'),
  hexBytes(record.eventsHash, 32, 'RECORD_EVENTS_HASH'),
];

export const jClaimNodeWire = (node: AccountJClaimNode): RscoreWireValue[] => node.type === 'leaf'
  ? [0, hexBytes(node.key, 32, 'LEAF_KEY'), recordWire(node.record)]
  : [
      1,
      node.bit,
      hexBytes(node.left, 32, 'BRANCH_LEFT'),
      hexBytes(node.right, 32, 'BRANCH_RIGHT'),
    ];

const proofWire = (proof: AccountJClaimProof | undefined): RscoreWireValue =>
  proof === undefined ? null : [1, proof.nodes.map(jClaimNodeWire)];

const recordFromWire = (value: unknown): AccountJClaimRecord => {
  const fields = tuple(value, 5, 'RECORD');
  const side = integer(fields[1], 'RECORD_SIDE');
  if (side !== 0 && side !== 1) return fail(`RECORD_SIDE:${side}`);
  return {
    version: 1,
    accountKey: hex(fields[0], 32, 'RECORD_ACCOUNT_KEY'),
    side: side === 0 ? 'left' : 'right',
    jHeight: integer(fields[2], 'RECORD_HEIGHT'),
    jBlockHash: hex(fields[3], 32, 'RECORD_BLOCK_HASH'),
    eventsHash: hex(fields[4], 32, 'RECORD_EVENTS_HASH'),
  };
};

export const jClaimNodeFromWire = (value: unknown): AccountJClaimNode => {
  const row = list(value, 'NODE');
  const tag = integer(row[0], 'NODE_TAG');
  if (tag === 0) {
    const fields = tuple(row, 3, 'LEAF');
    return {
      version: 1,
      type: 'leaf',
      key: hex(fields[1], 32, 'LEAF_KEY'),
      record: recordFromWire(fields[2]),
    };
  }
  if (tag !== 1) return fail(`NODE_TAG:${tag}`);
  const fields = tuple(row, 4, 'BRANCH');
  const bit = integer(fields[1], 'BRANCH_BIT');
  if (bit > 255) return fail(`BRANCH_BIT:${bit}`);
  return {
    version: 1,
    type: 'branch',
    bit,
    left: hex(fields[2], 32, 'BRANCH_LEFT'),
    right: hex(fields[3], 32, 'BRANCH_RIGHT'),
  };
};

const proofFromWire = (value: unknown): AccountJClaimProof | undefined => {
  if (value === null) return undefined;
  const fields = tuple(value, 2, 'PROOF');
  if (integer(fields[0], 'PROOF_VERSION') !== 1) return fail('PROOF_VERSION');
  return { version: 1, nodes: list(fields[1], 'PROOF_NODES').map(jClaimNodeFromWire) };
};

export const jEventClaimWire = (tx: ClaimTx): RscoreWireValue[] => {
  const events = requireCanonicalJurisdictionEvents(tx.data.events);
  return [
    9,
    tx.data.jHeight,
    hexBytes(tx.data.jBlockHash, 32, 'CLAIM_BLOCK_HASH'),
    hexBytes(canonicalJurisdictionEventsHash(events), 32, 'CLAIM_EVENTS_HASH'),
    events.map(eventWire),
    proofWire(tx.data.leftProof),
    proofWire(tx.data.rightProof),
  ];
};

export const jEventClaimFromWire = (value: unknown): ClaimTx => {
  const fields = tuple(value, 7, 'CLAIM');
  if (integer(fields[0], 'CLAIM_TAG') !== 9) return fail(`CLAIM_TAG:${String(fields[0])}`);
  const events = requireCanonicalJurisdictionEvents(list(fields[4], 'CLAIM_EVENTS').map(eventFromWire));
  const suppliedHash = hex(fields[3], 32, 'CLAIM_EVENTS_HASH');
  const actualHash = canonicalJurisdictionEventsHash(events);
  if (suppliedHash !== actualHash) return fail(`CLAIM_EVENTS_HASH_MISMATCH:${suppliedHash}:${actualHash}`);
  const leftProof = proofFromWire(fields[5]);
  const rightProof = proofFromWire(fields[6]);
  return {
    type: 'j_event_claim',
    data: {
      jHeight: integer(fields[1], 'CLAIM_HEIGHT'),
      jBlockHash: hex(fields[2], 32, 'CLAIM_BLOCK_HASH'),
      events,
      ...(leftProof === undefined ? {} : { leftProof }),
      ...(rightProof === undefined ? {} : { rightProof }),
    },
  };
};
