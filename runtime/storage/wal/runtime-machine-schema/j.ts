import type { JInput } from '../../../jurisdiction/machine/input';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import type { JTx } from '../../../types/jurisdiction-runtime';
import {
  toEntityId,
  toJId,
  type EntityId,
  type JId,
} from '../../../protocol/identity';
import {
  toJHeight,
  toUnixMs,
  type JHeight,
  type UnixMs,
} from '../../../protocol/units';
import { validateJBatch } from '../../../jurisdiction/machine/batch-validation';
import {
  requireArray,
  requireBigInt,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireBytes,
  requireExactBoundaryKeys,
  requireFiniteNumber,
  requireString,
  requireStringArray,
} from '../../../protocol/boundary/boundary-primitives';

const validateAttempt = (value: unknown, code: string): void => {
  const attempt = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    attempt,
    ['attemptId', 'attemptNumber', 'attemptedAt', 'batchGeneration'],
    [],
    `${code}_FIELDS`,
  );
  requireString(attempt['attemptId'], `${code}_ID`);
  requireBoundaryInteger(attempt['attemptNumber'], `${code}_NUMBER`, 1);
  requireBoundaryInteger(attempt['attemptedAt'], `${code}_AT`);
  requireBoundaryInteger(attempt['batchGeneration'], `${code}_GENERATION`);
};

const validateFeeOverrides = (value: unknown, code: string): void => {
  const fees = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    fees,
    [],
    ['gasBumpBps', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei'],
    `${code}_FIELDS`,
  );
  if (fees['gasBumpBps'] !== undefined) requireBoundaryInteger(fees['gasBumpBps'], `${code}_BUMP`);
  if (fees['maxFeePerGasWei'] !== undefined) requireString(fees['maxFeePerGasWei'], `${code}_MAX_FEE`);
  if (fees['maxPriorityFeePerGasWei'] !== undefined) requireString(fees['maxPriorityFeePerGasWei'], `${code}_PRIORITY`);
};

const validateEntityProviderPayload = (value: unknown, code: string): void => {
  const payload = requireBoundaryRecord(value, code);
  if (payload['kind'] === 'entityTransferTokens') {
    requireExactBoundaryKeys(payload, ['kind', 'transfer'], [], `${code}_FIELDS`);
    const transfer = requireBoundaryRecord(payload['transfer'], `${code}_TRANSFER`);
    requireExactBoundaryKeys(transfer, ['to', 'tokenId', 'amount'], [], `${code}_TRANSFER_FIELDS`);
    requireString(transfer['to'], `${code}_TRANSFER_TO`);
    requireBigInt(transfer['tokenId'], `${code}_TRANSFER_TOKEN`, 0n);
    requireBigInt(transfer['amount'], `${code}_TRANSFER_AMOUNT`, 0n);
  } else if (payload['kind'] === 'releaseControlShares') {
    requireExactBoundaryKeys(payload, ['kind', 'release'], [], `${code}_FIELDS`);
    const release = requireBoundaryRecord(payload['release'], `${code}_RELEASE`);
    requireExactBoundaryKeys(
      release,
      ['recipientAddress', 'controlAmount', 'dividendAmount', 'purpose'],
      [],
      `${code}_RELEASE_FIELDS`,
    );
    requireBigInt(release['controlAmount'], `${code}_RELEASE_CONTROL`, 0n);
    requireBigInt(release['dividendAmount'], `${code}_RELEASE_DIVIDEND`, 0n);
    requireString(release['purpose'], `${code}_RELEASE_PURPOSE`);
    requireString(release['recipientAddress'], `${code}_RELEASE_RECIPIENT`);
  } else if (payload['kind'] === 'cancelPendingAction') {
    requireExactBoundaryKeys(payload, ['kind', 'cancel'], [], `${code}_FIELDS`);
    const cancel = requireBoundaryRecord(payload['cancel'], `${code}_CANCEL`);
    requireExactBoundaryKeys(cancel, ['cancelledActionHash', 'cancelledActionKind'], [], `${code}_CANCEL_FIELDS`);
    requireString(cancel['cancelledActionHash'], `${code}_CANCEL_HASH`);
    if (cancel['cancelledActionKind'] !== 0 && cancel['cancelledActionKind'] !== 1) throw new Error(`${code}_CANCEL_KIND`);
  } else throw new Error(`${code}_KIND`);
};

