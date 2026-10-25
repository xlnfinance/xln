import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import type { EntityState, JurisdictionConfig } from '../../../../entity/types';
import { generateLazyEntityId } from '../../../../entity/factory';
import { batchNonce, buildStartAndAccept, signShortfallStartAndAccept, startShortfallDispute, type DisputeParty } from '../../../fixtures/jurisdiction/real-dispute-shortfall';
import { applyDebtCreated, applyDebtEnforced, applyDebtForgiven } from '../../../../entity/tx/j-events-observations/debt';
import { buildSingleSignerHanko, prepareSignedBatch } from '../../../../hanko/batch';
import { encodeInt512 } from '../../../../protocol/crypto/abi-money';
import { createJAdapter, createXlnJsonRpcProvider } from '../../../../jurisdiction/adapter';
import type { JAdapter } from '../../../../jurisdiction/adapter/types';
import { computeAccountKey } from '../../../../jurisdiction/adapter/events/contract-codec';
import { rawEventToJEvents } from '../../../../jurisdiction/adapter/events/j-event-payloads';
import { decodeJEventLog } from '../../../../jurisdiction/adapter/j-event-log-decoder';
import { createEmptyBatch } from '../../../../jurisdiction/machine/batch';
import { createSettlementHashWithNonce } from '../../../../protocol/dispute/proof-builder';
import {
  assertEntityOutDebtsMatchAnchor,
  projectOutDebts,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-debt-anchor';
import { assertBlockHashInAnchorHistory, assertDebtCreationProvenance } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-debt-provenance';
import {
  depositoryActiveDebtsSlot,
  depositoryDebtIndexSlot,
  depositoryDebtOutstandingSlot,
  depositoryDebtQueueSlot,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-storage-slots';
import type { DebtEntry } from '../../../../types/finance/debt';
import type { JurisdictionEvent } from '../../../../types/jurisdiction-events';

// Out-debt (D2) anchor on a real chain: the derived Depository debt slots match
// the public getters, an Entity with no open out-debt agrees with hash-bound
// storage in exactly two proofs, and a fold that claims a debt storage does not
// hold is rejected. A real dispute shortfall then creates a debt: the canonical
// applyDebtCreated fold over the real logs equals the proven queue entry,
// aggregate and active count, and a stale or altered fold is rejected. Real
// enforcement then pays one debt in full and one partially (cursor 1), drains
// the queue (reset) and a new shortfall reuses index 0; signed bilateral
// settlements forgive the head (cursor advance) and then the last entry (reset).
// Every step's fold of DebtCreated/DebtEnforced/DebtForgiven equals storage,
// the previous block's does not.
const CHAIN_ID = 31_337;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });

let anvil: ChildProcess | null = null;
let adapter: JAdapter | null = null;
let provider: ethers.JsonRpcProvider;
let jurisdiction: JurisdictionConfig;

beforeAll(async () => {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID),
    '--block-gas-limit', '60000000', '--silent',
  ], { stdio: 'ignore' });
  provider = createXlnJsonRpcProvider(rpcUrl);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await provider.getBlockNumber();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await Bun.sleep(50);
    }
  }
  adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl });
  await adapter.deployStack();
  jurisdiction = {
    chainId: CHAIN_ID,
    depositoryAddress: adapter.addresses.depository,
    entityProviderAddress: adapter.addresses.entityProvider,
  } as JurisdictionConfig;
}, 60_000);

afterAll(async () => {
  await provider?.destroy();
  anvil?.kill('SIGKILL');
});

const openOutDebt = (debtor: string, creditor: string, tokenId: number, index: number, remaining: bigint): DebtEntry => ({
  debtId: `${debtor}:${tokenId}:${index}:1:${ethers.ZeroHash}`,
  tokenId,
  debtor,
  creditor,
  counterparty: creditor,
  direction: 'out',
  createdAmount: remaining,
  paidAmount: 0n,
  remainingAmount: remaining,
  createdDebtIndex: index,
  currentDebtIndex: index,
  status: 'open',
  createdAtBlock: 1,
  createdSeq: 1n,
  createdTxHash: ethers.ZeroHash,
  lastUpdatedBlock: 1,
  lastUpdatedTxHash: ethers.ZeroHash,
  lastEventType: 'DebtCreated',
});

test('out-debt anchor agrees with an empty real queue and rejects a debt storage does not hold', async () => {
  const jAdapter = adapter!;
  const debtor = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();
  const creditor = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();
  await jAdapter.debugFundReserves(debtor, 1, 1_000n);
  const blockNumber = await provider.getBlockNumber();
  const block = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string };
  const blockTag = ethers.toQuantity(blockNumber);
  const tokenCount = BigInt(await jAdapter.depository.getTokensLength());
  expect(tokenCount).toBeGreaterThanOrEqual(3n);

  // Derived slots read the same words the public getters return.
  const readSlot = async (slot: bigint): Promise<bigint> =>
    BigInt(String(await provider.send('eth_getStorageAt', [jAdapter.addresses.depository, ethers.toBeHex(slot, 32), blockTag])));
  expect(await readSlot(depositoryActiveDebtsSlot(debtor))).toBe(BigInt(await jAdapter.depository.activeDebts(debtor)));
  expect(await readSlot(depositoryDebtIndexSlot(debtor, 1n))).toBe(BigInt(await jAdapter.depository._debtIndex(debtor, 1n)));
  expect(await readSlot(depositoryDebtQueueSlot(debtor, 1n))).toBe(0n);
  expect(await readSlot(depositoryDebtOutstandingSlot(debtor, 1n, 2n))).toBe(0n);

  const proofCalls: string[] = [];
  const send = (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'eth_getProof') proofCalls.push(method);
    return provider.send(method, params);
  };
  const common = { send, jurisdiction, blockNumber, authenticatedBlockHash: block.hash };

  const anchor = await assertEntityOutDebtsMatchAnchor({ ...common, entities: [{ entityId: debtor, outDebtsByToken: undefined }] });
  // tokenCount, then one head proof; no entry pass for empty queues.
  expect(proofCalls.length).toBe(2);
  expect(anchor.debtors.get(debtor)?.activeDebts).toBe(0n);
  expect(anchor.debtors.get(debtor)?.byToken.size).toBe(0);

  const claimed = new Map([[1, new Map([['claimed', openOutDebt(debtor, creditor, 1, 0, 50n)]])]]);
  await expect(assertEntityOutDebtsMatchAnchor({ ...common, entities: [{ entityId: debtor, outDebtsByToken: claimed }] }))
    .rejects.toThrow('DEBT_ANCHOR_MISMATCH');
  await expect(assertEntityOutDebtsMatchAnchor({
    ...common,
    entities: [{ entityId: debtor, outDebtsByToken: claimed }, { entityId: debtor, outDebtsByToken: undefined }],
  })).rejects.toThrow('DEBT_ANCHOR_REPLICA_DIVERGENCE');
  await expect(assertEntityOutDebtsMatchAnchor({ ...common, authenticatedBlockHash: ethers.ZeroHash, entities: [{ entityId: debtor, outDebtsByToken: undefined }] }))
    .rejects.toThrow('STATE_ANCHOR_HEADER_CLAIMED_HASH_MISMATCH');

  // The projection refuses entries the fold must never hold.
  expect(() => projectOutDebts(debtor, new Map([[1, new Map([['in', { ...openOutDebt(debtor, creditor, 1, 0, 5n), direction: 'in' as const }]])]])))
    .toThrow('DEBT_ANCHOR_LOCAL_ENTRY_INVALID');
  expect(() => projectOutDebts(debtor, new Map([[1, new Map([
    ['a', openOutDebt(debtor, creditor, 1, 0, 5n)],
    ['b', openOutDebt(debtor, creditor, 1, 0, 6n)],
  ])]]))).toThrow('DEBT_ANCHOR_LOCAL_INDEX_DUPLICATE');
}, 60_000);

