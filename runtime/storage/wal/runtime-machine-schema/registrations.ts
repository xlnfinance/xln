import {
  requireArray,
  requireBigInt,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireFiniteNumber,
  requireString,
  requireStringArray,
} from './primitives';

const validateJurisdictionConfig = (value: unknown, code: string): void => {
  const jurisdiction = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(jurisdiction, ['address', 'name', 'entityProviderAddress', 'depositoryAddress'], [
    'chainId', 'blockTimeMs', 'registrationBlock', 'entityProviderDeploymentBlock', 'rebalancePolicyUsd',
  ], `${code}_FIELDS`);
  for (const field of ['address', 'name', 'entityProviderAddress', 'depositoryAddress']) {
    requireString(jurisdiction[field], `${code}_${field.toUpperCase()}`);
  }
  for (const field of ['chainId', 'blockTimeMs', 'registrationBlock', 'entityProviderDeploymentBlock']) {
    if (jurisdiction[field] !== undefined) requireBoundaryInteger(jurisdiction[field], `${code}_${field.toUpperCase()}`);
  }
  if (jurisdiction['rebalancePolicyUsd'] !== undefined) {
    const policy = requireBoundaryRecord(jurisdiction['rebalancePolicyUsd'], `${code}_REBALANCE`);
    requireExactBoundaryKeys(policy, ['r2cRequestSoftLimit', 'hardLimit', 'maxFee'], [], `${code}_REBALANCE_FIELDS`);
    for (const field of ['r2cRequestSoftLimit', 'hardLimit', 'maxFee']) {
      if (typeof policy[field] !== 'number' || !Number.isFinite(policy[field])) throw new Error(`${code}_REBALANCE_${field}`);
    }
  }
};

export const validateConsensusConfig = (value: unknown, code: string): void => {
  const config = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(config, ['mode', 'threshold', 'validators', 'shares'], ['jurisdiction'], `${code}_FIELDS`);
  if (config['mode'] !== 'proposer-based' && config['mode'] !== 'gossip-based') throw new Error(`${code}_MODE`);
  requireBigInt(config['threshold'], `${code}_THRESHOLD`, 1n);
  requireStringArray(config['validators'], `${code}_VALIDATORS`);
  const shares = requireBoundaryRecord(config['shares'], `${code}_SHARES`);
  for (const [validator, share] of Object.entries(shares)) {
    requireString(validator, `${code}_SHARE_VALIDATOR`);
    requireBigInt(share, `${code}_SHARE_${validator}`, 1n);
  }
  if (config['jurisdiction'] !== undefined) validateJurisdictionConfig(config['jurisdiction'], `${code}_JURISDICTION`);
};

export const validateEntityPosition = (value: unknown, code: string): void => {
  const position = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(position, ['x', 'y', 'z'], ['jurisdiction', 'xlnomy'], `${code}_FIELDS`);
  for (const axis of ['x', 'y', 'z']) requireFiniteNumber(position[axis], `${code}_${axis.toUpperCase()}`);
  for (const field of ['jurisdiction', 'xlnomy']) {
    if (position[field] !== undefined) requireString(position[field], `${code}_${field.toUpperCase()}`);
  }
};

