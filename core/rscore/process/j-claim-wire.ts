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
type ProofBody = Extract<JurisdictionEvent, { type: 'DisputeStarted' }>['data']['initialProofbody'];

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

const hexBytesAny = (value: string, code: string): Uint8Array => {
  const normalized = String(value).trim().toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(normalized)) {
    return fail(`${code}_HEX:${normalized || 'missing'}`);
  }
  return Buffer.from(normalized.slice(2), 'hex');
};

const hex = (value: unknown, length: number, code: string): string =>
  `0x${Buffer.from(bytes(value, length, code)).toString('hex')}`;

const hexAny = (value: unknown, code: string): string => {
  if (!(value instanceof Uint8Array)) return fail(`${code}_BYTES:not-bytes`);
  return `0x${Buffer.from(value).toString('hex')}`;
};

const optionalInteger = (value: unknown, code: string): number | undefined =>
  value === null ? undefined : integer(value, code);

const optionalHex = (value: unknown, length: number, code: string): string | undefined =>
  value === null ? undefined : hex(value, length, code);

const metadataWire = (event: JurisdictionEvent): RscoreWireValue[] => [
  event.blockNumber ?? null,
  event.blockHash === undefined ? null : hexBytes(event.blockHash, 32, 'EVENT_BLOCK_HASH'),
  event.transactionHash === undefined
    ? null
    : hexBytes(event.transactionHash, 32, 'EVENT_TRANSACTION_HASH'),
  event.logIndex ?? null,
  event.eventIndex ?? null,
];

const optionalBigWire = (value: bigint | string | number | undefined): string | null =>
  value === undefined ? null : String(value);

const proofBodyWire = (proof: ProofBody): RscoreWireValue[] => [
  String(proof.watchSeed),
  integer(proof.leftResponseSeconds, 'PROOF_LEFT_RESPONSE_SECONDS'),
  integer(proof.rightResponseSeconds, 'PROOF_RIGHT_RESPONSE_SECONDS'),
  proof.offdeltas.map(value => String(value)),
  proof.tokenIds.map(value => String(value)),
  proof.transformers.map(transformer => [
    String(transformer.transformerAddress),
    String(transformer.encodedBatch),
    transformer.allowances.map(allowance => [
      String(allowance.deltaIndex),
      String(allowance.rightAllowance),
      String(allowance.leftAllowance),
    ]),
  ]),
];

