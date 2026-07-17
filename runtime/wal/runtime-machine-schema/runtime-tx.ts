import { normalizeJurisdictionImportRequest } from '../../machine/jurisdiction-import';
import { validateRuntimeAdapterCommandMarker } from '../../radapter/command-frontier';
import type { JurisdictionImportRequest, RuntimeTx } from '../../types';
import { validateBrowserVmState } from './browser';
import { validateJObservationData } from './j-observation';
import {
  requireArray,
  requireBigInt,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
  requireStringArray,
  validateStorageSafeValue,
} from './primitives';
import {
  validateConsensusConfig,
  validateEntityPosition,
  validateJurisdictionImportRequest,
  validateNumberedRecord,
  validateRegistrationEvidence,
} from './registrations';

const SUBMIT_OUTCOMES = new Set(['submitted', 'transientFailure', 'terminalFailure', 'reconciled']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const requireAddress = (value: unknown, code: string): string => {
  const address = requireString(value, code);
  if (!ADDRESS.test(address)) throw new Error(code);
  return address;
};

const requireBytes32 = (value: unknown, code: string): string => {
  const hash = requireString(value, code);
  if (!BYTES32.test(hash)) throw new Error(code);
  return hash;
};

const validateAdapterFailure = (value: unknown, code: string): void => {
  const failure = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(failure, ['category', 'code', 'message'], [], `${code}_FIELDS`);
  if (failure['category'] !== 'transient' && failure['category'] !== 'terminal') {
    throw new Error(`${code}_CATEGORY`);
  }
  requireString(failure['code'], `${code}_CODE`);
  requireString(failure['message'], `${code}_MESSAGE`);
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
  if (fees['maxPriorityFeePerGasWei'] !== undefined) {
    requireString(fees['maxPriorityFeePerGasWei'], `${code}_PRIORITY_FEE`);
  }
};

const validateNumberedResolution = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  if (data['kind'] === 'completed') {
    requireExactBoundaryKeys(
      data,
      ['kind', 'intentId', 'requestHash', 'transactionHash', 'results'],
      [],
      `${code}_FIELDS`,
    );
    for (const field of ['intentId', 'requestHash', 'transactionHash']) {
      requireString(data[field], `${code}_${field.toUpperCase()}`);
    }
    requireArray(data['results'], `${code}_RESULTS`).forEach((raw, index) => {
      const result = requireBoundaryRecord(raw, `${code}_RESULT_${index}`);
      requireExactBoundaryKeys(
        result,
        ['entityNumber', 'entityId', 'registrationBlock', 'evidenceHash'],
        [],
        `${code}_RESULT_${index}_FIELDS`,
      );
      requireBoundaryInteger(result['entityNumber'], `${code}_RESULT_${index}_NUMBER`, 1);
      requireString(result['entityId'], `${code}_RESULT_${index}_ENTITY`);
      requireBoundaryInteger(result['registrationBlock'], `${code}_RESULT_${index}_BLOCK`, 1);
      requireString(result['evidenceHash'], `${code}_RESULT_${index}_EVIDENCE`);
    });
    return;
  }
  if (data['kind'] === 'quarantined') {
    requireExactBoundaryKeys(
      data,
      ['kind', 'intentId', 'requestHash', 'transactionHash', 'reason'],
      [],
      `${code}_FIELDS`,
    );
    for (const field of ['intentId', 'requestHash', 'transactionHash', 'reason']) {
      requireString(data[field], `${code}_${field.toUpperCase()}`);
    }
    return;
  }
  throw new Error(`${code}_KIND`);
};

const validateImportReplica = (tx: Record<string, unknown>, code: string): void => {
  requireExactBoundaryKeys(tx, ['type', 'entityId', 'signerId', 'data'], [], `${code}_FIELDS`);
  requireString(tx['entityId'], `${code}_ENTITY`);
  requireString(tx['signerId'], `${code}_SIGNER`);
  const data = requireBoundaryRecord(tx['data'], `${code}_DATA`);
  requireExactBoundaryKeys(data, ['config', 'isProposer'], ['profileName', 'position'], `${code}_DATA_FIELDS`);
  validateConsensusConfig(data['config'], `${code}_DATA_CONFIG`);
  requireBoolean(data['isProposer'], `${code}_DATA_PROPOSER`);
  if (data['profileName'] !== undefined) requireString(data['profileName'], `${code}_DATA_PROFILE`);
  if (data['position'] !== undefined) validateEntityPosition(data['position'], `${code}_DATA_POSITION`);
};

