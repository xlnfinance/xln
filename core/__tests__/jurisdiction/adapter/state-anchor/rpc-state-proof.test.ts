import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import {
  EMPTY_TRIE_ROOT,
  verifyAccountProof,
  verifyGetProofResponse,
  verifyStorageProof,
  type GetProofResponse,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-state-proof';

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcad083cddc9fd5e1d';
const SLOT_COUNT = 16;

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });

// Init code: SSTORE(slot i, i+1) for i < SLOT_COUNT, then return empty runtime code.
const storingInitCode = (): string => {
  let code = '';
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    code += `60${(slot + 1).toString(16).padStart(2, '0')}60${slot.toString(16).padStart(2, '0')}55`;
  }
  return `0x${code}60006000f3`;
};

let anvil: ChildProcess | null = null;
let provider: ethers.JsonRpcProvider;
let contract = '';
let deployer = '';
let blockTag = '';
let stateRoot = '';
let previousStateRoot = '';

const getProof = async (address: string, slots: readonly bigint[], tag = blockTag): Promise<GetProofResponse> =>
  (await provider.send('eth_getProof', [address, slots.map(slot => ethers.toBeHex(slot, 32)), tag])) as GetProofResponse;

const allSlots = Array.from({ length: SLOT_COUNT }, (_, slot) => BigInt(slot));

beforeAll(async () => {
  const port = await reservePort();
  anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], {
    stdio: 'ignore',
  });
  provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await provider.getBlockNumber();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const wallet = new ethers.Wallet(ANVIL_KEY, provider);
  deployer = wallet.address;
  await provider.send('anvil_setBalance', [deployer, ethers.toQuantity(ethers.parseEther('10'))]);
  const before = await provider.send('eth_getBlockByNumber', ['latest', false]);
  previousStateRoot = String(before.stateRoot);
  const receipt = await (await wallet.sendTransaction({ data: storingInitCode() })).wait();
  contract = String(receipt?.contractAddress);
  blockTag = ethers.toQuantity(Number(receipt?.blockNumber));
  const block = await provider.send('eth_getBlockByNumber', [blockTag, false]);
  stateRoot = String(block.stateRoot);
}, 30_000);

afterAll(() => {
  anvil?.kill('SIGKILL');
});

describe('eth_getProof verification against an authenticated stateRoot', () => {
  test('proves every stored slot, a missing slot and the contract account', async () => {
    const slots = [...allSlots, 99n];
    const verified = verifyGetProofResponse(stateRoot, contract, slots, await getProof(contract, slots));
    expect(verified.account).not.toBeNull();
    expect(verified.account!.nonce).toBe(1n);
    expect(verified.account!.codeHash).toBe(ethers.keccak256('0x'));
    expect(verified.account!.storageRoot).not.toBe(EMPTY_TRIE_ROOT);
    for (const slot of allSlots) expect(verified.storage.get(slot)).toBe(slot + 1n);
    expect(verified.storage.get(99n)).toBe(0n);
  });

  test('proves an externally owned balance and an absent account', async () => {
    const eoa = verifyGetProofResponse(stateRoot, deployer, [], await getProof(deployer, []));
    expect(eoa.account!.balance).toBe(await provider.getBalance(deployer, blockTag));
    expect(eoa.account!.nonce).toBe(1n);

    const absentAddress = ethers.Wallet.createRandom().address;
    const absent = await getProof(absentAddress, [0n]);
    expect(verifyAccountProof(stateRoot, absentAddress, absent.accountProof as string[])).toBeNull();
    expect(verifyStorageProof(EMPTY_TRIE_ROOT, 0n, [])).toBe(0n);
    const absentVerified = verifyGetProofResponse(stateRoot, absentAddress, [0n], absent);
    expect(absentVerified.account).toBeNull();
    expect(absentVerified.storage.get(0n)).toBe(0n);
  });

  test('rejects proofs not bound to the authenticated root', async () => {
    const response = await getProof(contract, [3n]);
    const accountProof = response.accountProof as string[];
    // The contract did not exist one block earlier; the current proof cannot verify there.
    expect(() => verifyAccountProof(previousStateRoot, contract, accountProof)).toThrow('STATE_PROOF_NODE_HASH_MISMATCH');

    const tampered = [...accountProof];
    const lastNode = tampered.at(-1);
    if (lastNode === undefined) throw new Error('STATE_PROOF_TEST_EMPTY_ACCOUNT_PROOF');
    const last = ethers.getBytes(lastNode);
    const lastByte = last.at(-1);
    if (lastByte === undefined) throw new Error('STATE_PROOF_TEST_EMPTY_NODE');
    last[last.length - 1] = lastByte ^ 1;
    tampered[tampered.length - 1] = ethers.hexlify(last);
    expect(() => verifyAccountProof(stateRoot, contract, tampered)).toThrow('STATE_PROOF_NODE_HASH_MISMATCH');

    expect(() => verifyAccountProof(stateRoot, contract, accountProof.slice(0, -1))).toThrow('STATE_PROOF_MISSING_NODE');
    expect(() => verifyAccountProof(stateRoot, contract, [...accountProof, accountProof[0]!])).toThrow(
      'STATE_PROOF_TRAILING_NODES',
    );
  });

  test('rejects storage proofs for another slot and forged summary fields', async () => {
    const response = await getProof(contract, [1n]);
    const entry = (response.storageProof as Array<{ proof: string[] }>)[0]!;
    const storageRoot = String(response.storageHash);
    expect(verifyStorageProof(storageRoot, 1n, entry.proof)).toBe(2n);
    expect(() => verifyStorageProof(storageRoot, 2n, entry.proof)).toThrow(/STATE_PROOF_/);

    const forgedValue = structuredClone(response);
    (forgedValue.storageProof as Array<{ value: string }>)[0]!.value = '0x3';
    expect(() => verifyGetProofResponse(stateRoot, contract, [1n], forgedValue)).toThrow('STATE_PROOF_STORAGE_VALUE_MISMATCH');

    const forgedBalance = { ...response, balance: '0x1' };
    expect(() => verifyGetProofResponse(stateRoot, contract, [1n], forgedBalance)).toThrow('STATE_PROOF_BALANCE_MISMATCH');

    expect(() => verifyGetProofResponse(stateRoot, contract, [2n], response)).toThrow('STATE_PROOF_STORAGE_KEY_MISMATCH');
    expect(() => verifyGetProofResponse(stateRoot, contract, [1n, 2n], response)).toThrow('STATE_PROOF_STORAGE_PROOF_COUNT');
  });
});