const DISPUTE_PROOF = 1;
const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,tuple(int256 high,uint256 low)[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';
const ABI = ethers.AbiCoder.defaultAbiCoder();

const need = <T>(value: T | undefined | null, label: string): T => {
  if (value === undefined || value === null) throw new Error(`MISSING:${label}`);
  return value;
};

test('a real dispute shortfall debt: history fold equals hash-bound queue, aggregate and active count', async () => {
  const jAdapter = need(adapter, 'adapter');
  const depository = jAdapter.addresses.depository;
  const signers = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()]
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const left = need(signers[0], 'left');
  const right = need(signers[1], 'right');
  const tokenId = 1;
  const watchSeed = `0x${'d2'.repeat(32)}`;

  // LEFT funds 1000 and moves 300 into collateral with RIGHT (ondelta 300).
  await jAdapter.debugFundReserves(left.entityId, tokenId, 1_000n);
  const collateral = createEmptyBatch();
  collateral.reserveToCollateral.push({ tokenId, receivingEntity: left.entityId, pairs: [{ entity: right.entityId, amount: 300n }] });
  const signedCollateral = prepareSignedBatch(collateral, left.entityId, left.wallet.privateKey, BigInt(CHAIN_ID), depository, 0n);
  await jAdapter.processBatch(signedCollateral.encodedBatch, signedCollateral.hankoData, signedCollateral.nextNonce);

  // LEFT signs a state with allocation 300 - 1300 = -1000: RIGHT takes the
  // 300 collateral, LEFT pays its 700 spendable reserve and owes 300.
  const proofbody = { watchSeed, leftResponseSeconds: 15n, rightResponseSeconds: 15n, offdeltas: [encodeInt512(-1_300n)], tokenIds: [BigInt(tokenId)], transformers: [] };
  const proofbodyHash = ethers.keccak256(ABI.encode([PROOF_BODY_ABI], [proofbody]));
  const accountKey = computeAccountKey(left.entityId, right.entityId);
  const disputeNonce = 1n;
  const startHash = ethers.keccak256(ABI.encode(
    ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
    [DISPUTE_PROOF, CHAIN_ID, depository, accountKey, disputeNonce, true, proofbodyHash, watchSeed],
  ));
  const start = createEmptyBatch();
  start.disputeStarts.push({
    counterentity: left.entityId,
    nonce: batchNonce(disputeNonce),
    proposerIsLeft: true,
    proofbodyHash,
    initialProofbody: proofbody,
    watchSeed,
    sig: buildSingleSignerHanko(left.entityId, startHash, left.wallet.privateKey),
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: ethers.ZeroHash,
  });
  const signedStart = prepareSignedBatch(start, right.entityId, right.wallet.privateKey, BigInt(CHAIN_ID), depository, 0n);
  await jAdapter.processBatch(signedStart.encodedBatch, signedStart.hankoData, signedStart.nextNonce);
  const beforeDebt = await provider.getBlockNumber();

  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  // Unilateral timeout: no signature, the committed initial branch.
  const finalize = createEmptyBatch();
  finalize.disputeFinalizations.push({
    counterentity: left.entityId,
    initialNonce: batchNonce(disputeNonce),
    finalNonce: batchNonce(disputeNonce),
    proposerIsLeft: true,
    initialProofbodyHash: proofbodyHash,
    finalProofbody: proofbody,
    starterArguments: '0x',
    otherArguments: '0x',
    sig: '0x',
    startedByLeft: false,
    cooperative: false,
  });
  const signedFinalize = prepareSignedBatch(finalize, right.entityId, right.wallet.privateKey, BigInt(CHAIN_ID), depository, signedStart.nextNonce);
  await jAdapter.processBatch(signedFinalize.encodedBatch, signedFinalize.hankoData, signedFinalize.nextNonce);
  const blockNumber = await provider.getBlockNumber();
  const block = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string };

  // Canonical Entity fold of every Depository DebtCreated up to the block.
  const fold = async (toBlock: number): Promise<{ debtor: EntityState; creditor: EntityState }> => {
    const debtor = { entityId: left.entityId } as unknown as EntityState;
    const creditor = { entityId: right.entityId } as unknown as EntityState;
    const logs = await provider.getLogs({ address: depository, fromBlock: 0, toBlock });
    for (const log of logs) {
      const raw = decodeJEventLog(log, jAdapter.depository.interface, {
        blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.index,
      }, 'DEBT_ANCHOR_LOG_DECODE');
      if (raw.name !== 'DebtCreated') continue;
      for (const event of rawEventToJEvents(raw, ethers.ZeroHash)) {
        const located = { ...event, blockNumber: log.blockNumber, transactionHash: log.transactionHash } as Extract<JurisdictionEvent, { type: 'DebtCreated' }>;
        applyDebtCreated(debtor, located);
        applyDebtCreated(creditor, located);
      }
    }
    return { debtor, creditor };
  };
  const history = await fold(blockNumber);
  const outEntries = [...need(history.debtor.outDebtsByToken?.get(tokenId), 'out bucket').values()];
  expect(outEntries.map(entry => [entry.creditor, entry.remainingAmount, entry.createdDebtIndex])).toEqual([[right.entityId, 300n, 0]]);
  expect(history.creditor.inDebtsByToken?.get(tokenId)?.size).toBe(1);
  expect(BigInt(await jAdapter.depository.activeDebts(left.entityId))).toBe(1n);

  const common = { send: (method: string, params: unknown[]) => provider.send(method, params), jurisdiction, blockNumber, authenticatedBlockHash: block.hash };
  const anchor = await assertEntityOutDebtsMatchAnchor({
    ...common,
    entities: [
      { entityId: left.entityId, outDebtsByToken: history.debtor.outDebtsByToken },
      { entityId: right.entityId, outDebtsByToken: history.creditor.outDebtsByToken },
    ],
  });
  const queue = need(anchor.debtors.get(left.entityId)?.byToken.get(tokenId), 'queue');
  expect(queue).toEqual({ cursor: 0n, length: 1n, outstanding: 300n, entries: [{ index: 0, creditor: right.entityId, amount: 300n }] });
  expect(anchor.debtors.get(left.entityId)?.activeDebts).toBe(1n);
  expect(anchor.debtors.get(right.entityId)?.byToken.size).toBe(0);

  // A fold stopped before the shortfall, or one with an altered remaining amount, is rejected.
  const stale = await fold(beforeDebt);
  expect(stale.debtor.outDebtsByToken).toBeUndefined();
  await expect(assertEntityOutDebtsMatchAnchor({ ...common, entities: [{ entityId: left.entityId, outDebtsByToken: stale.debtor.outDebtsByToken }] }))
    .rejects.toThrow('DEBT_ANCHOR_MISMATCH');
  const altered = new Map([[tokenId, new Map(outEntries.map(entry => [entry.debtId, { ...entry, remainingAmount: 299n }]))]]);
  await expect(assertEntityOutDebtsMatchAnchor({ ...common, entities: [{ entityId: left.entityId, outDebtsByToken: altered }] }))
    .rejects.toThrow('DEBT_ANCHOR_MISMATCH');
}, 60_000);

