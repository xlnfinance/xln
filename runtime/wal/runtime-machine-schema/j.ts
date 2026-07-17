import type { JInput, JReplica } from '../../types';
import type { JTx } from '../../types/jurisdiction-runtime';
import { validateJBatch } from './j-batch';
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
} from './primitives';

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
      ['controlAmount', 'dividendAmount', 'purpose', 'depositoryAddress'],
      [],
      `${code}_RELEASE_FIELDS`,
    );
    requireBigInt(release['controlAmount'], `${code}_RELEASE_CONTROL`, 0n);
    requireBigInt(release['dividendAmount'], `${code}_RELEASE_DIVIDEND`, 0n);
    requireString(release['purpose'], `${code}_RELEASE_PURPOSE`);
    requireString(release['depositoryAddress'], `${code}_RELEASE_DEPOSITORY`);
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

export const validateJTx = (value: unknown, code: string): JTx => {
  const tx = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(tx, ['type', 'entityId', 'data', 'timestamp'], ['expectedJBlock'], `${code}_FIELDS`);
  requireString(tx['entityId'], `${code}_ENTITY`);
  requireBoundaryInteger(tx['timestamp'], `${code}_TIMESTAMP`);
  if (tx['expectedJBlock'] !== undefined) requireBoundaryInteger(tx['expectedJBlock'], `${code}_EXPECTED_BLOCK`);
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
  return tx as unknown as JTx;
};

export const validateJInputs = (value: unknown, code: string): JInput[] =>
  requireArray(value, code).map((raw, index) => {
    const itemCode = `${code}_${index}`;
    const input = requireBoundaryRecord(raw, itemCode);
    requireExactBoundaryKeys(input, ['jurisdictionName', 'jTxs'], [], `${itemCode}_FIELDS`);
    requireString(input['jurisdictionName'], `${itemCode}_JURISDICTION`);
    requireArray(input['jTxs'], `${itemCode}_TXS`).forEach((tx, txIndex) =>
      validateJTx(tx, `${itemCode}_TX_${txIndex}`));
    return input as unknown as JInput;
  });

export const validateJReplicas = (value: unknown, code: string): Array<[string, JReplica]> =>
  requireArray(value, code).map((raw, index) => {
    const itemCode = `${code}_${index}`;
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`${itemCode}_TUPLE`);
    const key = requireString(raw[0], `${itemCode}_KEY`);
    const replica = requireBoundaryRecord(raw[1], `${itemCode}_VALUE`);
    requireExactBoundaryKeys(replica, [
      'name', 'blockNumber', 'stateRoot', 'mempool', 'blockDelayMs',
      'lastBlockTimestamp', 'position',
    ], [
      'blockTimeMs', 'blockReady', 'defaultDisputeDelayBlocks', 'watcherConfirmationDepth',
      'rpcs', 'chainId', 'depositoryAddress', 'entityProviderAddress',
      'entityProviderDeploymentBlock', 'contracts',
    ], `${itemCode}_FIELDS`);
    const name = requireString(replica['name'], `${itemCode}_NAME`);
    if (name !== key) throw new Error(`${itemCode}_NAME_KEY_MISMATCH`);
    requireBigInt(replica['blockNumber'], `${itemCode}_BLOCK_NUMBER`, 0n);
    if (replica['stateRoot'] !== null) requireBytes(replica['stateRoot'], `${itemCode}_STATE_ROOT`, 32);
    requireArray(replica['mempool'], `${itemCode}_MEMPOOL`).forEach((tx, txIndex) =>
      validateJTx(tx, `${itemCode}_MEMPOOL_${txIndex}`));
    requireFiniteNumber(replica['blockDelayMs'], `${itemCode}_BLOCK_DELAY`, 0);
    requireFiniteNumber(replica['lastBlockTimestamp'], `${itemCode}_LAST_TIMESTAMP`, 0);
    if (replica['blockTimeMs'] !== undefined) requireFiniteNumber(replica['blockTimeMs'], `${itemCode}_BLOCK_TIME`, 0);
    if (replica['blockReady'] !== undefined) requireBoolean(replica['blockReady'], `${itemCode}_READY`);
    for (const field of ['defaultDisputeDelayBlocks', 'watcherConfirmationDepth', 'chainId', 'entityProviderDeploymentBlock']) {
      if (replica[field] !== undefined) requireBoundaryInteger(replica[field], `${itemCode}_${field.toUpperCase()}`);
    }
    if (replica['rpcs'] !== undefined) requireStringArray(replica['rpcs'], `${itemCode}_RPCS`);
    for (const field of ['depositoryAddress', 'entityProviderAddress']) {
      if (replica[field] !== undefined) requireString(replica[field], `${itemCode}_${field.toUpperCase()}`);
    }
    const position = requireBoundaryRecord(replica['position'], `${itemCode}_POSITION`);
    requireExactBoundaryKeys(position, ['x', 'y', 'z'], [], `${itemCode}_POSITION_FIELDS`);
    for (const axis of ['x', 'y', 'z']) requireFiniteNumber(position[axis], `${itemCode}_POSITION_${axis.toUpperCase()}`);
    if (replica['contracts'] !== undefined) {
      const contracts = requireBoundaryRecord(replica['contracts'], `${itemCode}_CONTRACTS`);
      requireExactBoundaryKeys(contracts, [], ['depository', 'entityProvider', 'account', 'deltaTransformer'], `${itemCode}_CONTRACTS_FIELDS`);
      for (const [contract, address] of Object.entries(contracts)) requireString(address, `${itemCode}_CONTRACT_${contract}`);
    }
    return [key, replica as unknown as JReplica];
  });