const validateEntityProviderData = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, ['intent', 'signerId'], ['hankoSignature', 'runtimeSubmitAttempt'], `${code}_FIELDS`);
  const intent = requireBoundaryRecord(data['intent'], `${code}_INTENT`);
  requireExactBoundaryKeys(intent, [
    'version', 'entityId', 'entityNumber', 'chainId', 'entityProviderAddress',
    'boardEpoch', 'actionNonce', 'actionHash', 'generation', 'createdAt', 'payload',
  ], [], `${code}_INTENT_FIELDS`);
  if (intent['version'] !== 1) throw new Error(`${code}_INTENT_VERSION`);
  requireString(intent['entityId'], `${code}_INTENT_ENTITY`);
  for (const key of ['entityNumber', 'chainId', 'boardEpoch', 'actionNonce']) {
    requireBigInt(intent[key], `${code}_INTENT_${key.toUpperCase()}`, 0n);
  }
  requireString(intent['entityProviderAddress'], `${code}_INTENT_PROVIDER`);
  requireString(intent['actionHash'], `${code}_INTENT_HASH`);
  requireBoundaryInteger(intent['generation'], `${code}_INTENT_GENERATION`);
  requireBoundaryInteger(intent['createdAt'], `${code}_INTENT_CREATED`);
  validateEntityProviderPayload(intent['payload'], `${code}_INTENT_PAYLOAD`);
  requireString(data['signerId'], `${code}_SIGNER`);
  if (data['hankoSignature'] !== undefined) requireString(data['hankoSignature'], `${code}_HANKO`);
  if (data['runtimeSubmitAttempt'] !== undefined) {
    const attempt = requireBoundaryRecord(data['runtimeSubmitAttempt'], `${code}_ATTEMPT`);
    requireExactBoundaryKeys(attempt, ['attemptId', 'attemptNumber', 'attemptedAt', 'generation'], [], `${code}_ATTEMPT_FIELDS`);
    requireString(attempt['attemptId'], `${code}_ATTEMPT_ID`);
    requireBoundaryInteger(attempt['attemptNumber'], `${code}_ATTEMPT_NUMBER`, 1);
    requireBoundaryInteger(attempt['attemptedAt'], `${code}_ATTEMPT_AT`);
    requireBoundaryInteger(attempt['generation'], `${code}_ATTEMPT_GENERATION`);
  }
};

export type DecodedJTx = JTx & Readonly<{
  entityId: EntityId;
  timestamp: UnixMs;
  expectedJBlock?: JHeight;
}>;

export type DecodedJInput = Omit<JInput, 'jurisdictionName' | 'jTxs'> & Readonly<{
  jurisdictionName: JId;
  jTxs: DecodedJTx[];
}>;

export type DecodedJReplica = JReplica & Readonly<{
  name: JId;
  lastBlockTimestamp: UnixMs;
}>;

function assertJTx(value: unknown, code: string): asserts value is DecodedJTx {
  const tx = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(tx, ['type', 'entityId', 'data', 'timestamp'], ['expectedJBlock'], `${code}_FIELDS`);
  toEntityId(requireString(tx['entityId'], `${code}_ENTITY`));
  toUnixMs(requireBoundaryInteger(tx['timestamp'], `${code}_TIMESTAMP`));
  if (tx['expectedJBlock'] !== undefined) {
    toJHeight(requireBoundaryInteger(tx['expectedJBlock'], `${code}_EXPECTED_BLOCK`));
  }
  const data = requireBoundaryRecord(tx['data'], `${code}_DATA`);
  if (tx['type'] === 'batch') {
    requireExactBoundaryKeys(data, ['batch', 'batchSize'], [
      'hankoSignature', 'batchHash', 'encodedBatch', 'entityNonce', 'batchGeneration',
      'feeOverrides', 'signerId', 'runtimeSubmitAttempt',
    ], `${code}_DATA_FIELDS`);
    validateJBatch(data['batch'], `${code}_DATA_BATCH`);
    requireBoundaryInteger(data['batchSize'], `${code}_DATA_SIZE`);
    for (const key of ['hankoSignature', 'batchHash', 'encodedBatch', 'signerId']) {
      if (data[key] !== undefined) requireString(data[key], `${code}_DATA_${key.toUpperCase()}`);
    }
    for (const key of ['entityNonce', 'batchGeneration']) {
      if (data[key] !== undefined) requireBoundaryInteger(data[key], `${code}_DATA_${key.toUpperCase()}`);
    }
    if (data['feeOverrides'] !== undefined) validateFeeOverrides(data['feeOverrides'], `${code}_DATA_FEES`);
    if (data['runtimeSubmitAttempt'] !== undefined) validateAttempt(data['runtimeSubmitAttempt'], `${code}_DATA_ATTEMPT`);
  } else if (tx['type'] === 'mint') {
    requireExactBoundaryKeys(data, ['entityId', 'tokenId', 'amount'], [], `${code}_DATA_FIELDS`);
    requireString(data['entityId'], `${code}_DATA_ENTITY`);
    requireBoundaryInteger(data['tokenId'], `${code}_DATA_TOKEN`);
    requireBigInt(data['amount'], `${code}_DATA_AMOUNT`);
  } else if (tx['type'] === 'debtEnforcement') {
    requireExactBoundaryKeys(data, ['tokenId', 'maxIterations'], ['signerId'], `${code}_DATA_FIELDS`);
    requireBoundaryInteger(data['tokenId'], `${code}_DATA_TOKEN`);
    requireBigInt(data['maxIterations'], `${code}_DATA_MAX_ITERATIONS`, 0n);
    if (data['signerId'] !== undefined) requireString(data['signerId'], `${code}_DATA_SIGNER`);
  } else if (
    tx['type'] === 'entityProviderTransfer' ||
    tx['type'] === 'entityProviderReleaseControlShares' ||
    tx['type'] === 'entityProviderCancelAction'
  ) validateEntityProviderData(data, `${code}_DATA`);
  else throw new Error(`${code}_TYPE`);
}