export const validateJurisdictionImportRequest = (value: unknown, code: string): void => {
  const request = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(request, ['name', 'chainId', 'ticker', 'rpcs'], [
    'entityProviderDeploymentBlock', 'blockTimeMs', 'startAtCurrentBlock', 'rpcPolicy', 'contracts', 'tokens',
  ], `${code}_FIELDS`);
  requireString(request['name'], `${code}_NAME`);
  requireBoundaryInteger(request['chainId'], `${code}_CHAIN_ID`);
  requireString(request['ticker'], `${code}_TICKER`);
  requireStringArray(request['rpcs'], `${code}_RPCS`);
  for (const field of ['entityProviderDeploymentBlock', 'blockTimeMs']) {
    if (request[field] !== undefined) requireBoundaryInteger(request[field], `${code}_${field.toUpperCase()}`);
  }
  if (request['startAtCurrentBlock'] !== undefined) requireBoolean(request['startAtCurrentBlock'], `${code}_START_CURRENT`);
  if (request['rpcPolicy'] !== undefined && request['rpcPolicy'] !== 'single' && request['rpcPolicy'] !== 'failover') {
    const policy = requireBoundaryRecord(request['rpcPolicy'], `${code}_RPC_POLICY`);
    requireExactBoundaryKeys(policy, ['mode', 'min'], [], `${code}_RPC_POLICY_FIELDS`);
    if (policy['mode'] !== 'quorum') throw new Error(`${code}_RPC_POLICY_MODE`);
    requireBoundaryInteger(policy['min'], `${code}_RPC_POLICY_MIN`, 1);
  }
  if (request['contracts'] !== undefined) {
    const contracts = requireBoundaryRecord(request['contracts'], `${code}_CONTRACTS`);
    requireExactBoundaryKeys(contracts, [], ['depository', 'entityProvider', 'account', 'deltaTransformer'], `${code}_CONTRACTS_FIELDS`);
    for (const [key, address] of Object.entries(contracts)) requireString(address, `${code}_CONTRACT_${key}`);
  }
  if (request['tokens'] !== undefined) {
    for (const [index, raw] of requireArray(request['tokens'], `${code}_TOKENS`).entries()) {
      const token = requireBoundaryRecord(raw, `${code}_TOKEN_${index}`);
      requireExactBoundaryKeys(token, ['symbol', 'decimals'], ['initialSupply'], `${code}_TOKEN_${index}_FIELDS`);
      requireString(token['symbol'], `${code}_TOKEN_${index}_SYMBOL`);
      requireBoundaryInteger(token['decimals'], `${code}_TOKEN_${index}_DECIMALS`);
      if (token['initialSupply'] !== undefined) requireBigInt(token['initialSupply'], `${code}_TOKEN_${index}_SUPPLY`, 0n);
    }
  }
};

export const validatePendingImport = (value: unknown, code: string): void => {
  const pending = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(pending, ['importId', 'requestHash', 'request'], [], `${code}_FIELDS`);
  requireString(pending['importId'], `${code}_ID`);
  requireString(pending['requestHash'], `${code}_HASH`);
  validateJurisdictionImportRequest(pending['request'], `${code}_REQUEST`);
};