type Party = DisputeParty;

// Canonical fold of every Depository debt event up to the block, for every party.
const foldDebtEvents = async (
  jAdapter: JAdapter,
  parties: Party[],
  toBlock: number,
  keep: (log: ethers.Log) => boolean = () => true,
): Promise<Map<string, EntityState>> => {
  const states = new Map(parties.map(party => [party.entityId, { entityId: party.entityId } as unknown as EntityState]));
  const logs = await provider.getLogs({ address: jAdapter.addresses.depository, fromBlock: 0, toBlock });
  for (const log of logs) {
    if (!keep(log)) continue;
    const raw = decodeJEventLog(log, jAdapter.depository.interface, {
      blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.index,
    }, 'DEBT_ANCHOR_LOG_DECODE');
    if (raw.name !== 'DebtCreated' && raw.name !== 'DebtEnforced' && raw.name !== 'DebtForgiven') continue;
    for (const event of rawEventToJEvents(raw, ethers.ZeroHash)) {
      const located = { ...event, blockNumber: log.blockNumber, transactionHash: log.transactionHash } as JurisdictionEvent;
      for (const state of states.values()) {
        if (located.type === 'DebtCreated') applyDebtCreated(state, located);
        else if (located.type === 'DebtEnforced') applyDebtEnforced(state, located);
        else if (located.type === 'DebtForgiven') applyDebtForgiven(state, located);
      }
    }
  }
  return states;
};

// Fold to the current block, require storage equality for every party, and
// require the debtor's fold stopped one block earlier to be rejected.
const anchorStep = async (jAdapter: JAdapter, parties: Party[], debtor: Party, tokenId: number) => {
  const blockNumber = await provider.getBlockNumber();
  const block = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string };
  const common = { send: (method: string, params: unknown[]) => provider.send(method, params), jurisdiction, blockNumber, authenticatedBlockHash: block.hash };
  const states = await foldDebtEvents(jAdapter, parties, blockNumber);
  const anchor = await assertEntityOutDebtsMatchAnchor({
    ...common,
    entities: parties.map(party => ({
      entityId: party.entityId,
      outDebtsByToken: states.get(party.entityId)?.outDebtsByToken,
      inDebtsByToken: states.get(party.entityId)?.inDebtsByToken,
    })),
  });
  for (const party of parties) {
    const inLedger = states.get(party.entityId)?.inDebtsByToken;
    const open = [...(inLedger?.values() ?? [])].reduce((count, ledger) => count + BigInt(ledger.size), 0n);
    expect(BigInt(await jAdapter.depository.inActiveDebts(party.entityId))).toBe(open);
    const [omittedToken, omittedLedger] = [...(inLedger?.entries() ?? [])][0] ?? [];
    const [omittedId] = [...(omittedLedger?.keys() ?? [])];
    if (omittedToken === undefined || omittedLedger === undefined || omittedId === undefined) continue;
    // The creditor fold missing one live in-debt must not look complete.
    const missing = new Map(inLedger);
    const remaining = new Map(omittedLedger);
    remaining.delete(omittedId);
    if (remaining.size === 0) missing.delete(omittedToken);
    else missing.set(omittedToken, remaining);
    await expect(assertEntityOutDebtsMatchAnchor({
      ...common,
      entities: [{ entityId: party.entityId, outDebtsByToken: states.get(party.entityId)?.outDebtsByToken, inDebtsByToken: missing }],
    })).rejects.toThrow('IN_ACTIVE_COUNT_MISMATCH');
  }
  const stale = await foldDebtEvents(jAdapter, parties, blockNumber - 1);
  await expect(assertEntityOutDebtsMatchAnchor({
    ...common,
    entities: [{ entityId: debtor.entityId, outDebtsByToken: stale.get(debtor.entityId)?.outDebtsByToken }],
  })).rejects.toThrow('DEBT_ANCHOR_MISMATCH');
  const out = [...(states.get(debtor.entityId)?.outDebtsByToken?.get(tokenId)?.values() ?? [])];
  return { anchor, states, out, queue: anchor.debtors.get(debtor.entityId)?.byToken.get(tokenId), active: anchor.debtors.get(debtor.entityId)?.activeDebts };
};