const eventWire = (event: JurisdictionEvent): RscoreWireValue[] => {
  const metadata = metadataWire(event);
  switch (event.type) {
    case 'AccountSettled': { const data = event.data; return [
      0, metadata,
      hexBytes(data.leftEntity, 32, 'EVENT_LEFT_ENTITY'),
      hexBytes(data.rightEntity, 32, 'EVENT_RIGHT_ENTITY'),
      integer(data.tokenId, 'EVENT_TOKEN_ID'),
      String(data.leftReserve), String(data.rightReserve), String(data.collateral),
      String(data.ondelta), integer(data.nonce, 'EVENT_NONCE'),
    ]; }
    case 'FoundationBootstrapped': { const data = event.data; return [
      1, metadata, hexBytes(data.recipient, 20, 'EVENT_RECIPIENT'),
      hexBytes(data.boardHash, 32, 'EVENT_BOARD_HASH'),
      String(data.controlTokenId), String(data.dividendTokenId),
    ]; }
    case 'EntityRegistered': { const data = event.data; return [
      2, metadata, hexBytes(data.entityId, 32, 'EVENT_ENTITY_ID'),
      String(data.entityNumber), hexBytes(data.boardHash, 32, 'EVENT_BOARD_HASH'),
    ]; }
    case 'BoardActivated': { const data = event.data; return [
      3, metadata, hexBytes(data.entityId, 32, 'EVENT_ENTITY_ID'),
      hexBytes(data.previousBoardHash, 32, 'EVENT_PREVIOUS_BOARD_HASH'),
      hexBytes(data.newBoardHash, 32, 'EVENT_NEW_BOARD_HASH'),
      String(data.previousBoardValidUntil),
    ]; }
    case 'ReserveUpdated': { const data = event.data; return [
      4, metadata, data.entity, integer(data.tokenId, 'EVENT_TOKEN_ID'), String(data.newBalance),
    ]; }
    case 'ExternalWalletSnapshot': { const data = event.data; return [
      5, metadata, data.entityId, hexBytes(data.owner, 20, 'EVENT_OWNER'),
      optionalBigWire(data.nativeBalance),
      (data.tokenBalances ?? []).map(balance => [
        hexBytes(balance.tokenAddress, 20, 'EVENT_TOKEN_ADDRESS'),
        balance.tokenId ?? null,
        String(balance.balance),
      ]),
      (data.allowances ?? []).map(allowance => [
        hexBytes(allowance.tokenAddress, 20, 'EVENT_TOKEN_ADDRESS'),
        hexBytes(allowance.spender, 20, 'EVENT_SPENDER'),
        String(allowance.allowance),
      ]),
    ]; }
    case 'ExternalWalletDelta': { const data = event.data; return [
      6, metadata, data.entityId, hexBytes(data.owner, 20, 'EVENT_OWNER'),
      hexBytes(data.tokenAddress, 20, 'EVENT_TOKEN_ADDRESS'), data.tokenId ?? null,
      optionalBigWire(data.balanceDelta),
      data.spender === undefined ? null : hexBytes(data.spender, 20, 'EVENT_SPENDER'),
      optionalBigWire(data.allowance),
    ]; }
    case 'SecretRevealed': { const data = event.data; return [7, metadata, data.hashlock, data.revealer, data.secret]; }
    case 'HankoBatchProcessed': { const data = event.data; return [
      8, metadata, hexBytes(data.entityId, 32, 'EVENT_ENTITY_ID'),
      hexBytes(data.batchHash, 32, 'EVENT_BATCH_HASH'), integer(data.nonce, 'EVENT_NONCE'),
    ]; }
    case 'EntityProviderActionExecuted': { const data = event.data; return [
      9, metadata, hexBytes(data.entityId, 32, 'EVENT_ENTITY_ID'), String(data.actionNonce),
      hexBytes(data.actionHash, 32, 'EVENT_ACTION_HASH'), data.actionKind,
    ]; }
    case 'EntityProviderActionCancelled': { const data = event.data; return [
      10, metadata, hexBytes(data.entityId, 32, 'EVENT_ENTITY_ID'), String(data.actionNonce),
      hexBytes(data.cancelledActionHash, 32, 'EVENT_CANCELLED_ACTION_HASH'),
      data.cancelledActionKind, hexBytes(data.cancelHash, 32, 'EVENT_CANCEL_HASH'),
    ]; }
    case 'DebtCreated': { const data = event.data; return [
      11, metadata, data.debtor, data.creditor, data.tokenId, String(data.amount), data.debtIndex,
    ]; }
    case 'DisputeStarted': { const data = event.data; return [
      12, metadata, data.sender, data.counterentity, String(data.nonce), data.proposerIsLeft,
      data.proofbodyHash, hexBytes(data.watchSeed, 32, 'EVENT_WATCH_SEED'),
      hexBytesAny(data.starterInitialArguments, 'EVENT_STARTER_INITIAL_ARGUMENTS'),
      hexBytesAny(data.starterCounterArguments, 'EVENT_STARTER_COUNTER_ARGUMENTS'),
      hexBytes(data.starterCounterProofCommitment, 32, 'EVENT_COUNTER_PROOF_COMMITMENT'),
      proofBodyWire(data.initialProofbody), data.disputeTimeout, data.disputeStartTimestamp,
      data.leftResponseSeconds, data.rightResponseSeconds, data.batchNonce ?? null,
    ]; }
    case 'DisputeFinalized': { const data = event.data; return [
      13, metadata, data.sender, data.counterentity, String(data.initialNonce),
      data.initialProofbodyHash, data.finalProofbodyHash, data.finalizationEvidenceHash,
      proofBodyWire(data.finalProofbody), data.batchNonce ?? null,
    ]; }
    case 'CounterDisputeRegistered': { const data = event.data; return [
      14, metadata, data.sender, data.counterentity, data.nonce, data.proposerIsLeft,
      hexBytes(data.proofbodyHash, 32, 'EVENT_PROOFBODY_HASH'), proofBodyWire(data.counterProofbody),
    ]; }
    case 'HashLadderRevealRegistered': { const data = event.data; return [
      15, metadata, data.entity, data.counterpartyEntity,
      hexBytes(data.ladderHash, 32, 'EVENT_LADDER_HASH'), data.fillRatio,
      hexBytes(data.fullSecret, 32, 'EVENT_FULL_SECRET'),
      data.reveals.map(reveal => hexBytes(reveal, 32, 'EVENT_REVEAL')),
      data.targetRole, data.revealedAt,
    ]; }
    case 'DebtEnforced': { const data = event.data; return [
      16, metadata, data.debtor, data.creditor, data.tokenId,
      String(data.amountPaid), String(data.remainingAmount), data.newDebtIndex,
    ]; }
    case 'DebtForgiven': { const data = event.data; return [
      17, metadata, data.debtor, data.creditor, data.tokenId,
      String(data.amountForgiven), data.debtIndex,
    ]; }
  }
};

