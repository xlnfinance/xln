import {
  requireArray,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from './primitives';

const validateNumberStringTuple = (value: unknown, code: string): void => {
  for (const [index, entry] of requireArray(value, code).entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error(`${code}_${index}_TUPLE`);
    requireBoundaryInteger(entry[0], `${code}_${index}_NUMBER`);
    requireString(entry[1], `${code}_${index}_STRING`);
  }
};

const validateReceipt = (value: unknown, code: string): void => {
  const receipt = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(receipt, [
    'transactionHash', 'blockNumber', 'blockHash', 'from', 'to', 'contractAddress',
    'status', 'type', 'transactionIndex', 'cumulativeGasUsed', 'logsBloom', 'logs',
  ], [], `${code}_FIELDS`);
  for (const field of ['transactionHash', 'blockHash', 'from', 'cumulativeGasUsed', 'logsBloom']) {
    requireString(receipt[field], `${code}_${field.toUpperCase()}`);
  }
  for (const field of ['to', 'contractAddress']) {
    if (receipt[field] !== null) requireString(receipt[field], `${code}_${field.toUpperCase()}`);
  }
  for (const field of ['blockNumber', 'status', 'type', 'transactionIndex']) {
    requireBoundaryInteger(receipt[field], `${code}_${field.toUpperCase()}`);
  }
  for (const [index, raw] of requireArray(receipt['logs'], `${code}_LOGS`).entries()) {
    const log = requireBoundaryRecord(raw, `${code}_LOG_${index}`);
    requireExactBoundaryKeys(
      log,
      ['address', 'topics', 'data', 'blockNumber', 'transactionHash', 'logIndex'],
      [],
      `${code}_LOG_${index}_FIELDS`,
    );
    requireString(log['address'], `${code}_LOG_${index}_ADDRESS`);
    requireArray(log['topics'], `${code}_LOG_${index}_TOPICS`).forEach((topic, topicIndex) =>
      requireString(topic, `${code}_LOG_${index}_TOPIC_${topicIndex}`));
    requireString(log['data'], `${code}_LOG_${index}_DATA`);
    requireBoundaryInteger(log['blockNumber'], `${code}_LOG_${index}_BLOCK`);
    requireString(log['transactionHash'], `${code}_LOG_${index}_TX`);
    requireBoundaryInteger(log['logIndex'], `${code}_LOG_${index}_INDEX`);
  }
};

export const validateBrowserVmState = (value: unknown, code: string): void => {
  const state = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    state,
    ['chainId', 'stateRoot', 'trieData', 'nonce', 'chain', 'addresses'],
    ['version', 'entityProviderDeploymentBlock'],
    `${code}_FIELDS`,
  );
  if (state['version'] !== undefined) requireBoundaryInteger(state['version'], `${code}_VERSION`, 1);
  requireBoundaryInteger(state['chainId'], `${code}_CHAIN_ID`, 1);
  requireString(state['stateRoot'], `${code}_STATE_ROOT`);
  for (const [index, entry] of requireArray(state['trieData'], `${code}_TRIE`).entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error(`${code}_TRIE_${index}_TUPLE`);
    requireString(entry[0], `${code}_TRIE_${index}_KEY`);
    requireString(entry[1], `${code}_TRIE_${index}_VALUE`);
  }
  requireString(state['nonce'], `${code}_NONCE`);
  if (state['entityProviderDeploymentBlock'] !== undefined) {
    requireBoundaryInteger(state['entityProviderDeploymentBlock'], `${code}_DEPLOYMENT_BLOCK`);
  }
  const chain = requireBoundaryRecord(state['chain'], `${code}_CHAIN`);
  requireExactBoundaryKeys(chain, [
    'blockHeight', 'blockHash', 'blockTimestamp', 'entityProviderDeploymentBlock',
    'blockHashes', 'blockReceiptRoots', 'txReceipts',
  ], [], `${code}_CHAIN_FIELDS`);
  requireBoundaryInteger(chain['blockHeight'], `${code}_CHAIN_HEIGHT`);
  requireString(chain['blockHash'], `${code}_CHAIN_HASH`);
  requireBoundaryInteger(chain['blockTimestamp'], `${code}_CHAIN_TIMESTAMP`);
  requireBoundaryInteger(chain['entityProviderDeploymentBlock'], `${code}_CHAIN_DEPLOYMENT_BLOCK`);
  validateNumberStringTuple(chain['blockHashes'], `${code}_CHAIN_BLOCK_HASHES`);
  validateNumberStringTuple(chain['blockReceiptRoots'], `${code}_CHAIN_RECEIPT_ROOTS`);
  for (const [index, entry] of requireArray(chain['txReceipts'], `${code}_CHAIN_RECEIPTS`).entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error(`${code}_CHAIN_RECEIPT_${index}_TUPLE`);
    requireString(entry[0], `${code}_CHAIN_RECEIPT_${index}_HASH`);
    validateReceipt(entry[1], `${code}_CHAIN_RECEIPT_${index}_VALUE`);
  }
  const addresses = requireBoundaryRecord(state['addresses'], `${code}_ADDRESSES`);
  requireExactBoundaryKeys(addresses, ['depository', 'entityProvider'], [], `${code}_ADDRESSES_FIELDS`);
  requireString(addresses['depository'], `${code}_DEPOSITORY`);
  requireString(addresses['entityProvider'], `${code}_ENTITY_PROVIDER`);
};