test('real enforcement, cursor advance, queue reset and index-0 reuse: every fold step equals hash-bound storage', async () => {
  const jAdapter = need(adapter, 'adapter');
  const depository = jAdapter.addresses.depository;
  const parties: Party[] = Array.from({ length: 4 }, () => ethers.Wallet.createRandom())
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const [debtor, a, b, c] = [need(parties[0], 'debtor'), need(parties[1], 'a'), need(parties[2], 'b'), need(parties[3], 'c')];
  const tokenId = 1;

  // The debtor funds 1000 and puts 300 collateral into each of three accounts.
  await jAdapter.debugFundReserves(debtor.entityId, tokenId, 1_000n);
  const collateral = createEmptyBatch();
  collateral.reserveToCollateral.push({
    tokenId,
    receivingEntity: debtor.entityId,
    pairs: [a, b, c].map(party => ({ entity: party.entityId, amount: 300n })),
  });
  const signedCollateral = prepareSignedBatch(collateral, debtor.entityId, debtor.wallet.privateKey, BigInt(CHAIN_ID), depository, 0n);
  await jAdapter.processBatch(signedCollateral.encodedBatch, signedCollateral.hankoData, signedCollateral.nextNonce);

  // Deltas -300/-200/-50: A takes the 100 spendable reserve and is owed 200
  // (index 0), B is owed 200 (index 1), C finalizes only after the reset.
  const finalizeA = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, a, -600n, 'a1');
  const finalizeB = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, b, -500n, 'b1');
  const finalizeC = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, c, -350n, 'c1');
  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  const step = () => anchorStep(jAdapter, parties, debtor, tokenId);

  await finalizeA();
  await finalizeB();
  const created = await step();
  expect(created.queue).toEqual({ cursor: 0n, length: 2n, outstanding: 400n, entries: [
    { index: 0, creditor: a.entityId, amount: 200n },
    { index: 1, creditor: b.entityId, amount: 200n },
  ] });
  expect(created.active).toBe(2n);
  const debtIdA = need(created.out.find(entry => entry.creditor === a.entityId), 'debt A').debtId;

  // 300 inflow, enforced: A paid in full (entry deleted), B partially; cursor 1 of 2.
  await jAdapter.debugFundReserves(debtor.entityId, tokenId, 300n);
  await jAdapter.enforceDebts(debtor.entityId, tokenId, 0);
  const partial = await step();
  expect(partial.queue).toEqual({ cursor: 1n, length: 2n, outstanding: 100n, entries: [{ index: 1, creditor: b.entityId, amount: 100n }] });
  expect(partial.active).toBe(1n);
  expect(partial.out.map(entry => [entry.creditor, entry.paidAmount, entry.remainingAmount, entry.currentDebtIndex]))
    .toEqual([[b.entityId, 100n, 100n, 1]]);
  expect(partial.states.get(a.entityId)?.inDebtsByToken).toBeUndefined();
  expect(partial.states.get(b.entityId)?.inDebtsByToken?.get(tokenId)?.size).toBe(1);

  // 100 inflow, enforced: B paid in full, the queue is deleted and the cursor reset.
  await jAdapter.debugFundReserves(debtor.entityId, tokenId, 100n);
  await jAdapter.enforceDebts(debtor.entityId, tokenId, 0);
  const drained = await step();
  expect(drained.queue).toBeUndefined();
  expect(drained.active).toBe(0n);
  expect(drained.states.get(debtor.entityId)?.outDebtsByToken).toBeUndefined();
  expect(BigInt(await jAdapter.depository._debtIndex(debtor.entityId, tokenId))).toBe(0n);

  // C's shortfall reuses queue index 0 under a distinct debt identity.
  await finalizeC();
  const reused = await step();
  expect(reused.queue).toEqual({ cursor: 0n, length: 1n, outstanding: 50n, entries: [{ index: 0, creditor: c.entityId, amount: 50n }] });
  expect(reused.active).toBe(1n);
  expect(reused.out.map(entry => [entry.creditor, entry.createdDebtIndex])).toEqual([[c.entityId, 0]]);
  expect(need(reused.out[0], 'debt C').debtId).not.toBe(debtIdA);
}, 60_000);

test('a shortfall on an unlisted token is a real debt: proven, not refused; omitting it fails closed', async () => {
  const jAdapter = need(adapter, 'adapter');
  const depository = jAdapter.addresses.depository;
  const parties: Party[] = Array.from({ length: 2 }, () => ethers.Wallet.createRandom())
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const [debtor, creditor] = [need(parties[0], 'debtor'), need(parties[1], 'creditor')];
  const tokenCount = BigInt(await jAdapter.depository.getTokensLength());
  const unlisted = tokenCount + 4n;

  // No collateral and no reserve: the whole -77 delta is booked as debt on the unlisted token.
  const finalize = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, creditor, -77n, 'e7', unlisted);
  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  await finalize();
  const blockNumber = await provider.getBlockNumber();
  const block = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string };
  expect(BigInt(await jAdapter.depository.activeDebts(debtor.entityId))).toBe(1n);

  const state = { entityId: debtor.entityId } as unknown as EntityState;
  for (const log of await provider.getLogs({ address: depository, fromBlock: 0, toBlock: blockNumber })) {
    const raw = decodeJEventLog(log, jAdapter.depository.interface, {
      blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.index,
    }, 'DEBT_ANCHOR_LOG_DECODE');
    if (raw.name !== 'DebtCreated') continue;
    for (const event of rawEventToJEvents(raw, ethers.ZeroHash)) {
      applyDebtCreated(state, { ...event, blockNumber: log.blockNumber, transactionHash: log.transactionHash } as Extract<JurisdictionEvent, { type: 'DebtCreated' }>);
    }
  }
  const held = need(state.outDebtsByToken?.get(Number(unlisted)), 'unlisted bucket');
  expect([...held.values()].map(entry => [entry.creditor, entry.remainingAmount, entry.createdDebtIndex])).toEqual([[creditor.entityId, 77n, 0]]);

  const common = { send: (method: string, params: unknown[]) => provider.send(method, params), jurisdiction, blockNumber, authenticatedBlockHash: block.hash };
  const anchor = await assertEntityOutDebtsMatchAnchor({ ...common, entities: [{ entityId: debtor.entityId, outDebtsByToken: state.outDebtsByToken }] });
  expect(anchor.debtors.get(debtor.entityId)?.byToken.get(Number(unlisted)))
    .toEqual({ cursor: 0n, length: 1n, outstanding: 77n, entries: [{ index: 0, creditor: creditor.entityId, amount: 77n }] });
  // A ledger without it cannot enumerate the unlisted token; the global active count still catches the omission.
  await expect(assertEntityOutDebtsMatchAnchor({ ...common, entities: [{ entityId: debtor.entityId, outDebtsByToken: undefined }] }))
    .rejects.toThrow('DEBT_ANCHOR_ACTIVE_COUNT_MISMATCH');
}, 60_000);