const validateJSubmitIdentity = (data: Record<string, unknown>, code: string): void => {
  for (const field of ['entityId', 'signerId', 'jurisdictionName']) {
    requireString(data[field], `${code}_${field.toUpperCase()}`);
  }
  requireBytes32(data['batchHash'], `${code}_BATCH_HASH`);
  requireBoundaryInteger(data['entityNonce'], `${code}_ENTITY_NONCE`);
  requireBoundaryInteger(data['batchGeneration'], `${code}_BATCH_GENERATION`);
};

const validateJSubmit = (value: unknown, code: string, result: boolean): void => {
  const data = requireBoundaryRecord(value, code);
  const resultFields = ['attemptId', 'attemptNumber', 'attemptedAt', 'outcome'] as const;
  requireExactBoundaryKeys(
    data,
    ['entityId', 'signerId', 'jurisdictionName', 'batchHash', 'entityNonce', 'batchGeneration', ...(result ? resultFields : [])],
    result ? ['message', 'adapterFailure', 'txHash'] : ['feeOverrides'],
    `${code}_FIELDS`,
  );
  validateJSubmitIdentity(data, code);
  if (!result) {
    if (data['feeOverrides'] !== undefined) validateFeeOverrides(data['feeOverrides'], `${code}_FEES`);
    return;
  }
  requireString(data['attemptId'], `${code}_ATTEMPT_ID`);
  requireBoundaryInteger(data['attemptNumber'], `${code}_ATTEMPT_NUMBER`, 1);
  requireBoundaryInteger(data['attemptedAt'], `${code}_ATTEMPTED_AT`);
  if (!SUBMIT_OUTCOMES.has(String(data['outcome']))) throw new Error(`${code}_OUTCOME`);
  if (data['message'] !== undefined) requireString(data['message'], `${code}_MESSAGE`);
  if (data['adapterFailure'] !== undefined) validateAdapterFailure(data['adapterFailure'], `${code}_ADAPTER_FAILURE`);
  if (data['txHash'] !== undefined) requireString(data['txHash'], `${code}_TX_HASH`);
};

const validateEntityProviderSubmit = (value: unknown, code: string, result: boolean): void => {
  const data = requireBoundaryRecord(value, code);
  const resultFields = ['attemptId', 'attemptNumber', 'attemptedAt', 'outcome'] as const;
  requireExactBoundaryKeys(
    data,
    ['entityId', 'signerId', 'jurisdictionName', 'actionHash', 'actionNonce', 'generation', ...(result ? resultFields : [])],
    result ? ['message', 'adapterFailure', 'txHash'] : [],
    `${code}_FIELDS`,
  );
  for (const field of ['entityId', 'signerId', 'jurisdictionName']) {
    requireString(data[field], `${code}_${field.toUpperCase()}`);
  }
  requireBytes32(data['actionHash'], `${code}_ACTION_HASH`);
  requireBigInt(data['actionNonce'], `${code}_ACTION_NONCE`, 0n);
  requireBoundaryInteger(data['generation'], `${code}_GENERATION`);
  if (!result) return;
  requireString(data['attemptId'], `${code}_ATTEMPT_ID`);
  requireBoundaryInteger(data['attemptNumber'], `${code}_ATTEMPT_NUMBER`, 1);
  requireBoundaryInteger(data['attemptedAt'], `${code}_ATTEMPTED_AT`);
  if (!SUBMIT_OUTCOMES.has(String(data['outcome']))) throw new Error(`${code}_OUTCOME`);
  if (data['message'] !== undefined) requireString(data['message'], `${code}_MESSAGE`);
  if (data['adapterFailure'] !== undefined) validateAdapterFailure(data['adapterFailure'], `${code}_ADAPTER_FAILURE`);
  if (data['txHash'] !== undefined) requireString(data['txHash'], `${code}_TX_HASH`);
};