const metadataFromWire = (value: unknown): Omit<JurisdictionEvent, 'type' | 'data'> => {
  const metadata = tuple(value, 5, 'EVENT_METADATA');
  const blockNumber = optionalInteger(metadata[0], 'EVENT_BLOCK_NUMBER');
  const blockHash = optionalHex(metadata[1], 32, 'EVENT_BLOCK_HASH');
  const transactionHash = optionalHex(metadata[2], 32, 'EVENT_TRANSACTION_HASH');
  const logIndex = optionalInteger(metadata[3], 'EVENT_LOG_INDEX');
  const eventIndex = optionalInteger(metadata[4], 'EVENT_INDEX');
  return {
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(blockHash === undefined ? {} : { blockHash }),
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(logIndex === undefined ? {} : { logIndex }),
    ...(eventIndex === undefined ? {} : { eventIndex }),
  };
};

const proofBodyFromWire = (value: unknown): ProofBody => {
  const fields = tuple(value, 6, 'PROOF_BODY');
  return {
    watchSeed: text(fields[0], 'PROOF_WATCH_SEED'),
    leftResponseSeconds: integer(fields[1], 'PROOF_LEFT_RESPONSE_SECONDS'),
    rightResponseSeconds: integer(fields[2], 'PROOF_RIGHT_RESPONSE_SECONDS'),
    offdeltas: list(fields[3], 'PROOF_OFFDELTAS').map((entry, index) => big(entry, `PROOF_OFFDELTA_${index}`)),
    tokenIds: list(fields[4], 'PROOF_TOKEN_IDS').map((entry, index) => big(entry, `PROOF_TOKEN_ID_${index}`)),
    transformers: list(fields[5], 'PROOF_TRANSFORMERS').map((entry, transformerIndex) => {
      const transformer = tuple(entry, 3, `PROOF_TRANSFORMER_${transformerIndex}`);
      return {
        transformerAddress: text(transformer[0], 'PROOF_TRANSFORMER_ADDRESS'),
        encodedBatch: text(transformer[1], 'PROOF_ENCODED_BATCH'),
        allowances: list(transformer[2], 'PROOF_ALLOWANCES').map((allowanceEntry, allowanceIndex) => {
          const allowance = tuple(allowanceEntry, 3, `PROOF_ALLOWANCE_${allowanceIndex}`);
          return {
            deltaIndex: big(allowance[0], 'PROOF_DELTA_INDEX'),
            rightAllowance: big(allowance[1], 'PROOF_RIGHT_ALLOWANCE'),
            leftAllowance: big(allowance[2], 'PROOF_LEFT_ALLOWANCE'),
          };
        }),
      };
    }),
  };
};