test('real signed DebtForgiven: cursor advance then queue reset; every fold step equals hash-bound storage', async () => {
  const jAdapter = need(adapter, 'adapter');
  const depository = jAdapter.addresses.depository;
  const parties: Party[] = Array.from({ length: 3 }, () => ethers.Wallet.createRandom())
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const [debtor, x, y] = [need(parties[0], 'debtor'), need(parties[1], 'x'), need(parties[2], 'y')];
  const tokenId = 1;

  // No collateral and no reserve: X is owed 200 (index 0), Y is owed 100 (index 1).
  const finalizeX = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, x, -200n, 'f1');
  const finalizeY = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, y, -100n, 'f2');
  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  await finalizeX();
  await finalizeY();
  const step = () => anchorStep(jAdapter, parties, debtor, tokenId);
  const created = await step();
  expect(created.queue).toEqual({ cursor: 0n, length: 2n, outstanding: 300n, entries: [
    { index: 0, creditor: x.entityId, amount: 200n },
    { index: 1, creditor: y.entityId, amount: 100n },
  ] });
  expect(created.active).toBe(2n);

  // The creditor signs a token-only settlement over the next account nonce; the debtor submits it.
  let debtorNonce = 0n;
  const forgiveBy = async (creditor: Party) => {
    const account = { leftEntity: debtor.entityId, rightEntity: creditor.entityId };
    const nonce = Number((await jAdapter.getAccountInfo(debtor.entityId, creditor.entityId)).nonce) + 1;
    const hash = createSettlementHashWithNonce(account, [], [tokenId], { chainId: CHAIN_ID, depositoryAddress: depository }, nonce);
    const batch = createEmptyBatch();
    batch.settlements.push({
      ...account,
      diffs: [],
      forgiveDebtsInTokenIds: [tokenId],
      sig: buildSingleSignerHanko(creditor.entityId, hash, creditor.wallet.privateKey),
      nonce,
    });
    return prepareSignedBatch(batch, debtor.entityId, debtor.wallet.privateKey, BigInt(CHAIN_ID), depository, debtorNonce);
  };

  // FIFO: Y cannot forgive past X's head; the whole signed settlement reverts.
  const early = await forgiveBy(y);
  const failure = await jAdapter.depository.processBatch.staticCall(early.encodedBatch, early.hankoData, early.nextNonce)
    .then(() => null, (error: unknown) => error);
  expect(failure instanceof Error ? failure.message : '').toContain('E2');

  // X forgives the head: the entry is deleted and the cursor advances to 1 of 2.
  const signedX = await forgiveBy(x);
  await jAdapter.processBatch(signedX.encodedBatch, signedX.hankoData, signedX.nextNonce);
  debtorNonce = signedX.nextNonce;
  const advanced = await step();
  expect(advanced.queue).toEqual({ cursor: 1n, length: 2n, outstanding: 100n, entries: [{ index: 1, creditor: y.entityId, amount: 100n }] });
  expect(advanced.active).toBe(1n);
  expect(advanced.out.map(entry => [entry.creditor, entry.paidAmount, entry.remainingAmount, entry.currentDebtIndex]))
    .toEqual([[y.entityId, 0n, 100n, 1]]);
  expect(advanced.states.get(x.entityId)?.inDebtsByToken).toBeUndefined();
  expect(advanced.states.get(y.entityId)?.inDebtsByToken?.get(tokenId)?.size).toBe(1);

  // Y forgives the last entry: the queue is deleted and the cursor reset.
  const signedY = await forgiveBy(y);
  await jAdapter.processBatch(signedY.encodedBatch, signedY.hankoData, signedY.nextNonce);
  const reset = await step();
  expect(reset.queue).toBeUndefined();
  expect(reset.active).toBe(0n);
  expect(reset.states.get(debtor.entityId)?.outDebtsByToken).toBeUndefined();
  expect(reset.states.get(y.entityId)?.inDebtsByToken).toBeUndefined();
  expect(BigInt(await jAdapter.depository._debtIndex(debtor.entityId, tokenId))).toBe(0n);

  // Both retirements came from real DebtForgiven logs, not enforcement.
  const forgiven = (await provider.getLogs({ address: depository, fromBlock: 0, toBlock: await provider.getBlockNumber() }))
    .map(log => jAdapter.depository.interface.parseLog(log))
    .filter(parsed => parsed?.name === 'DebtForgiven' && String(parsed.args[0]).toLowerCase() === debtor.entityId)
    .map(parsed => [String(parsed?.args[1]).toLowerCase(), BigInt(parsed?.args[4] ?? -1n)]);
  expect(forgiven).toEqual([[x.entityId, 0n], [y.entityId, 1n]]);
}, 60_000);

