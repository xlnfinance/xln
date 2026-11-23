import { ethers } from 'ethers';
import { BLOCKCHAIN } from '../../../../core/config/constants';
import { RpcTransportUnavailableError, TRANSIENT_RPC_HTTP_STATUSES } from '../../../../core/jurisdiction/adapter/kernel/failure';
import { requireBoundaryRecord } from '../../../../core/protocol/boundary-validation';
import { safeStringify } from '../../../../core/protocol/serialization';
import { createHeaderReadQueue, requireLiveHeaderClient } from './header-read-queue';
import { createReadPacer } from './read-pacing';

const endpoint = 'https://arbitrum-sepolia.hypersync.xyz/query';
const headerFields = {
  number: 'number', hash: 'hash', parent_hash: 'parentHash', sha3_uncles: 'sha3Uncles',
  miner: 'miner', state_root: 'stateRoot', transactions_root: 'transactionsRoot',
  receipts_root: 'receiptsRoot', logs_bloom: 'logsBloom', difficulty: 'difficulty',
  gas_limit: 'gasLimit', gas_used: 'gasUsed', timestamp: 'timestamp', extra_data: 'extraData',
  mix_hash: 'mixHash', nonce: 'nonce', base_fee_per_gas: 'baseFeePerGas',
  withdrawals_root: 'withdrawalsRoot', blob_gas_used: 'blobGasUsed',
  excess_blob_gas: 'excessBlobGas', parent_beacon_block_root: 'parentBeaconBlockRoot',
};
const quantityFields = new Set([
  'number', 'difficulty', 'gas_limit', 'gas_used', 'timestamp', 'base_fee_per_gas',
  'blob_gas_used', 'excess_blob_gas',
]);
const blockColumns = Object.entries(headerFields);
const optionalColumns = new Set([
  'base_fee_per_gas', 'withdrawals_root', 'blob_gas_used', 'excess_blob_gas', 'parent_beacon_block_root',
]);
const requiredColumns = blockColumns.filter(([key]) => !optionalColumns.has(key));
const hash = /^0x[0-9a-f]{64}$/;
const record = (raw: unknown) => requireBoundaryRecord(raw, 'USDC_HYPERSYNC_ROW_INVALID');
const quantity = (raw: unknown) => {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return ethers.toQuantity(raw);
  if (typeof raw === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/.test(raw)) return ethers.toQuantity(BigInt(raw));
  throw new Error('USDC_HYPERSYNC_QUANTITY_INVALID');
};

const integer = (raw: unknown): number => {
  const value = Number(quantity(raw));
  if (!Number.isSafeInteger(value)) throw new Error('USDC_HYPERSYNC_INTEGER_INVALID');
  return value;
};

const pageRows = (groups: unknown[], key: 'blocks' | 'transactions') => groups.flatMap(raw => {
  const rows = record(raw)[key];
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) throw new Error('USDC_HYPERSYNC_TABLE_INVALID');
  return rows.map(record);
});

const transactionLists = (rows: ReturnType<typeof pageRows>, blocks: ReturnType<typeof pageRows>, from: number) => {
  const transactions = blocks.map(() => new Map<number, string>());
  for (const row of rows) {
    const offset = integer(row['block_number']) - from;
    const list = transactions[offset];
    const block = blocks[offset];
    const index = integer(row['transaction_index']);
    const id = row['hash'];
    if (!list || !block || row['block_hash'] !== block['hash'] || list.has(index) ||
        typeof id !== 'string' || !hash.test(id)) throw new Error('USDC_HYPERSYNC_TRANSACTION_INVALID');
    list.set(index, id);
  }
  return transactions.map(list => Array.from({ length: list.size }, (_, index) => {
    const id = list.get(index);
    if (id === undefined) throw new Error('USDC_HYPERSYNC_TRANSACTION_GAP');
    return id;
  }));
};