const validateCompleteImport = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, [
    'importId', 'requestHash', 'name', 'chainId', 'ticker', 'rpcs', 'blockNumber', 'stateRoot',
    'defaultDisputeDelayBlocks', 'watcherConfirmationDepth', 'entityProviderDeploymentBlock', 'contracts',
  ], ['blockTimeMs', 'browserVMState'], `${code}_FIELDS`);
  for (const field of ['importId', 'requestHash', 'name', 'ticker', 'blockNumber']) {
    requireString(data[field], `${code}_${field.toUpperCase()}`);
  }
  requireBoundaryInteger(data['chainId'], `${code}_CHAIN_ID`, 1);
  requireStringArray(data['rpcs'], `${code}_RPCS`);
  if (!/^(0|[1-9][0-9]*)$/.test(String(data['blockNumber']))) throw new Error(`${code}_BLOCK_NUMBER`);
  if (data['stateRoot'] !== null) requireBytes32(data['stateRoot'], `${code}_STATE_ROOT`);
  requireBoundaryInteger(data['defaultDisputeDelayBlocks'], `${code}_DISPUTE_DELAY`);
  requireBoundaryInteger(data['watcherConfirmationDepth'], `${code}_CONFIRMATION_DEPTH`);
  requireBoundaryInteger(data['entityProviderDeploymentBlock'], `${code}_DEPLOYMENT_BLOCK`, 1);
  if (data['blockTimeMs'] !== undefined) requireBoundaryInteger(data['blockTimeMs'], `${code}_BLOCK_TIME`, 1);
  const contracts = requireBoundaryRecord(data['contracts'], `${code}_CONTRACTS`);
  requireExactBoundaryKeys(
    contracts,
    ['depository', 'entityProvider', 'account', 'deltaTransformer'],
    [],
    `${code}_CONTRACTS_FIELDS`,
  );
  for (const [name, address] of Object.entries(contracts)) requireAddress(address, `${code}_CONTRACT_${name}`);
  if (data['browserVMState'] !== undefined) validateBrowserVmState(data['browserVMState'], `${code}_BROWSER_VM`);
  if ((data['stateRoot'] === null) === (data['browserVMState'] !== undefined)) {
    throw new Error(`${code}_STATE_MODE`);
  }
};

const validateRuntimeTxData = (type: string, value: unknown, code: string): void => {
  if (type === 'recordRuntimeAdapterCommand') {
    const data = requireBoundaryRecord(value, code);
    requireExactBoundaryKeys(data, ['laneId', 'sequence', 'commandId', 'inputHash', 'expiresAtMs'], [], `${code}_FIELDS`);
    validateRuntimeAdapterCommandMarker(data as never);
  } else if (type === 'recordNumberedRegistrationIntent') {
    const data = requireBoundaryRecord(value, code);
    if (data['status'] !== 'pending') throw new Error(`${code}_STATUS`);
    validateNumberedRecord(data, code);
  } else if (type === 'resolveNumberedRegistrationIntent') validateNumberedResolution(value, code);
  else if (type === 'recordAuthenticatedJAuthority') validateRegistrationEvidence(value, code);
  else if (type === 'observeJRange') validateJObservationData(value, code);
  else if (type === 'advanceJWatcherCursor') {
    const data = requireBoundaryRecord(value, code);
    requireExactBoundaryKeys(data, ['depositoryAddress', 'blockNumber'], ['chainId'], `${code}_FIELDS`);
    requireAddress(data['depositoryAddress'], `${code}_DEPOSITORY`);
    requireBoundaryInteger(data['blockNumber'], `${code}_BLOCK_NUMBER`);
    if (data['chainId'] !== undefined) requireBoundaryInteger(data['chainId'], `${code}_CHAIN_ID`, 1);
  } else if (type === 'rewindJHistory') {
    const data = requireBoundaryRecord(value, code);
    requireExactBoundaryKeys(data, [
      'entityId', 'signerId', 'jurisdictionRef', 'conflictingHeight', 'conflictingBlockHash',
    ], [], `${code}_FIELDS`);
    for (const field of ['entityId', 'signerId', 'jurisdictionRef', 'conflictingBlockHash']) {
      requireString(data[field], `${code}_${field.toUpperCase()}`);
    }
    requireBoundaryInteger(data['conflictingHeight'], `${code}_HEIGHT`, 1);
  } else if (type === 'retryJSubmit') validateJSubmit(value, code, false);
  else if (type === 'recordJSubmitResult') validateJSubmit(value, code, true);
  else if (type === 'retryEntityProviderAction') validateEntityProviderSubmit(value, code, false);
  else if (type === 'recordEntityProviderActionSubmitResult') validateEntityProviderSubmit(value, code, true);
  else if (type === 'importJ') {
    validateJurisdictionImportRequest(value, code);
    normalizeJurisdictionImportRequest(value as JurisdictionImportRequest);
  } else if (type === 'completeImportJ') validateCompleteImport(value, code);
  else throw new Error(`${code}_TYPE_UNKNOWN:${type}`);
};

export const validateRuntimeTx = (value: unknown, code: string): RuntimeTx => {
  validateStorageSafeValue(value, code);
  const tx = requireBoundaryRecord(value, code);
  const type = requireString(tx['type'], `${code}_TYPE`);
  if (type === 'importReplica') validateImportReplica(tx, code);
  else {
    requireExactBoundaryKeys(tx, ['type', 'data'], [], `${code}_FIELDS`);
    validateRuntimeTxData(type, tx['data'], `${code}_DATA`);
  }
  return tx as unknown as RuntimeTx;
};