test('same creditor, index 0 and amount after a queue reset: the retired DebtCreated must not stand in for the new one', async () => {
  const jAdapter = need(adapter, 'adapter');
  const parties: Party[] = Array.from({ length: 2 }, () => ethers.Wallet.createRandom())
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const [debtor, creditor] = [need(parties[0], 'debtor'), need(parties[1], 'creditor')];
  const tokenId = 1;
  const step = () => anchorStep(jAdapter, parties, debtor, tokenId);

  // No collateral and no reserve: the creditor is owed 120 at index 0.
  const finalizeFirst = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, creditor, -120n, 'a7');
  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  await finalizeFirst();
  const firstBlock = await provider.getBlockNumber();
  const first = await step();
  expect(first.queue).toEqual({ cursor: 0n, length: 1n, outstanding: 120n, entries: [{ index: 0, creditor: creditor.entityId, amount: 120n }] });
  const retired = need(first.out[0], 'retired debt');

  // Enforcement pays it in full: the queue is deleted and the index reset.
  await jAdapter.debugFundReserves(debtor.entityId, tokenId, 120n);
  await jAdapter.enforceDebts(debtor.entityId, tokenId, 0);
  const drained = await step();
  expect(drained.queue).toBeUndefined();
  expect(drained.active).toBe(0n);
  expect(BigInt(await jAdapter.depository._debtIndex(debtor.entityId, tokenId))).toBe(0n);
  expect(BigInt(await jAdapter.depository.inActiveDebts(creditor.entityId))).toBe(0n);

  // The same account disputes again above the nonce the timeout finalize stored (1 + 1).
  const finalizeSecond = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, creditor, -120n, 'a8', BigInt(tokenId), 3n);
  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  await finalizeSecond();
  const second = await step();
  const current = need(second.out[0], 'current debt');

  // Every storage word and both active counts are those of the retired debt...
  expect(second.queue).toEqual(first.queue);
  expect(second.active).toBe(first.active);
  expect(BigInt(await jAdapter.depository.inActiveDebts(creditor.entityId))).toBe(1n);
  expect([current.creditor, current.remainingAmount, current.createdDebtIndex])
    .toEqual([retired.creditor, retired.remainingAmount, retired.createdDebtIndex]);
  // ...while the rooted identity differs.
  expect(current.debtId).not.toBe(retired.debtId);
  expect(current.createdTxHash).not.toBe(retired.createdTxHash);
  expect(current.createdAtBlock).toBeGreaterThan(retired.createdAtBlock);

  // Serve the retired DebtCreated and omit its enforcement and the new creation:
  // the anchor must bind each open entry to its own creation, not to its words.
  const stale = await foldDebtEvents(jAdapter, parties, firstBlock);
  expect([...(stale.get(debtor.entityId)?.outDebtsByToken?.get(tokenId)?.keys() ?? [])]).toEqual([retired.debtId]);
  const blockNumber = await provider.getBlockNumber();
  const block = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string };
  await expect(assertEntityOutDebtsMatchAnchor({
    send: (method: string, params: unknown[]) => provider.send(method, params),
    jurisdiction,
    blockNumber,
    authenticatedBlockHash: block.hash,
    entities: parties.map(party => ({
      entityId: party.entityId,
      outDebtsByToken: stale.get(party.entityId)?.outDebtsByToken,
      inDebtsByToken: stale.get(party.entityId)?.inDebtsByToken,
    })),
  })).rejects.toThrow('DEBT_ANCHOR_GENERATION_MISMATCH');
}, 60_000);