const decodePage = (raw: unknown, from: number, end: number) => {
  const { data, next_block: next } = record(raw);
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= from || next > end || !Array.isArray(data))
    throw new Error('USDC_HYPERSYNC_PAGE_INVALID');
  const blocks = pageRows(data, 'blocks');
  if (blocks.length !== next - from) throw new Error('USDC_HYPERSYNC_BLOCK_GAP');
  const lists = transactionLists(pageRows(data, 'transactions'), blocks, from);
  return { next, blocks: blocks.map((block, i) => {
    const transactions = lists[i];
    if (!transactions || integer(block['number']) !== from + i || requiredColumns.some(([key]) => block[key] == null))
      throw new Error('USDC_HYPERSYNC_HEADER_INVALID');
    const header = Object.fromEntries(blockColumns.flatMap(([key, field]) => {
      const value = block[key];
      return value == null ? [] : [[field, quantityFields.has(key) ? quantity(value) : value]];
    }));
    return { ...header, transactions };
  }) };
};

const queryPage = (token: string, from: number, end: number, signal: AbortSignal): Promise<Response> =>
  fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: safeStringify({
      from_block: from, to_block: end, include_all_blocks: true, join_mode: 'JoinNothing', transactions: [{}],
      field_selection: { block: Object.keys(headerFields), transaction: ['block_number', 'block_hash', 'transaction_index', 'hash'] },
    }),
    signal,
  }).catch(() => { throw new RpcTransportUnavailableError('USDC_HYPERSYNC_TRANSPORT_UNAVAILABLE'); });

const checkResponse = async (response: Response) => {
  if (response.ok) return;
  await response.body?.cancel();
  const message = `USDC_HYPERSYNC_HTTP_${response.status}`;
  if (TRANSIENT_RPC_HTTP_STATUSES.has(response.status)) throw new RpcTransportUnavailableError(message);
  throw new Error(message);
};

const tracePage = (from: number, to: number, next: number, response: Response) => {
  if (process.env['POC_HEADER_BATCH_TIMING'] !== '1') return;
  const rate = Object.fromEntries(['cost', 'remaining', 'reset'].flatMap(name => {
    const value = response.headers.get(`x-ratelimit-${name}`);
    return value !== null && /^\d{1,12}$/.test(value) ? [[name, Number(value)]] : [];
  }));
  process.stderr.write(`USDC_HYPERSYNC_PAGE:${safeStringify({ from, to, next, status: response.status, ...rate })}\n`);
};

export const createHyperSyncHeaderReader = (token: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('USDC_HYPERSYNC_TOKEN_INVALID');
  const queue = createHeaderReadQueue();
  const pace = createReadPacer();
  const trace = process.env['POC_HEADER_BATCH_TIMING'] === '1';
  return async (params: readonly unknown[], client: AbortSignal) => {
    const [from, to] = params;
    if (params.length !== 2 || typeof from !== 'number' || typeof to !== 'number' ||
        !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from ||
        to >= Number.MAX_SAFE_INTEGER || to - from > BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL)
      throw new Error('USDC_HYPERSYNC_RANGE_INVALID');
    const queuedAt = performance.now();
    const release = await queue.acquire(client);
    const queueMs = Math.round(performance.now() - queuedAt);
    try {
      requireLiveHeaderClient(client);
      const signal = AbortSignal.any([client, AbortSignal.timeout(45_000)]);
      const blocks: ReturnType<typeof decodePage>['blocks'] = [];
      let upstreamMs = 0;
      for (let height = from; height <= to;) {
        // The shared testnet token allows fifteen requests per minute.
        await pace(endpoint, 4_500, signal);
        const sentAt = performance.now();
        const response = await queryPage(token, height, to + 1, signal);
        if (!response.ok) tracePage(height, to, height, response);
        await checkResponse(response);
        const raw: unknown = await response.json().catch(() => {
          if (signal.aborted) throw new RpcTransportUnavailableError('USDC_HYPERSYNC_TRANSPORT_UNAVAILABLE');
          throw new Error('USDC_HYPERSYNC_JSON_INVALID');
        });
        upstreamMs += performance.now() - sentAt;
        const page = decodePage(raw, height, to + 1);
        tracePage(height, to, page.next, response);
        blocks.push(...page.blocks);
        height = page.next;
      }
      if (trace)
        process.stderr.write(`USDC_HYPERSYNC_RANGE_TIMING:${safeStringify({ queueMs, upstreamMs: Math.round(upstreamMs) })}\n`);
      return blocks;
    } finally {
      release();
    }
  };
};
