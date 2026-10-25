import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import { encodeSingleSignerBoard, hashBoard } from '../../../../entity/factory';
import { createJAdapter, createXlnJsonRpcProvider } from '../../../../jurisdiction/adapter';
import type { JAdapter } from '../../../../jurisdiction/adapter/types';
import { verifyGetProofResponse, type GetProofResponse } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-state-proof';
import {
  depositoryEntityNonceSlot,
  depositoryReserveSlot,
  depositoryTokenCountSlot,
  entityProviderActionNonceSlot,
  entityProviderBoardEpochSlot,
  entityProviderCommittedBoardSlot,
  entityProviderFieldSlot,
  entityProviderNextNumberSlot,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-storage-slots';

const CHAIN_ID = 31_337;
const TOKEN_ID = 1n;
const MINTED = 123_456_789n;

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

let anvil: ChildProcess | null = null;
let adapter: JAdapter | null = null;
let provider: ethers.JsonRpcProvider;

beforeAll(async () => {
  const port = await reservePort();
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
}, 60_000);

afterAll(async () => {
  await provider?.destroy();
  anvil?.kill('SIGKILL');
});

test('derived Depository/EntityProvider slots prove the same values as the contract getters', async () => {
  const jAdapter = adapter!;
  const encodedBoard = encodeSingleSignerBoard(ethers.Wallet.createRandom().address);
  const boardHash = hashBoard(encodedBoard).toLowerCase();
  await (await jAdapter.entityProvider.registerNumberedEntity(encodedBoard)).wait();
  const entityNumber = (await jAdapter.entityProvider.nextNumber()) - 1n;
  const entityId = ethers.toBeHex(entityNumber, 32);
  const receipt = await (await jAdapter.depository.mintToReserve(entityId, TOKEN_ID, MINTED)).wait();
  const blockTag = ethers.toQuantity(Number(receipt!.blockNumber));
  const block = await provider.send('eth_getBlockByNumber', [blockTag, false]);
  const stateRoot = String(block.stateRoot);

  const prove = async (address: string, slots: bigint[]) => {
    const response = (await provider.send(
      'eth_getProof',
      [address, slots.map(slot => ethers.toBeHex(slot, 32)), blockTag],
    )) as GetProofResponse;
    return verifyGetProofResponse(stateRoot, address, slots, response).storage;
  };

  const entitySlots = {
    nextNumber: entityProviderNextNumberSlot(),
    currentBoardHash: entityProviderFieldSlot(entityId, 'currentBoardHash'),
    previousBoardHash: entityProviderFieldSlot(entityId, 'previousBoardHash'),
    previousBoardValidUntil: entityProviderFieldSlot(entityId, 'previousBoardValidUntil'),
    registrationBlock: entityProviderFieldSlot(entityId, 'registrationBlock'),
    boardEpoch: entityProviderBoardEpochSlot(entityId),
    actionNonce: entityProviderActionNonceSlot(entityId),
    committedBoard: entityProviderCommittedBoardSlot(boardHash),
  };
  const ep = await prove(jAdapter.addresses.entityProvider, Object.values(entitySlots));
  const onChainEntity = await jAdapter.entityProvider.entities(entityId, { blockTag });
  expect(ep.get(entitySlots.nextNumber)).toBe(await jAdapter.entityProvider.nextNumber({ blockTag }));
  expect(ethers.toBeHex(ep.get(entitySlots.currentBoardHash)!, 32)).toBe(boardHash);
  expect(ethers.toBeHex(ep.get(entitySlots.currentBoardHash)!, 32)).toBe(String(onChainEntity.currentBoardHash).toLowerCase());
  expect(ep.get(entitySlots.previousBoardHash)).toBe(BigInt(onChainEntity.previousBoardHash));
  expect(ep.get(entitySlots.previousBoardValidUntil)).toBe(BigInt(onChainEntity.previousBoardValidUntil));
  expect(ep.get(entitySlots.registrationBlock)).toBe(BigInt(onChainEntity.registrationBlock));
  expect(ep.get(entitySlots.registrationBlock)).toBeGreaterThan(0n);
  expect(ep.get(entitySlots.boardEpoch)).toBe(await jAdapter.entityProvider.boardEpochs(entityId, { blockTag }));
  expect(ep.get(entitySlots.actionNonce)).toBe(await jAdapter.entityProvider.entityActionNonces(entityId, { blockTag }));
  expect(ep.get(entitySlots.committedBoard)).toBe(1n);

  const depositorySlots = {
    reserve: depositoryReserveSlot(entityId, TOKEN_ID),
    entityNonce: depositoryEntityNonceSlot(entityId),
    tokenCount: depositoryTokenCountSlot(),
  };
  const dep = await prove(jAdapter.addresses.depository, Object.values(depositorySlots));
  expect(dep.get(depositorySlots.reserve)).toBe(MINTED);
  expect(dep.get(depositorySlots.reserve)).toBe(await jAdapter.depository._reserves(entityId, TOKEN_ID, { blockTag }));
  expect(dep.get(depositorySlots.entityNonce)).toBe(await jAdapter.depository.entityNonces(entityId, { blockTag }));
  expect(dep.get(depositorySlots.tokenCount)).toBe(await jAdapter.depository.getTokensLength({ blockTag }));
  expect(dep.get(depositorySlots.tokenCount)).toBeGreaterThan(TOKEN_ID);
}, 60_000);