test('same creditor, index 0 and amount recreated in the SAME block: the retired DebtCreated must not stand in for the new one', async () => {
  const jAdapter = need(adapter, 'adapter');
  const depository = jAdapter.addresses.depository;
  const parties: Party[] = Array.from({ length: 2 }, () => ethers.Wallet.createRandom())
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const [debtor, creditor] = [need(parties[0], 'debtor'), need(parties[1], 'creditor')];
  const tokenId = 1;
  const creditorNonce = BigInt(await jAdapter.depository.entityNonces(creditor.entityId));
  const debtorNonce = BigInt(await jAdapter.depository.entityNonces(debtor.entityId));
  const shortfall = (seedByte: string, disputeNonce: bigint, creditorBatchNonce: bigint, debtorBatchNonce: bigint) =>
    signShortfallStartAndAccept({
      chainId: CHAIN_ID, depository, debtor, creditor, offdelta: -120n, seedByte, tokenId: BigInt(tokenId),
      disputeNonce, creditorBatchNonce, debtorBatchNonce,
    });
  // The accepted close consumes one nonce (1 + 1); the second dispute starts above it.
  const first = shortfall('b7', 1n, creditorNonce, debtorNonce);
  const second = shortfall('b8', 3n, first.start.nextNonce, first.accept.nextNonce);

  // One block: create 120 at index 0, fund and enforce it (queue deleted, index
  // reset), then recreate 120 at index 0 for the same creditor.
  const runner = jAdapter.depository.runner as ethers.Signer;
  let txNonce = await provider.getTransactionCount(await runner.getAddress(), 'pending');
  const sent: string[] = [];
  await provider.send('evm_setAutomine', [false]);
  try {
    const batch = async (signed: { encodedBatch: string; hankoData: string; nextNonce: bigint }) => {
      const tx = await jAdapter.depository.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce, { nonce: txNonce++, gasLimit: 8_000_000n });
      sent.push(tx.hash);
    };
    await batch(first.start);
    await batch(first.accept);
    sent.push((await jAdapter.depository.mintToReserve(debtor.entityId, tokenId, 120n, { nonce: txNonce++, gasLimit: 1_000_000n })).hash);
    sent.push((await jAdapter.depository.enforceDebts(debtor.entityId, tokenId, 0, { nonce: txNonce++, gasLimit: 2_000_000n })).hash);
    await batch(second.start);
    await batch(second.accept);
    await provider.send('evm_mine', []);
  } finally {
    await provider.send('evm_setAutomine', [true]);
  }
  const receipts = await Promise.all(sent.map(hash => provider.getTransactionReceipt(hash)));
  const blockNumber = need(receipts[0], 'first receipt').blockNumber;
  expect(receipts.map(receipt => [receipt?.status, receipt?.blockNumber])).toEqual(sent.map(() => [1, blockNumber]));
  const [retiredTx, enforceTx, currentTx] = [need(sent[1], 'accept 1'), need(sent[3], 'enforce'), need(sent[5], 'accept 2')];
  expect(await provider.getBlockNumber()).toBe(blockNumber);

  // The honest fold of the whole block equals storage...
  const current = await anchorStep(jAdapter, parties, debtor, tokenId);
  expect(current.queue).toEqual({ cursor: 0n, length: 1n, outstanding: 120n, entries: [{ index: 0, creditor: creditor.entityId, amount: 120n }] });
  expect(current.active).toBe(1n);
  const live = need(current.out[0], 'current debt');
  expect(live.createdTxHash).toBe(currentTx);
  const seq = BigInt(await jAdapter.depository.debtSeq());
  const stored = await jAdapter.depository._debts(debtor.entityId, tokenId, 0);
  expect([BigInt(stored.createdBlock), BigInt(stored.createdSeq)]).toEqual([BigInt(blockNumber), seq]);

  // ...and the retired creation from the same block carries the same creditor,
  // index, amount AND block; only its transaction and debt sequence differ.
  const stale = await foldDebtEvents(jAdapter, parties, blockNumber, log => log.transactionHash !== enforceTx && log.transactionHash !== currentTx);
  const retired = need([...(stale.get(debtor.entityId)?.outDebtsByToken?.get(tokenId)?.values() ?? [])][0], 'retired debt');
  expect(retired.createdTxHash).toBe(retiredTx);
  expect([retired.creditor, retired.remainingAmount, retired.createdDebtIndex, retired.createdAtBlock])
    .toEqual([live.creditor, live.remainingAmount, live.createdDebtIndex, live.createdAtBlock]);
  expect(retired.debtId).not.toBe(live.debtId);

  const block = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string };
  await expect(assertEntityOutDebtsMatchAnchor({
    send: (method: string, params: unknown[]) => provider.send(method, params),
    jurisdiction,
    blockNumber,
    authenticatedBlockHash: block.hash,
    entities: parties.map(party => ({
      entityId: party.entityId,
      outDebtsByToken: stale.get(party.entityId)?.outDebtsByToken,
      inDebtsByToken: stale.get(party.entityId)?.inDebtsByToken,
    })),
  })).rejects.toThrow('DEBT_ANCHOR_GENERATION_MISMATCH');
  // Provenance: each open debt's createdTxHash is proven under the same hash-bound
  // header (transactionsRoot index -> receiptsRoot receipt -> DebtCreated debtSeq).
  const send = (method: string, params: unknown[]) => provider.send(method, params);
  const prove = (entry: DebtEntry, overrides: Partial<{ send: typeof send; blockHash: string }> = {}) =>
    assertDebtCreationProvenance({ send: overrides.send ?? send, depository, authenticatedBlockHash: overrides.blockHash ?? block.hash, entry });
  expect(await prove(live)).toBe(need(receipts[5], 'accept 2').index);
  expect(await prove(retired)).toBe(need(receipts[1], 'accept 1').index);
  await expect(prove({ ...live, createdTxHash: retiredTx })).rejects.toThrow('DEBT_PROVENANCE_LOG_MISSING');
  await expect(prove({ ...live, createdTxHash: enforceTx })).rejects.toThrow('DEBT_PROVENANCE_LOG_MISSING');
  await expect(prove({ ...live, createdAmount: live.createdAmount + 1n })).rejects.toThrow('DEBT_PROVENANCE_LOG_MISMATCH');
  await expect(prove({ ...live, createdTxHash: ethers.id('absent tx') })).rejects.toThrow('DEBT_PROVENANCE_TRANSACTION_NOT_IN_BLOCK');
  await expect(prove(live, { blockHash: ethers.id('other block') })).rejects.toThrow('STATE_ANCHOR_HEADER_CLAIMED_HASH_MISMATCH');
  // An RPC that serves the current transaction at the retired index, or swaps
  // the two receipts, fails the header's roots.
  const swapRaw = async (method: string, params: unknown[]) => {
    if (method === 'eth_getRawTransactionByBlockHashAndIndex') {
      const index = Number(params[1]);
      const swapped = index === 1 ? 5 : index === 5 ? 1 : index;
      return send(method, [params[0], ethers.toQuantity(swapped)]);
    }
    return send(method, params);
  };
  await expect(prove(live, { send: swapRaw })).rejects.toThrow('DEBT_PROVENANCE_TRANSACTIONS_ROOT_MISMATCH');
  const swapReceipts = async (method: string, params: unknown[]) => {
    const result = await send(method, params);
    if (method !== 'eth_getBlockReceipts') return result;
    return (result as Array<{ transactionIndex: string }>).map(receipt => ({
      ...receipt,
      transactionIndex: receipt.transactionIndex === '0x1' ? '0x5' : receipt.transactionIndex === '0x5' ? '0x1' : receipt.transactionIndex,
    }));
  };
  await expect(prove(live, { send: swapReceipts })).rejects.toThrow('J_RECEIPT_ROOT_MISMATCH');
  // Header link: a later anchor's hash-bound state records this block's hash
  // (EIP-2935 history storage), so the creation block needs no parent walk.
  await provider.send('anvil_mine', ['0x3']);
  const anchorHead = (await provider.send('eth_getBlockByNumber', ['latest', false])) as { hash: string; number: string };
  const anchor = { blockNumber: Number(anchorHead.number), blockHash: anchorHead.hash };
  await assertBlockHashInAnchorHistory(send, anchor, blockNumber, block.hash);
  await expect(assertBlockHashInAnchorHistory(send, anchor, blockNumber, ethers.id('other block'))).rejects.toThrow('DEBT_PROVENANCE_HISTORY_HASH_MISMATCH');
  await expect(assertBlockHashInAnchorHistory(send, anchor, blockNumber - 1, block.hash)).rejects.toThrow('DEBT_PROVENANCE_HISTORY_HASH_MISMATCH');
  await expect(assertBlockHashInAnchorHistory(send, { ...anchor, blockHash: block.hash }, blockNumber, block.hash)).rejects.toThrow('STATE_ANCHOR_HEADER_CLAIMED_HASH_MISMATCH');
  await expect(assertBlockHashInAnchorHistory(send, anchor, anchor.blockNumber, anchor.blockHash)).rejects.toThrow('DEBT_PROVENANCE_HISTORY_NOT_BEFORE_ANCHOR');
  await expect(assertBlockHashInAnchorHistory(send, anchor, anchor.blockNumber - 8192, block.hash)).rejects.toThrow('DEBT_PROVENANCE_HISTORY_OUT_OF_WINDOW');
}, 60_000);