export const validateNumberedRecord = (value: unknown, code: string): void => {
  const record = requireBoundaryRecord(value, code);
  if (record['status'] === 'pending' || record['status'] === 'quarantined') {
    requireExactBoundaryKeys(record, [
      'status', 'request', 'requestHash', 'rawTransaction', 'transactionHash', 'transactionNonce',
    ], record['status'] === 'quarantined' ? ['reason'] : [], `${code}_FIELDS`);
    const request = requireBoundaryRecord(record['request'], `${code}_REQUEST`);
    requireExactBoundaryKeys(request, [
      'version', 'intentId', 'stackKey', 'payerSignerId', 'entityProviderAddress', 'entities',
    ], [], `${code}_REQUEST_FIELDS`);
    if (request['version'] !== 1) throw new Error(`${code}_REQUEST_VERSION`);
    for (const field of ['intentId', 'stackKey', 'payerSignerId', 'entityProviderAddress']) {
      requireString(request[field], `${code}_REQUEST_${field.toUpperCase()}`);
    }
    for (const [index, raw] of requireArray(request['entities'], `${code}_REQUEST_ENTITIES`).entries()) {
      const entity = requireBoundaryRecord(raw, `${code}_REQUEST_ENTITY_${index}`);
      requireExactBoundaryKeys(entity, ['name', 'boardHash', 'config'], ['profileName', 'position'], `${code}_REQUEST_ENTITY_${index}_FIELDS`);
      requireString(entity['name'], `${code}_REQUEST_ENTITY_${index}_NAME`);
      requireString(entity['boardHash'], `${code}_REQUEST_ENTITY_${index}_BOARD`);
      validateConsensusConfig(entity['config'], `${code}_REQUEST_ENTITY_${index}_CONFIG`);
      if (entity['profileName'] !== undefined) requireString(entity['profileName'], `${code}_REQUEST_ENTITY_${index}_PROFILE`);
      if (entity['position'] !== undefined) validateEntityPosition(entity['position'], `${code}_REQUEST_ENTITY_${index}_POSITION`);
    }
    for (const field of ['requestHash', 'rawTransaction', 'transactionHash']) requireString(record[field], `${code}_${field.toUpperCase()}`);
    requireBoundaryInteger(record['transactionNonce'], `${code}_NONCE`);
    if (record['reason'] !== undefined) requireString(record['reason'], `${code}_REASON`);
  } else if (record['status'] === 'completed') {
    requireExactBoundaryKeys(record, ['status', 'intentId', 'requestHash', 'transactionHash', 'results'], [], `${code}_FIELDS`);
    for (const field of ['intentId', 'requestHash', 'transactionHash']) requireString(record[field], `${code}_${field.toUpperCase()}`);
    for (const [index, raw] of requireArray(record['results'], `${code}_RESULTS`).entries()) {
      const result = requireBoundaryRecord(raw, `${code}_RESULT_${index}`);
      requireExactBoundaryKeys(result, ['entityNumber', 'entityId', 'registrationBlock', 'evidenceHash'], [], `${code}_RESULT_${index}_FIELDS`);
      requireBoundaryInteger(result['entityNumber'], `${code}_RESULT_${index}_NUMBER`);
      requireString(result['entityId'], `${code}_RESULT_${index}_ENTITY`);
      requireBoundaryInteger(result['registrationBlock'], `${code}_RESULT_${index}_BLOCK`);
      requireString(result['evidenceHash'], `${code}_RESULT_${index}_EVIDENCE`);
    }
  } else throw new Error(`${code}_STATUS`);
};

export const validateRegistrationEvidence = (value: unknown, code: string): void => {
  const evidence = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(evidence, [
    'version', 'source', 'stackKey', 'entityId', 'boardHash', 'activationHeight', 'blockHash',
    'transactionHash', 'transactionIndex', 'logIndex', 'emitter', 'topics', 'data', 'rawLogDigest',
    'receiptsRoot', 'encodedReceipt', 'receiptProofNodes', 'receiptLogIndex', 'observedThroughHeight',
    'observedTipBlockHash', 'observedHeadHeight', 'confirmationDepth', 'witnessRuntimeId', 'witnessSignature',
  ], [], `${code}_FIELDS`);
  if (evidence['version'] !== 1) throw new Error(`${code}_VERSION`);
  if (evidence['source'] !== 'FoundationBootstrapped' && evidence['source'] !== 'EntityRegistered') throw new Error(`${code}_SOURCE`);
  for (const field of [
    'stackKey', 'entityId', 'boardHash', 'blockHash', 'transactionHash', 'emitter', 'data',
    'rawLogDigest', 'receiptsRoot', 'encodedReceipt', 'observedTipBlockHash', 'witnessRuntimeId', 'witnessSignature',
  ]) requireString(evidence[field], `${code}_${field.toUpperCase()}`);
  for (const field of [
    'activationHeight', 'transactionIndex', 'logIndex', 'receiptLogIndex', 'observedThroughHeight',
    'observedHeadHeight', 'confirmationDepth',
  ]) requireBoundaryInteger(evidence[field], `${code}_${field.toUpperCase()}`);
  requireStringArray(evidence['topics'], `${code}_TOPICS`);
  requireStringArray(evidence['receiptProofNodes'], `${code}_PROOF_NODES`);
};