const eventFromWire = (value: unknown): JurisdictionEvent => {
  const row = list(value, 'EVENT');
  const tag = integer(row[0], 'EVENT_TAG');
  const metadata = metadataFromWire(row[1]);
  const fields = (length: number, code: string): unknown[] => tuple(row, length, code);
  switch (tag) {
    case 0: { const f = fields(10, 'ACCOUNT_SETTLED'); return { ...metadata, type: 'AccountSettled', data: { leftEntity: hex(f[2], 32, 'EVENT_LEFT_ENTITY'), rightEntity: hex(f[3], 32, 'EVENT_RIGHT_ENTITY'), tokenId: integer(f[4], 'EVENT_TOKEN_ID'), leftReserve: big(f[5], 'EVENT_LEFT_RESERVE').toString(), rightReserve: big(f[6], 'EVENT_RIGHT_RESERVE').toString(), collateral: big(f[7], 'EVENT_COLLATERAL').toString(), ondelta: big(f[8], 'EVENT_ONDELTA').toString(), nonce: integer(f[9], 'EVENT_NONCE') } }; }
    case 1: { const f = fields(6, 'FOUNDATION_BOOTSTRAPPED'); return { ...metadata, type: 'FoundationBootstrapped', data: { recipient: hex(f[2], 20, 'EVENT_RECIPIENT'), boardHash: hex(f[3], 32, 'EVENT_BOARD_HASH'), controlTokenId: big(f[4], 'EVENT_CONTROL_TOKEN_ID').toString(), dividendTokenId: big(f[5], 'EVENT_DIVIDEND_TOKEN_ID').toString() } }; }
    case 2: { const f = fields(5, 'ENTITY_REGISTERED'); return { ...metadata, type: 'EntityRegistered', data: { entityId: hex(f[2], 32, 'EVENT_ENTITY_ID'), entityNumber: big(f[3], 'EVENT_ENTITY_NUMBER').toString(), boardHash: hex(f[4], 32, 'EVENT_BOARD_HASH') } }; }
    case 3: { const f = fields(6, 'BOARD_ACTIVATED'); return { ...metadata, type: 'BoardActivated', data: { entityId: hex(f[2], 32, 'EVENT_ENTITY_ID'), previousBoardHash: hex(f[3], 32, 'EVENT_PREVIOUS_BOARD_HASH'), newBoardHash: hex(f[4], 32, 'EVENT_NEW_BOARD_HASH'), previousBoardValidUntil: big(f[5], 'EVENT_PREVIOUS_BOARD_VALID_UNTIL').toString() } }; }
    case 4: { const f = fields(5, 'RESERVE_UPDATED'); return { ...metadata, type: 'ReserveUpdated', data: { entity: text(f[2], 'EVENT_ENTITY'), tokenId: integer(f[3], 'EVENT_TOKEN_ID'), newBalance: big(f[4], 'EVENT_NEW_BALANCE').toString() } }; }
    case 5: { const f = fields(7, 'WALLET_SNAPSHOT'); const nativeBalance = f[4] === null ? undefined : big(f[4], 'EVENT_NATIVE_BALANCE').toString(); const tokenBalances = list(f[5], 'EVENT_TOKEN_BALANCES').map(entry => { const b = tuple(entry, 3, 'EVENT_TOKEN_BALANCE'); const tokenId = optionalInteger(b[1], 'EVENT_TOKEN_ID'); return { tokenAddress: hex(b[0], 20, 'EVENT_TOKEN_ADDRESS'), ...(tokenId === undefined ? {} : { tokenId }), balance: big(b[2], 'EVENT_BALANCE').toString() }; }); const allowances = list(f[6], 'EVENT_ALLOWANCES').map(entry => { const a = tuple(entry, 3, 'EVENT_ALLOWANCE'); return { tokenAddress: hex(a[0], 20, 'EVENT_TOKEN_ADDRESS'), spender: hex(a[1], 20, 'EVENT_SPENDER'), allowance: big(a[2], 'EVENT_ALLOWANCE').toString() }; }); return { ...metadata, type: 'ExternalWalletSnapshot', data: { entityId: text(f[2], 'EVENT_ENTITY_ID'), owner: hex(f[3], 20, 'EVENT_OWNER'), ...(nativeBalance === undefined ? {} : { nativeBalance }), ...(tokenBalances.length ? { tokenBalances } : {}), ...(allowances.length ? { allowances } : {}) } }; }
    case 6: { const f = fields(9, 'WALLET_DELTA'); const tokenId = optionalInteger(f[5], 'EVENT_TOKEN_ID'); const balanceDelta = f[6] === null ? undefined : big(f[6], 'EVENT_BALANCE_DELTA').toString(); const spender = optionalHex(f[7], 20, 'EVENT_SPENDER'); const allowance = f[8] === null ? undefined : big(f[8], 'EVENT_ALLOWANCE').toString(); return { ...metadata, type: 'ExternalWalletDelta', data: { entityId: text(f[2], 'EVENT_ENTITY_ID'), owner: hex(f[3], 20, 'EVENT_OWNER'), tokenAddress: hex(f[4], 20, 'EVENT_TOKEN_ADDRESS'), ...(tokenId === undefined ? {} : { tokenId }), ...(balanceDelta === undefined ? {} : { balanceDelta }), ...(spender === undefined || allowance === undefined ? {} : { spender, allowance }) } }; }
    case 7: { const f = fields(5, 'SECRET_REVEALED'); return { ...metadata, type: 'SecretRevealed', data: { hashlock: text(f[2], 'EVENT_HASHLOCK'), revealer: text(f[3], 'EVENT_REVEALER'), secret: text(f[4], 'EVENT_SECRET') } }; }
    case 8: { const f = fields(5, 'HANKO_BATCH_PROCESSED'); return { ...metadata, type: 'HankoBatchProcessed', data: { entityId: hex(f[2], 32, 'EVENT_ENTITY_ID'), batchHash: hex(f[3], 32, 'EVENT_BATCH_HASH'), nonce: integer(f[4], 'EVENT_NONCE') } }; }
    case 9: { const f = fields(6, 'ACTION_EXECUTED'); const actionKind = integer(f[5], 'EVENT_ACTION_KIND'); if (actionKind !== 0 && actionKind !== 1) return fail('EVENT_ACTION_KIND'); return { ...metadata, type: 'EntityProviderActionExecuted', data: { entityId: hex(f[2], 32, 'EVENT_ENTITY_ID'), actionNonce: big(f[3], 'EVENT_ACTION_NONCE').toString(), actionHash: hex(f[4], 32, 'EVENT_ACTION_HASH'), actionKind } }; }
    case 10: { const f = fields(7, 'ACTION_CANCELLED'); const cancelledActionKind = integer(f[5], 'EVENT_CANCELLED_ACTION_KIND'); if (cancelledActionKind !== 0 && cancelledActionKind !== 1) return fail('EVENT_CANCELLED_ACTION_KIND'); return { ...metadata, type: 'EntityProviderActionCancelled', data: { entityId: hex(f[2], 32, 'EVENT_ENTITY_ID'), actionNonce: big(f[3], 'EVENT_ACTION_NONCE').toString(), cancelledActionHash: hex(f[4], 32, 'EVENT_CANCELLED_ACTION_HASH'), cancelledActionKind, cancelHash: hex(f[6], 32, 'EVENT_CANCEL_HASH') } }; }
    case 11: { const f = fields(7, 'DEBT_CREATED'); return { ...metadata, type: 'DebtCreated', data: { debtor: text(f[2], 'EVENT_DEBTOR'), creditor: text(f[3], 'EVENT_CREDITOR'), tokenId: integer(f[4], 'EVENT_TOKEN_ID'), amount: big(f[5], 'EVENT_AMOUNT').toString(), debtIndex: integer(f[6], 'EVENT_DEBT_INDEX') } }; }
    case 12: { const f = fields(17, 'DISPUTE_STARTED'); const batchNonce = optionalInteger(f[16], 'EVENT_BATCH_NONCE'); return { ...metadata, type: 'DisputeStarted', data: { sender: text(f[2], 'EVENT_SENDER'), counterentity: text(f[3], 'EVENT_COUNTERENTITY'), nonce: big(f[4], 'EVENT_NONCE').toString(), proposerIsLeft: typeof f[5] === 'boolean' ? f[5] : fail('EVENT_PROPOSER_IS_LEFT'), proofbodyHash: text(f[6], 'EVENT_PROOFBODY_HASH'), watchSeed: hex(f[7], 32, 'EVENT_WATCH_SEED'), starterInitialArguments: hexAny(f[8], 'EVENT_STARTER_INITIAL_ARGUMENTS'), starterCounterArguments: hexAny(f[9], 'EVENT_STARTER_COUNTER_ARGUMENTS'), starterCounterProofCommitment: hex(f[10], 32, 'EVENT_COUNTER_PROOF_COMMITMENT'), initialProofbody: proofBodyFromWire(f[11]), disputeTimeout: integer(f[12], 'EVENT_DISPUTE_TIMEOUT'), disputeStartTimestamp: integer(f[13], 'EVENT_DISPUTE_START_TIMESTAMP'), leftResponseSeconds: integer(f[14], 'EVENT_LEFT_RESPONSE_SECONDS'), rightResponseSeconds: integer(f[15], 'EVENT_RIGHT_RESPONSE_SECONDS'), ...(batchNonce === undefined ? {} : { batchNonce }) } }; }
    case 13: { const f = fields(10, 'DISPUTE_FINALIZED'); const batchNonce = optionalInteger(f[9], 'EVENT_BATCH_NONCE'); return { ...metadata, type: 'DisputeFinalized', data: { sender: text(f[2], 'EVENT_SENDER'), counterentity: text(f[3], 'EVENT_COUNTERENTITY'), initialNonce: big(f[4], 'EVENT_INITIAL_NONCE').toString(), initialProofbodyHash: text(f[5], 'EVENT_INITIAL_PROOFBODY_HASH'), finalProofbodyHash: text(f[6], 'EVENT_FINAL_PROOFBODY_HASH'), finalizationEvidenceHash: text(f[7], 'EVENT_FINALIZATION_EVIDENCE_HASH'), finalProofbody: proofBodyFromWire(f[8]), ...(batchNonce === undefined ? {} : { batchNonce }) } }; }
    case 14: { const f = fields(8, 'COUNTER_DISPUTE'); return { ...metadata, type: 'CounterDisputeRegistered', data: { sender: text(f[2], 'EVENT_SENDER'), counterentity: text(f[3], 'EVENT_COUNTERENTITY'), nonce: integer(f[4], 'EVENT_NONCE'), proposerIsLeft: typeof f[5] === 'boolean' ? f[5] : fail('EVENT_PROPOSER_IS_LEFT'), proofbodyHash: hex(f[6], 32, 'EVENT_PROOFBODY_HASH'), counterProofbody: proofBodyFromWire(f[7]) } }; }
    case 15: { const f = fields(10, 'HASH_LADDER_REVEAL'); const reveals = tuple(f[7], 4, 'EVENT_REVEALS').map(entry => hex(entry, 32, 'EVENT_REVEAL')) as [string, string, string, string]; return { ...metadata, type: 'HashLadderRevealRegistered', data: { entity: text(f[2], 'EVENT_ENTITY'), counterpartyEntity: text(f[3], 'EVENT_COUNTERPARTY_ENTITY'), ladderHash: hex(f[4], 32, 'EVENT_LADDER_HASH'), fillRatio: integer(f[5], 'EVENT_FILL_RATIO'), fullSecret: hex(f[6], 32, 'EVENT_FULL_SECRET'), reveals, targetRole: typeof f[8] === 'boolean' ? f[8] : fail('EVENT_TARGET_ROLE'), revealedAt: integer(f[9], 'EVENT_REVEALED_AT') } }; }
    case 16: { const f = fields(8, 'DEBT_ENFORCED'); return { ...metadata, type: 'DebtEnforced', data: { debtor: text(f[2], 'EVENT_DEBTOR'), creditor: text(f[3], 'EVENT_CREDITOR'), tokenId: integer(f[4], 'EVENT_TOKEN_ID'), amountPaid: big(f[5], 'EVENT_AMOUNT_PAID').toString(), remainingAmount: big(f[6], 'EVENT_REMAINING_AMOUNT').toString(), newDebtIndex: integer(f[7], 'EVENT_NEW_DEBT_INDEX') } }; }
    case 17: { const f = fields(7, 'DEBT_FORGIVEN'); return { ...metadata, type: 'DebtForgiven', data: { debtor: text(f[2], 'EVENT_DEBTOR'), creditor: text(f[3], 'EVENT_CREDITOR'), tokenId: integer(f[4], 'EVENT_TOKEN_ID'), amountForgiven: big(f[5], 'EVENT_AMOUNT_FORGIVEN').toString(), debtIndex: integer(f[6], 'EVENT_DEBT_INDEX') } }; }
    default: return fail(`EVENT_TAG:${tag}`);
  }
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
