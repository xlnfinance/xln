import { assertEntityProposalAction } from '../../entity/authorization';
import { normalizeSignedEntityCommand } from '../../entity/command-codec';
import { normalizeConsensusOutputBoardAuthority } from '../../entity/consensus/output-certification';
import type { EntityTx, ProposalAction } from '../../types';
import { assertExactMultiRecipientCiphertextSchema } from '../../protocol/htlc/multi-recipient-schema';
import {
  requireArray,
  requireBigInt,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
  validateStorageSafeValue,
} from './primitives';

const ENTITY_TX_NESTING_LIMIT = 16;

const ENTITY_TX_TYPES = [
  'accountInput', 'admitCrossJurisdictionBookOrder', 'applyCrossJurisdictionBookProgress',
  'cancelPull', 'certifyProfile', 'chat', 'chatMessage', 'commitCrossJurisdictionSwap',
  'consensusOutput', 'crossJurisdictionFillNotice', 'crossJurisdictionSalvage',
  'crossPullClose', 'directPayment', 'disputeFinalize', 'disputeStart', 'e2r',
  'entityCommand', 'entityProviderCancelAction', 'entityProviderReleaseControlShares',
  'entityProviderTransfer', 'extendCredit', 'hashlockPayment', 'htlcOnionAdvance', 'htlcPayment',
  'initOrderbookExt', 'j_abort_sent_batch', 'j_broadcast', 'j_clear_batch', 'j_event',
  'j_event_account_claim', 'j_rebroadcast', 'lendingBorrow', 'lendingClosePosition',
  'lendingOffer', 'lendingRepay', 'manualHtlcLock', 'mintReserves', 'openAccount',
  'orderbookSweepCrossJurisdiction', 'payFromReserve', 'payToReserve', 'placeSwapOffer',
  'prepareCrossJurisdictionSwap', 'prepareDispute', 'processHtlcTimeouts', 'profile-update',
  'propose', 'proposeCancelSwap', 'pullCancelExpired', 'pullLock', 'r2c', 'r2e', 'r2r',
  'registerCrossJurisdictionSwap', 'reissueCertifiedOutput', 'removeCrossJurisdictionBookOrder',
  'reopenDisputedAccount', 'requestCollateral', 'requestCrossJurisdictionClear',
  'materializeCrossJurisdictionClear', 'materializeCrossJurisdictionSwap',
  'requestCrossJurisdictionSwap', 'resolveHtlcLock', 'resolvePull', 'resolveSwap',
  'rollbackTimedOutFrames', 'scheduledWake', 'setHubConfig', 'setRebalancePolicy',
  'settle_approve', 'settle_execute', 'settle_propose', 'settle_reject', 'settle_update', 'vote',
] as const satisfies readonly EntityTx['type'][];

type MissingEntityTxType = Exclude<EntityTx['type'], (typeof ENTITY_TX_TYPES)[number]>;
type AssertNoMissingEntityTxType = MissingEntityTxType extends never ? true : never;
const ENTITY_TX_TYPES_ARE_EXHAUSTIVE: AssertNoMissingEntityTxType = true;
void ENTITY_TX_TYPES_ARE_EXHAUSTIVE;

const KNOWN_ENTITY_TX_TYPES = new Set<string>(ENTITY_TX_TYPES);

const validateOrigin = (value: unknown, code: string): void => {
  const origin = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(origin, [
    'sourceEntityId', 'lane', 'sequence', 'semanticHash', 'height', 'frameHash', 'outputIndex',
  ], ['boardAuthority'], `${code}_FIELDS`);
  for (const field of ['sourceEntityId', 'semanticHash', 'frameHash']) {
    requireString(origin[field], `${code}_${field.toUpperCase()}`);
  }
  if (!['generic', 'account-frame', 'account-ack', 'account-dispute', 'account-settlement'].includes(String(origin['lane']))) {
    throw new Error(`${code}_LANE`);
  }
  requireBigInt(origin['sequence'], `${code}_SEQUENCE`, 0n);
  requireBoundaryInteger(origin['height'], `${code}_HEIGHT`);
  requireBoundaryInteger(origin['outputIndex'], `${code}_OUTPUT_INDEX`);
  if (origin['boardAuthority'] !== undefined) {
    const authority = requireBoundaryRecord(origin['boardAuthority'], `${code}_BOARD_AUTHORITY`);
    requireExactBoundaryKeys(
      authority,
      ['version', 'stackKey', 'record'],
      [],
      `${code}_BOARD_AUTHORITY_FIELDS`,
    );
    const record = requireBoundaryRecord(authority['record'], `${code}_BOARD_AUTHORITY_RECORD`);
    requireExactBoundaryKeys(record, [
      'stackKey', 'entityId', 'boardHash', 'boardEpoch', 'previousBoardHash',
      'previousBoardValidUntil', 'activatedAtJHeight', 'logIndex', 'blockHash',
      'transactionHash', 'source',
    ], [], `${code}_BOARD_AUTHORITY_RECORD_FIELDS`);
    normalizeConsensusOutputBoardAuthority(authority, String(origin['sourceEntityId']));
  }
};

