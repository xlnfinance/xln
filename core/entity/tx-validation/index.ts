import { decodeAccountPeerInput } from '../../account/validation/input-validation';
import type { EntityTx } from '../../types/entity-tx';
import { assertEntityProposalAction } from '../auth/authorization';
import { validateConsensusConfig } from '../consensus/config-validation';
import { normalizeSignedEntityCommand } from '../command/command-codec';
import { normalizeConsensusOutputBoardAuthority } from '../consensus/output/certification';
import type { ProposalAction } from '../types';
import { requireKnownEntityTxType } from '../tx/processing/catalog';
import {
  requireArray,
  requireBigInt,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
  validateStorageSafeValue,
} from '../../protocol/boundary/boundary-primitives';
import {
  isSimpleEntityTxType,
  validateSimpleEntityTxData,
} from './simple';
import {
  assertCrossJurisdictionSwapRoute,
  validateCrossJurisdictionRouteEntityTx,
} from './cross-j-route';

const ENTITY_TX_NESTING_LIMIT = 16;

const validateOrigin = (value: unknown, code: string): void => {
  const origin = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(origin, [
    'sourceEntityId', 'lane', 'sequence', 'semanticHash', 'height', 'frameHash', 'outputIndex',
  ], ['boardAuthority'], `${code}_FIELDS`);
  for (const field of ['sourceEntityId', 'semanticHash', 'frameHash']) {
    requireString(origin[field], `${code}_${field.toUpperCase()}`);
  }
  if (origin['lane'] !== 'generic') {
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

const validateRuntimeOutput = (value: unknown, code: string, depth: number): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    data,
    ['protocol', 'sourceEntityId', 'targetEntityId', 'entityTxs'],
    [],
    `${code}_FIELDS`,
  );
  if (data['protocol'] !== 'cross-j') throw new Error(`${code}_PROTOCOL`);
  requireString(data['sourceEntityId'], `${code}_SOURCE`);
  requireString(data['targetEntityId'], `${code}_TARGET`);
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
    if (job['kind'] !== 'hook' && job['kind'] !== 'task') {
      throw new Error(`${code}_JOB_${index}_KIND`);
    }
    requireString(job['id'], `${code}_JOB_${index}_ID`);
    requireBoundaryInteger(job['dueAt'], `${code}_JOB_${index}_DUE_AT`);
  });
};

const validateBoardHandover = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, ['board'], [], `${code}_FIELDS`);
  const board = requireBoundaryRecord(data['board'], `${code}_BOARD`);
  requireExactBoundaryKeys(
    board,
    ['mode', 'threshold', 'validators', 'shares'],
    [],
    `${code}_BOARD_FIELDS`,
  );
  validateConsensusConfig(board, `${code}_BOARD`);
};

const HTLC_PAYMENT_FIELDS = ['amount', 'deliveryMode', 'maxSenderDebit', 'route', 'targetEntityId', 'tokenId'] as const;

const validatePreparedHtlcPayment = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, HTLC_PAYMENT_FIELDS, ['description', 'hashlock', 'startedAtMs'], `${code}_FIELDS`);
  requireBigInt(data['maxSenderDebit'], `${code}_MAX_SENDER_DEBIT`, 1n);
  requireBigInt(data['amount'], `${code}_AMOUNT`, 1n);
  requireBoundaryInteger(data['tokenId'], `${code}_TOKEN_ID`);
  requireString(data['targetEntityId'], `${code}_TARGET`);
  requireString(data['deliveryMode'], `${code}_DELIVERY_MODE`);
  requireArray(data['route'], `${code}_ROUTE`).forEach((entityId, index) =>
    requireString(entityId, `${code}_ROUTE_${index}`));
  if (data['description'] !== undefined) requireString(data['description'], `${code}_DESCRIPTION`);
  if (data['hashlock'] !== undefined) requireString(data['hashlock'], `${code}_HASHLOCK`);
  if (data['startedAtMs'] !== undefined) requireBoundaryInteger(data['startedAtMs'], `${code}_STARTED_AT`);
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
  assertCrossJurisdictionSwapRoute(data['route'], `${code}_ROUTE`);
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

function assertEntityTxRecord(
  value: unknown,
  code: string,
  depth: number,
): asserts value is EntityTx {
  if (depth > ENTITY_TX_NESTING_LIMIT) throw new Error(`${code}_NESTING_LIMIT`);
  const tx = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(tx, ['type', 'data'], [], `${code}_FIELDS`);
  const type = requireKnownEntityTxType(tx, code);
  requireBoundaryRecord(tx['data'], `${code}_DATA`);
  if (type === 'entityCommand') validateEntityCommand(tx['data'], `${code}_DATA`, depth);
  else if (type === 'boardHandover') validateBoardHandover(tx['data'], `${code}_DATA`);
  else if (type === 'propose') validateProposal(tx['data'], `${code}_DATA`, depth);
  else if (type === 'consensusOutput') validateConsensusOutput(tx['data'], `${code}_DATA`, depth);
  else if (type === 'runtimeOutput') validateRuntimeOutput(tx['data'], `${code}_DATA`, depth);
  else if (type === 'reissueCertifiedOutput') validateReissue(tx['data'], `${code}_DATA`, depth);
  else if (type === 'scheduledWake') validateScheduledWake(tx['data'], `${code}_DATA`);
  else if (type === 'htlcPayment') validatePreparedHtlcPayment(tx['data'], `${code}_DATA`);
  else if (type === 'accountInput') decodeAccountPeerInput(tx['data'], `${code}_DATA`);
  else if (type === 'materializeCrossJurisdictionClear') validateCrossJClearMaterialization(tx['data'], `${code}_DATA`);
  else if (type === 'materializeCrossJurisdictionSwap') validateCrossJMaterialization(tx['data'], `${code}_DATA`);
  else if (type === 'chat' || type === 'vote') validateSimpleIdentityTx(type, tx['data'], `${code}_DATA`);
  else if (isSimpleEntityTxType(type)) {
    validateSimpleEntityTxData(type, tx['data'], `${code}_DATA`);
    validateCrossJurisdictionRouteEntityTx(type, tx['data'], `${code}_DATA`);
  }
  else {
    const unhandledType: never = type;
    throw new Error(`${code}_TYPE_UNHANDLED:${String(unhandledType)}`);
  }
}

const validateEntityTxRecord = (value: unknown, code: string, depth: number): EntityTx => {
  assertEntityTxRecord(value, code, depth);
  return value;
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
