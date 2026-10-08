import { strict as assert } from 'node:assert';
import { TronWeb } from 'tronweb';
import { getBytes, zeroPadValue } from 'ethers';
import { createJAdapter } from '../../../core/jurisdiction/adapter';
import { createEmptyBatch } from '../../../core/jurisdiction/machine/batch';
import { prepareSignedBatch } from '../../../core/hanko/batch';

/** Test provisioning on the pinned disposable TVM: real mock-token mint and signed deposit, never debugFundReserves. */
export async function fundNativeOrchestratorFixture(data: string, api: string, out: string): Promise<void> {
  const graph = await Bun.file(`${data}/graph.json`).json();
  const token = await Bun.file(`${data}/token.json`).json();
  const key = `0x${'1'.padStart(64, '0')}`;
  const owner = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
  const tron = new TronWeb({ fullHost: graph.chain.defaultFullHost, solidityNode: graph.chain.defaultSolidityHost, privateKey: key.slice(2) });
  const adapter = await createJAdapter({ mode: 'tron', chainId: graph.chainId, rpcUrl: graph.chain.defaultRpc,
    tronFullHost: graph.chain.defaultFullHost, tronSolidityHost: graph.chain.defaultSolidityHost, privateKey: key,
    fromReplica: { contracts: graph.contracts, entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock } });
  try {
    let entities: Array<{entityId: string; tokens: Array<{tokenId: number; expectedMin: string}>}> = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (response?.ok) entities = (await response.json()).bootstrapReserves.entities;
      if (entities.length === 3 && entities.every(entity => entity.tokens.length === 1 && entity.tokens[0]?.tokenId === 1)) break;
      await Bun.sleep(100);
    }
    assert.equal(entities.length, 3);
    const batch = createEmptyBatch();
    for (const entity of entities) {
      assert.equal(entity.tokens.length, 1);
      const asset = entity.tokens[0];
      assert(asset);
      const target = BigInt(asset.expectedMin);
      const current = await adapter.getReserves(entity.entityId, 1);
      if (current >= target) continue;
      batch.externalTokenToReserve.push({ entity: entity.entityId, contractAddress: token.evm, tokenType: 0,
        externalTokenId: 0n, internalTokenId: 1, amount: target - current });
    }
    const total = batch.externalTokenToReserve.reduce((sum, deposit) => sum + deposit.amount, 0n);
    if (total > 0n) {
      const current = await adapter.getErc20Balance(token.evm, owner);
      if (current < total) {
        const abi = (await Bun.file('jurisdictions/artifacts/contracts/ERC20Mock.sol/ERC20Mock.json').json()).abi;
        const contract = tron.contract(abi, token.base58);
        await contract['mint'](TronWeb.address.fromHex(`41${owner.slice(2)}`), String(total - current + 1_000_000n)).send({ feeLimit: Number(process.env['TRON_FEE_LIMIT']), shouldPollResponse: true });
      }
      assert(await adapter.getErc20Allowance(token.evm, owner, graph.contracts.depository) >= total);
      const foundation = zeroPadValue('0x01', 32);
      const signed = prepareSignedBatch(batch, foundation, getBytes(key), BigInt(graph.chainId), graph.contracts.depository, await adapter.getEntityNonce(foundation));
      const receipt = await adapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
      await Bun.write(`${out}/mesh-funding.json`, JSON.stringify({ total: String(total), receipt, entities }, (_, value) => typeof value === 'bigint' ? String(value) : value));
    }
    for (const entity of entities) {
      const asset = entity.tokens[0];
      assert(asset);
      assert(await adapter.getReserves(entity.entityId, 1) >= BigInt(asset.expectedMin));
    }
  } finally { await adapter.close(); }
}