const validateNestedTxs = (value: unknown, code: string, depth: number): void => {
  if (depth > ENTITY_TX_NESTING_LIMIT) throw new Error(`${code}_NESTING_LIMIT`);
  requireArray(value, code).forEach((tx, index) =>
    validateEntityTxRecord(tx, `${code}_${index}`, depth));
};

const validateEntityCommand = (value: unknown, code: string, depth: number): void => {
  const command = normalizeSignedEntityCommand(value);
  validateNestedTxs(command.txs, `${code}_TXS`, depth + 1);
};

const validateProposal = (value: unknown, code: string, depth: number): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, ['action', 'proposer'], [], `${code}_FIELDS`);
  requireString(data['proposer'], `${code}_PROPOSER`);
  const action: ProposalAction = assertEntityProposalAction(data['action']);
  if (action.type === 'entity_transaction') {
    validateNestedTxs(action.data.txs, `${code}_ACTION_TXS`, depth + 1);
  }
};

const validateConsensusOutput = (value: unknown, code: string, depth: number): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    data,
    ['origin', 'outputHanko', 'targetEntityId', 'entityTxs'],
    ['consumptionProof'],
    `${code}_FIELDS`,
  );
  validateOrigin(data['origin'], `${code}_ORIGIN`);
  requireString(data['outputHanko'], `${code}_HANKO`);
  requireString(data['targetEntityId'], `${code}_TARGET`);
  if (data['consumptionProof'] !== undefined) {
    requireBoundaryRecord(data['consumptionProof'], `${code}_CONSUMPTION_PROOF`);
  }
  validateNestedTxs(data['entityTxs'], `${code}_ENTITY_TXS`, depth + 1);
};

const validateReissue = (value: unknown, code: string, depth: number): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    data,
    ['targetEntityId', 'targetSignerId', 'sequence', 'semanticHash', 'entityTxs'],
    [],
    `${code}_FIELDS`,
  );
  requireString(data['targetEntityId'], `${code}_TARGET`);
  requireString(data['targetSignerId'], `${code}_TARGET_SIGNER`);
  requireBigInt(data['sequence'], `${code}_SEQUENCE`, 0n);
  requireString(data['semanticHash'], `${code}_SEMANTIC_HASH`);
  validateNestedTxs(data['entityTxs'], `${code}_ENTITY_TXS`, depth + 1);
};

const validateScheduledWake = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, ['version', 'proposerSignerId', 'dueAt', 'jobs'], [], `${code}_FIELDS`);
  if (data['version'] !== 1) throw new Error(`${code}_VERSION`);
  requireString(data['proposerSignerId'], `${code}_PROPOSER`);
  requireBoundaryInteger(data['dueAt'], `${code}_DUE_AT`);
  requireArray(data['jobs'], `${code}_JOBS`).forEach((raw, index) => {
    const job = requireBoundaryRecord(raw, `${code}_JOB_${index}`);
    requireExactBoundaryKeys(job, ['kind', 'id', 'dueAt'], [], `${code}_JOB_${index}_FIELDS`);
    if (job['kind'] !== 'hook' && job['kind'] !== 'task') throw new Error(`${code}_JOB_${index}_KIND`);
    requireString(job['id'], `${code}_JOB_${index}_ID`);
    requireBoundaryInteger(job['dueAt'], `${code}_JOB_${index}_DUE_AT`);
  });
};

const PREPARED_HTLC_PAYMENT_FIELDS = [
  'amount', 'deliveryMode', 'description', 'hashlock', 'preparedAtEntityHeight',
  'preparedAtJHeight', 'preparedEnvelope', 'preparedHopForwardAmounts', 'preparedLockId',
  'preparedRevealBeforeHeight', 'preparedRouteProfiles', 'preparedSenderLockAmount',
  'preparedTimelock', 'preparedTotalFee', 'route', 'startedAtMs', 'targetEntityId', 'tokenId',
] as const;

