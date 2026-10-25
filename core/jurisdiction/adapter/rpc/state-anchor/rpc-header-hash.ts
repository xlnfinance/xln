import { ethers } from 'ethers';

// Binds an Ethereum header's stateRoot to an already authenticated block hash
// by recomputing keccak256(RLP(header)). An RPC that reports a wrong stateRoot
// under the right hash, consistently in every pass, fails here. Fork fields are
// appended in protocol order and must form a contiguous prefix; an unknown
// header field changes the hash and is rejected, never ignored.

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

const fail = (code: string, detail = ''): never => {
  throw new Error(`STATE_ANCHOR_HEADER_${code}${detail ? `:${detail}` : ''}`);
};

const hash32 = (value: unknown, field: string): string => {
  const text = String(value ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) fail('FIELD_INVALID', field);
  return text;
};

const bytes = (value: unknown, field: string, length?: number): string => {
  const text = String(value ?? '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(text)) fail('FIELD_INVALID', field);
  if (length !== undefined && text.length !== 2 + length * 2) fail('FIELD_LENGTH', field);
  return text;
};

const quantity = (value: unknown, field: string): string => {
  const text = String(value ?? '').toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(text)) fail('FIELD_INVALID', field);
  return text === '0x0' ? '0x' : ethers.toBeHex(BigInt(text));
};

const FORK_FIELDS = [
  ['baseFeePerGas', quantity],
  ['withdrawalsRoot', hash32],
  ['blobGasUsed', quantity],
  ['excessBlobGas', quantity],
  ['parentBeaconBlockRoot', hash32],
  ['requestsHash', hash32],
] as const;

const ethereumHeaderHash = (header: Record<string, unknown>): string => {
  const fields = [
    hash32(header['parentHash'], 'parentHash'),
    hash32(header['sha3Uncles'], 'sha3Uncles'),
    bytes(header['miner'], 'miner', 20),
    hash32(header['stateRoot'], 'stateRoot'),
    hash32(header['transactionsRoot'], 'transactionsRoot'),
    hash32(header['receiptsRoot'], 'receiptsRoot'),
    bytes(header['logsBloom'], 'logsBloom', 256),
    quantity(header['difficulty'], 'difficulty'),
    quantity(header['number'], 'number'),
    quantity(header['gasLimit'], 'gasLimit'),
    quantity(header['gasUsed'], 'gasUsed'),
    quantity(header['timestamp'], 'timestamp'),
    bytes(header['extraData'], 'extraData'),
    hash32(header['mixHash'], 'mixHash'),
    bytes(header['nonce'], 'nonce', 8),
  ];
  let ended = false;
  for (const [name, encode] of FORK_FIELDS) {
    const value = header[name];
    if (value === undefined || value === null) {
      ended = true;
    } else {
      if (ended) fail('FORK_FIELDS_NOT_CONTIGUOUS', name);
      fields.push(encode(value, name));
    }
  }
  return ethers.keccak256(ethers.encodeRlp(fields)).toLowerCase();
};

export type HashBoundHeaderRoots = {
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
};

/** Reads one header and returns its trie roots only if it hashes to blockHash. */
export const readHashBoundHeaderRoots = async (
  send: RpcSend,
  blockNumber: number,
  blockHash: string,
): Promise<HashBoundHeaderRoots> => {
  const raw = await send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false]);
  if (!raw || typeof raw !== 'object') return fail('BLOCK_MISSING', String(blockNumber));
  const header = raw as Record<string, unknown>;
  if (quantity(header['number'], 'number') !== quantity(ethers.toQuantity(blockNumber), 'number')) {
    fail('NUMBER_MISMATCH', `${blockNumber}:${String(header['number'])}`);
  }
  const claimed = hash32(header['hash'], 'hash');
  if (claimed !== hash32(blockHash, 'blockHash')) fail('CLAIMED_HASH_MISMATCH', `${blockNumber}:${blockHash}:${claimed}`);
  const computed = ethereumHeaderHash(header);
  if (computed !== claimed) fail('HASH_MISMATCH', `${blockNumber}:${claimed}:${computed}`);
  return {
    stateRoot: hash32(header['stateRoot'], 'stateRoot'),
    transactionsRoot: hash32(header['transactionsRoot'], 'transactionsRoot'),
    receiptsRoot: hash32(header['receiptsRoot'], 'receiptsRoot'),
  };
};

/** Reads one header and returns its stateRoot only if it hashes to blockHash. */
export const readHashBoundStateRoot = async (
  send: RpcSend,
  blockNumber: number,
  blockHash: string,
): Promise<string> => (await readHashBoundHeaderRoots(send, blockNumber, blockHash)).stateRoot;