const validateJTx = (value: unknown, code: string): DecodedJTx => {
  assertJTx(value, code);
  return value;
};

export const validateJInputs = (value: unknown, code: string): DecodedJInput[] =>
  requireArray(value, code).map((raw, index) => {
    const itemCode = `${code}_${index}`;
    const input = requireBoundaryRecord(raw, itemCode);
    requireExactBoundaryKeys(input, ['jurisdictionName', 'jTxs'], [], `${itemCode}_FIELDS`);
    const jTxs = requireArray(input['jTxs'], `${itemCode}_TXS`).map((tx, txIndex) =>
      validateJTx(tx, `${itemCode}_TX_${txIndex}`));
    return {
      jurisdictionName: toJId(requireString(input['jurisdictionName'], `${itemCode}_JURISDICTION`)),
      jTxs,
    };
  });

function assertJReplica(
  value: unknown,
  expectedName: string,
  code: string,
): asserts value is DecodedJReplica {
  const replica = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(replica, [
    'name', 'blockNumber', 'stateRoot', 'mempool', 'blockDelayMs',
    'lastBlockTimestamp', 'position',
  ], [
    'blockTimeMs', 'blockReady', 'watcherConfirmationDepth',
    'rpcs', 'chainId', 'entityProviderDeploymentBlock', 'contracts',
  ], `${code}_FIELDS`);
  const name = requireString(replica['name'], `${code}_NAME`);
  if (name !== expectedName) throw new Error(`${code}_NAME_KEY_MISMATCH`);
  toJId(name);
  requireBigInt(replica['blockNumber'], `${code}_BLOCK_NUMBER`, 0n);
  if (replica['stateRoot'] !== null) requireBytes(replica['stateRoot'], `${code}_STATE_ROOT`, 32);
  requireArray(replica['mempool'], `${code}_MEMPOOL`).forEach((tx, index) =>
    validateJTx(tx, `${code}_MEMPOOL_${index}`));
  requireFiniteNumber(replica['blockDelayMs'], `${code}_BLOCK_DELAY`, 0);
  toUnixMs(requireBoundaryInteger(replica['lastBlockTimestamp'], `${code}_LAST_TIMESTAMP`));
  const position = requireBoundaryRecord(replica['position'], `${code}_POSITION`);
  requireExactBoundaryKeys(position, ['x', 'y', 'z'], [], `${code}_POSITION_FIELDS`);
  for (const axis of ['x', 'y', 'z']) {
    requireFiniteNumber(position[axis], `${code}_POSITION_${axis.toUpperCase()}`);
  }
  if (replica['blockTimeMs'] !== undefined) {
    requireFiniteNumber(replica['blockTimeMs'], `${code}_BLOCK_TIME`, 0);
  }
  if (replica['blockReady'] !== undefined) {
    requireBoolean(replica['blockReady'], `${code}_READY`);
  }
  for (const field of [
    'watcherConfirmationDepth',
    'chainId',
    'entityProviderDeploymentBlock',
  ] as const) {
    if (replica[field] !== undefined) {
      requireBoundaryInteger(replica[field], `${code}_${field.toUpperCase()}`);
    }
  }
  if (replica['rpcs'] !== undefined) requireStringArray(replica['rpcs'], `${code}_RPCS`);
  if (replica['contracts'] !== undefined) {
    const contracts = requireBoundaryRecord(replica['contracts'], `${code}_CONTRACTS`);
    requireExactBoundaryKeys(
      contracts,
      [],
      ['depository', 'entityProvider', 'account', 'deltaTransformer'],
      `${code}_CONTRACTS_FIELDS`,
    );
    for (const [contract, address] of Object.entries(contracts)) {
      requireString(address, `${code}_CONTRACT_${contract}`);
    }
  }
}

export const validateJReplicas = (value: unknown, code: string): Array<[JId, DecodedJReplica]> =>
  requireArray(value, code).map((raw, index) => {
    const itemCode = `${code}_${index}`;
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`${itemCode}_TUPLE`);
    const key = toJId(requireString(raw[0], `${itemCode}_KEY`));
    assertJReplica(raw[1], key, `${itemCode}_VALUE`);
    return [key, raw[1]];
  });