const validatePreparedHtlcPayment = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, PREPARED_HTLC_PAYMENT_FIELDS, [], `${code}_FIELDS`);
  const envelope = requireBoundaryRecord(data['preparedEnvelope'], `${code}_ENVELOPE`);
  requireExactBoundaryKeys(envelope, ['nextHop', 'innerEnvelope'], [], `${code}_ENVELOPE_FIELDS`);
  requireString(envelope['nextHop'], `${code}_ENVELOPE_NEXT_HOP`);
  assertExactMultiRecipientCiphertextSchema(envelope['innerEnvelope']);
};

const validateHtlcOnionAdvance = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, [
    'version', 'proposerSignerId', 'inboundEntityId', 'inboundLockId', 'encryptedLayerHash',
    'hashlock', 'tokenId', 'amount', 'timelock', 'revealBeforeHeight', 'advance',
  ], [], `${code}_FIELDS`);
  if (data['version'] !== 1) throw new Error(`${code}_VERSION`);
  for (const field of [
    'proposerSignerId', 'inboundEntityId', 'inboundLockId', 'encryptedLayerHash', 'hashlock',
  ]) requireString(data[field], `${code}_${field.toUpperCase()}`);
  requireBoundaryInteger(data['tokenId'], `${code}_TOKEN_ID`);
  requireBigInt(data['amount'], `${code}_AMOUNT`, 1n);
  requireBigInt(data['timelock'], `${code}_TIMELOCK`, 1n);
  requireBoundaryInteger(data['revealBeforeHeight'], `${code}_REVEAL_HEIGHT`);
  const advance = requireBoundaryRecord(data['advance'], `${code}_ADVANCE`);
  if (advance['kind'] === 'final') {
    requireExactBoundaryKeys(advance, ['kind', 'secretOffer'], ['description', 'startedAtMs'], `${code}_FINAL_FIELDS`);
    assertExactMultiRecipientCiphertextSchema(advance['secretOffer']);
    if (advance['description'] !== undefined) requireString(advance['description'], `${code}_FINAL_DESCRIPTION`);
    if (advance['startedAtMs'] !== undefined) {
      requireBoundaryInteger(advance['startedAtMs'], `${code}_FINAL_STARTED_AT`);
    }
    return;
  }
  if (advance['kind'] === 'acceptOffer') {
    requireExactBoundaryKeys(advance, ['kind', 'offerHash'], [], `${code}_ACCEPT_FIELDS`);
    requireString(advance['offerHash'], `${code}_ACCEPT_OFFER_HASH`);
    return;
  }
  if (advance['kind'] === 'revealAccepted') {
    requireExactBoundaryKeys(
      advance,
      ['kind', 'offerHash', 'accountFrameHash', 'accountFrameHeight', 'secret'],
      [],
      `${code}_REVEAL_FIELDS`,
    );
    requireString(advance['offerHash'], `${code}_REVEAL_OFFER_HASH`);
    requireString(advance['accountFrameHash'], `${code}_REVEAL_FRAME_HASH`);
    requireBoundaryInteger(advance['accountFrameHeight'], `${code}_REVEAL_FRAME_HEIGHT`);
    requireString(advance['secret'], `${code}_REVEAL_SECRET`);
    return;
  }
  if (advance['kind'] !== 'forward') throw new Error(`${code}_ADVANCE_KIND`);
  requireExactBoundaryKeys(
    advance,
    ['kind', 'nextHop', 'forwardAmount', 'innerEnvelope'],
    [],
    `${code}_FORWARD_FIELDS`,
  );
  requireString(advance['nextHop'], `${code}_FORWARD_NEXT_HOP`);
  requireBigInt(advance['forwardAmount'], `${code}_FORWARD_AMOUNT`, 1n);
  assertExactMultiRecipientCiphertextSchema(advance['innerEnvelope']);
};

const validateSimpleIdentityTx = (type: string, value: unknown, code: string): boolean => {
  const data = requireBoundaryRecord(value, code);
  if (type === 'chat') {
    requireExactBoundaryKeys(data, ['from', 'message'], [], `${code}_FIELDS`);
    requireString(data['from'], `${code}_FROM`);
    if (typeof data['message'] !== 'string') throw new Error(`${code}_MESSAGE`);
    return true;
  }
  if (type === 'vote') {
    requireExactBoundaryKeys(data, ['proposalId', 'voter', 'choice'], ['comment'], `${code}_FIELDS`);
    requireString(data['proposalId'], `${code}_PROPOSAL`);
    requireString(data['voter'], `${code}_VOTER`);
    if (data['choice'] !== 'yes' && data['choice'] !== 'no') throw new Error(`${code}_CHOICE`);
    if (data['comment'] !== undefined && typeof data['comment'] !== 'string') throw new Error(`${code}_COMMENT`);
    return true;
  }
  return false;
};