test('a debtor batch finalizes one dispute; a collateral return between two shortfalls rebooks index 0 in one block under a distinct debtId', async () => {
  const jAdapter = need(adapter, 'adapter');
  const depository = jAdapter.addresses.depository;
  const parties: Party[] = Array.from({ length: 4 }, () => ethers.Wallet.createRandom())
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const [debtor, x, y, z] = [need(parties[0], 'debtor'), need(parties[1], 'x'), need(parties[2], 'y'), need(parties[3], 'z')];
  const tokenId = 1;

  // The debtor's whole reserve sits as 100 collateral with Y (ondelta 100): spendable 0.
  await jAdapter.debugFundReserves(debtor.entityId, tokenId, 100n);
  const collateral = createEmptyBatch();
  collateral.reserveToCollateral.push({ tokenId, receivingEntity: debtor.entityId, pairs: [{ entity: y.entityId, amount: 100n }] });
  const signedCollateral = prepareSignedBatch(collateral, debtor.entityId, debtor.wallet.privateKey, BigInt(CHAIN_ID), depository,
    BigInt(await jAdapter.depository.entityNonces(debtor.entityId)));
  await jAdapter.processBatch(signedCollateral.encodedBatch, signedCollateral.hankoData, signedCollateral.nextNonce);

  // Each counterparty starts over a debtor-signed state: X -60, Y 0 (the debtor
  // keeps its 100 collateral), Z -90.
  const disputes = ([[x, -60n, 'e1'], [y, 0n, 'e2'], [z, -90n, 'e3']] as const).map(([creditor, offdelta, seedByte]) => ({
    creditor,
    ...buildStartAndAccept({ chainId: CHAIN_ID, depository, debtor, creditor, offdelta, seedByte, tokenId: BigInt(tokenId), disputeNonce: 1n }),
  }));
  for (const { creditor, start } of disputes) {
    const nonce = BigInt(await jAdapter.depository.entityNonces(creditor.entityId));
    const signed = prepareSignedBatch(start, creditor.entityId, creditor.wallet.privateKey, BigInt(CHAIN_ID), depository, nonce);
    await jAdapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
  }

  // One batch may finalize at most one dispute (DepositoryBounds, E10), so a
  // single batch can never book, drain and rebook the same queue position.
  const combined = createEmptyBatch();
  for (const dispute of disputes) combined.disputeFinalizations.push(...dispute.accept.disputeFinalizations);
  const signedCombined = prepareSignedBatch(combined, debtor.entityId, debtor.wallet.privateKey, BigInt(CHAIN_ID), depository, signedCollateral.nextNonce);
  const tooMany = await jAdapter.depository.processBatch.staticCall(signedCombined.encodedBatch, signedCombined.hankoData, signedCombined.nextNonce)
    .then(() => null, (error: unknown) => error);
  expect(tooMany instanceof Error ? tooMany.message : '').toContain('E10()');

  // Three debtor batches in ONE block, X, Y, Z: X books 60 at index 0; Y returns
  // 100 to reserve; Z's shortfall first enforces X in full (queue reset), pays
  // the 40 left and books 50 at index 0 again.
  const runner = jAdapter.depository.runner as ethers.Signer;
  let txNonce = await provider.getTransactionCount(await runner.getAddress(), 'pending');
  let entityNonce = signedCollateral.nextNonce;
  const sent: string[] = [];
  await provider.send('evm_setAutomine', [false]);
  try {
    for (const dispute of disputes) {
      const signed = prepareSignedBatch(dispute.accept, debtor.entityId, debtor.wallet.privateKey, BigInt(CHAIN_ID), depository, entityNonce);
      entityNonce = signed.nextNonce;
      sent.push((await jAdapter.depository.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce, { nonce: txNonce++, gasLimit: 8_000_000n })).hash);
    }
    await provider.send('evm_mine', []);
  } finally {
    await provider.send('evm_setAutomine', [true]);
  }
  const receipts = await Promise.all(sent.map(hash => provider.getTransactionReceipt(hash)));
  const blockNumber = await provider.getBlockNumber();
  expect(receipts.map(receipt => [receipt?.status, receipt?.blockNumber])).toEqual(sent.map(() => [1, blockNumber]));
  const [xTx, zTx] = [need(sent[0], 'accept X'), need(sent[2], 'accept Z')];

  const debtEvents = (await provider.getLogs({ address: depository, fromBlock: blockNumber, toBlock: blockNumber })).flatMap(log => {
    const raw = decodeJEventLog(log, jAdapter.depository.interface, {
      blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.index,
    }, 'DEBT_ANCHOR_LOG_DECODE');
    if (raw.name !== 'DebtCreated' && raw.name !== 'DebtEnforced') return [];
    return rawEventToJEvents(raw, ethers.ZeroHash).flatMap(event => {
      if (event.type === 'DebtCreated') return [{ log, row: [event.type, event.data.creditor, event.data.debtIndex, BigInt(event.data.amount)] }];
      if (event.type === 'DebtEnforced') return [{ log, row: [event.type, event.data.creditor, event.data.newDebtIndex, BigInt(event.data.remainingAmount)] }];
      return [];
    });
  });
  expect(debtEvents.map(event => event.row)).toEqual([
    ['DebtCreated', x.entityId, 0, 60n],
    ['DebtEnforced', x.entityId, 1, 0n],
    ['DebtCreated', z.entityId, 0, 50n],
  ]);
  // Z's enforcement of X and its own booking share one transaction; X's booking does not.
  expect(debtEvents.map(event => event.log.transactionHash)).toEqual([xTx, zTx, zTx]);

  // The honest fold of the whole block equals storage.
  const current = await anchorStep(jAdapter, parties, debtor, tokenId);
  expect(current.queue).toEqual({ cursor: 0n, length: 1n, outstanding: 50n, entries: [{ index: 0, creditor: z.entityId, amount: 50n }] });
  expect(current.active).toBe(1n);
  expect(current.states.get(x.entityId)?.inDebtsByToken).toBeUndefined();
  const live = need(current.out[0], 'live debt');
  expect([live.creditor, live.createdTxHash, live.createdAtBlock]).toEqual([z.entityId, zTx, blockNumber]);
  const stored = await jAdapter.depository._debts(debtor.entityId, tokenId, 0);
  expect([BigInt(stored.createdBlock), BigInt(stored.createdSeq)]).toEqual([BigInt(blockNumber), live.createdSeq]);

  // The retired creation: same debtor, token, index 0 and block. Its debtId
  // differs only through its transaction hash.
  const stale = await foldDebtEvents(jAdapter, parties, blockNumber, log => log.transactionHash !== zTx);
  const retired = need([...(stale.get(debtor.entityId)?.outDebtsByToken?.get(tokenId)?.values() ?? [])][0], 'retired debt');
  expect([retired.creditor, retired.createdTxHash, retired.createdAtBlock, retired.createdDebtIndex])
    .toEqual([x.entityId, xTx, blockNumber, 0]);
  expect(retired.createdSeq).toBeLessThan(live.createdSeq);
  expect(retired.debtId).not.toBe(live.debtId);
  expect(retired.debtId.replace(xTx.toLowerCase(), zTx.toLowerCase())).toBe(live.debtId);

  // Serving that retired creation alone does not pass for the live entry.
  const block = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string };
  await expect(assertEntityOutDebtsMatchAnchor({
    send: (method: string, params: unknown[]) => provider.send(method, params),
    jurisdiction,
    blockNumber,
    authenticatedBlockHash: block.hash,
    entities: [{ entityId: debtor.entityId, outDebtsByToken: stale.get(debtor.entityId)?.outDebtsByToken }],
  })).rejects.toThrow('DEBT_ANCHOR_MISMATCH');
}, 60_000);