const validateCrossJMaterialization = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, ['proposerSignerId', 'route'], [], `${code}_FIELDS`);
  requireString(data['proposerSignerId'], `${code}_PROPOSER_SIGNER`);
  requireBoundaryRecord(data['route'], `${code}_ROUTE`);
};

const validateCrossJClearMaterialization = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    data,
    ['proposerSignerId', 'orderId', 'binary', 'proof'],
    [],
    `${code}_FIELDS`,
  );
  requireString(data['proposerSignerId'], `${code}_PROPOSER_SIGNER`);
  requireString(data['orderId'], `${code}_ORDER_ID`);
  requireString(data['binary'], `${code}_BINARY`);
  const proof = requireBoundaryRecord(data['proof'], `${code}_PROOF`);
  requireExactBoundaryKeys(proof, [
    'orderId', 'routeHash', 'sourcePullId', 'targetPullId', 'fillRatio',
    'cumulativeSourceAmount', 'cumulativeTargetAmount', 'binaryHash', 'closeMode',
  ], [], `${code}_PROOF_FIELDS`);
  for (const field of ['orderId', 'routeHash', 'sourcePullId', 'targetPullId', 'binaryHash']) {
    requireString(proof[field], `${code}_PROOF_${field.toUpperCase()}`);
  }
  requireBoundaryInteger(proof['fillRatio'], `${code}_PROOF_FILL_RATIO`);
  requireBigInt(proof['cumulativeSourceAmount'], `${code}_PROOF_SOURCE_AMOUNT`, 0n);
  requireBigInt(proof['cumulativeTargetAmount'], `${code}_PROOF_TARGET_AMOUNT`, 0n);
  if (!['full', 'partial_cancel_remainder', 'pure_cancel'].includes(String(proof['closeMode']))) {
    throw new Error(`${code}_PROOF_CLOSE_MODE`);
  }
};

const validateEntityTxRecord = (value: unknown, code: string, depth: number): EntityTx => {
  if (depth > ENTITY_TX_NESTING_LIMIT) throw new Error(`${code}_NESTING_LIMIT`);
  const tx = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(tx, ['type', 'data'], [], `${code}_FIELDS`);
  const type = requireString(tx['type'], `${code}_TYPE`);
  if (!KNOWN_ENTITY_TX_TYPES.has(type)) throw new Error(`${code}_TYPE_UNKNOWN:${type}`);
  requireBoundaryRecord(tx['data'], `${code}_DATA`);
  if (type === 'entityCommand') validateEntityCommand(tx['data'], `${code}_DATA`, depth);
  else if (type === 'propose') validateProposal(tx['data'], `${code}_DATA`, depth);
  else if (type === 'consensusOutput') validateConsensusOutput(tx['data'], `${code}_DATA`, depth);
  else if (type === 'reissueCertifiedOutput') validateReissue(tx['data'], `${code}_DATA`, depth);
  else if (type === 'scheduledWake') validateScheduledWake(tx['data'], `${code}_DATA`);
  else if (type === 'htlcPayment') validatePreparedHtlcPayment(tx['data'], `${code}_DATA`);
  else if (type === 'htlcOnionAdvance') validateHtlcOnionAdvance(tx['data'], `${code}_DATA`);
  else if (type === 'materializeCrossJurisdictionClear') validateCrossJClearMaterialization(tx['data'], `${code}_DATA`);
  else if (type === 'materializeCrossJurisdictionSwap') validateCrossJMaterialization(tx['data'], `${code}_DATA`);
  else validateSimpleIdentityTx(type, tx['data'], `${code}_DATA`);
  return tx as unknown as EntityTx;
};

export const validateEntityTx = (value: unknown, code: string): EntityTx => {
  validateStorageSafeValue(value, code);
  return validateEntityTxRecord(value, code, 0);
};

export const validateEntityTxs = (value: unknown, code: string): EntityTx[] => {
  validateStorageSafeValue(value, code);
  return requireArray(value, code).map((tx, index) =>
    validateEntityTxRecord(tx, `${code}_${index}`, 0));
};
