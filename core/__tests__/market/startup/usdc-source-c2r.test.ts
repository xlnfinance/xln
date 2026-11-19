import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider, Transaction, Wallet, hexlify, keccak256 } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { readVaultSeed } from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/identities';
import {
  candidateDigest,
  candidateHead,
  catalogDigest,
} from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/authority';
import { deriveSignerKeySync } from '../../../account/crypto';
import { isLeftEntity } from '../../../account/utils';
import { buildSingleSignerHanko, prepareSignedBatch } from '../../../hanko/batch';
import { computeAccountKey } from '../../../jurisdiction/adapter/events/contract-codec';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import { createSettlementHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { compileOps } from '../../../protocol/settlement/operations';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import { createUsdcFixture, stopFixtureChildren, until } from './usdc-session/fixture';

test('a source C2R grant admits one exact settlement and recovers the same receipt after restarting the gateway', async () => {
  const fixture = await createUsdcFixture({ reserves: [1_000_001n, 1_000_000n], operators: 'defer' });
  const { root, apiBase } = fixture;
  const [source, target] = fixture.chains;
  const rpcs = [fixture.rpcUpstreams.get('/rpc')!, fixture.rpcUpstreams.get('/rpc2')!];
  const provider = new JsonRpcProvider(rpcs[0], undefined, { cacheTimeout: -1 });
  const targetProvider = new JsonRpcProvider(rpcs[1], undefined, { cacheTimeout: -1 });
  const hub = fixture.identities.find(identity => identity.role === 'hub')!.chains[0]!;
  const user = fixture.identities.find(identity => identity.role === 'user')!.chains[0]!;
  const payer = new Wallet(hexlify(deriveSignerKeySync(readVaultSeed(join(root, 'hub')), '1')), provider);
  const userKey = deriveSignerKeySync(readVaultSeed(join(root, 'user')), '1');
  const depository = Depository__factory.connect(source!.contracts.depository, payer);
  const key = computeAccountKey(hub.entityId, user.entityId);
  const amount = 1_000_000n;
  const targetReserve = Depository__factory.connect(target!.contracts.depository, targetProvider);
  const targetHub = fixture.identities.find(identity => identity.role === 'hub')!.chains[1]!;
  const rpc = async (path: string, method: string, ...params: string[]) => {
    const response = await fetch(apiBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeStringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return requireBoundaryRecord(await response.json(), 'TEST_C2R_RPC_RESPONSE');
  };
  const start = async (name: string, args: string[]) => {
    const child = fixture.launch(
      name,
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts',
      ['--api-base', apiBase, ...args],
      { ...fixture.roleEnv('user'), ETH_SEPOLIA_RPC: rpcs[0], ARB_SEPOLIA_RPC: rpcs[1] },
    );
    await until('source-c2r-gateway', async () => {
      if (child.exitCode !== null) throw new Error(readFileSync(join(root, name + '.log'), 'utf8'));
      try {
        return (await rpc('/rpc', 'eth_chainId'))['result'] === '0xaa36a7';
      } catch {
        return false;
      }
    });
    return child;
  };
  try {
    await provider.send('anvil_nodeInfo', []);
    const sponsor = Wallet.fromPhrase('test test test test test test test test test test test junk', provider);
    await (await sponsor.sendTransaction({ to: payer.address, value: 10n ** 18n })).wait();
    expect(payer.address.toLowerCase()).toBe(hub.signerId);
    const setup = createEmptyBatch();
    setup.reserveToCollateral.push({
      tokenId: 1,
      receivingEntity: hub.entityId,
      pairs: [{ entity: user.entityId, amount }],
    });
    const sourceContract = await depository.getAddress();
    const initial = prepareSignedBatch(setup, hub.entityId, payer.privateKey, 11155111n, sourceContract, 0n);
    await (await depository.processBatch(initial.encodedBatch, initial.hankoData, initial.nextNonce)).wait();
    const anchor = await provider.getBlock('latest');
    const firstNonce = await provider.getTransactionCount(payer.address);
    const prevNonce = await depository.entityNonces(hub.entityId);
    const token = source!.tokens.USDC.address;
    const contracts = [...new Set([...Object.values(source!.contracts), token])];
    const codeHashes = Object.fromEntries(
      await Promise.all(contracts.map(async addr => [addr.toLowerCase(), keccak256(await provider.getCode(addr))])),
    );
    const authority = {
      version: 1,
      operation: 'source-c2r',
      approved: true,
      apiBase,
      expiresAt: Date.now() + 120_000,
      candidateHead: candidateHead(),
      candidateDigest: candidateDigest(),
      catalogDigest: catalogDigest(join(root, 'jurisdictions.json')),
      chain: {
        chainId: 11155111,
        anchorNumber: anchor!.number,
        anchorHash: anchor!.hash,
        depository: sourceContract,
        token,
        entityProvider: source!.contracts.entityProvider,
        codeHashes,
      },
      hubEntity: hub.entityId,
      userEntity: user.entityId,
      userSigner: user.signerId,
      payer: {
        address: hub.signerId,
        firstNonce,
        gasLimit: '600000',
        maxFeePerGasWei: '5000000000',
        maxPriorityFeePerGasWei: '1000000000',
        totalFeeLimitWei: '3000000000000000',
      },
      settlement: {
        amountAtoms: '1000000',
        accountNonceBefore: 0,
        accountNonce: 8,
        hubBatchNonce: String(prevNonce + 1n),
        hubReserveBeforeAtoms: '1',
        userReserveBeforeAtoms: '0',
      },
    };
    const manifest = join(root, 'source-c2r.json');
    writeFileSync(manifest, safeStringify(authority), { mode: 0o600 });
    const hubIsLeft = isLeftEntity(hub.entityId, user.entityId);
    const [leftEntity, rightEntity] = hubIsLeft ? [hub.entityId, user.entityId] : [user.entityId, hub.entityId];
    const signedWire = async (requested = amount, wrongHanko?: 'user' | 'hub', extraOperation = false) => {
      const { diffs, forgiveTokenIds } = compileOps([{ type: 'c2r', tokenId: 1, amount: requested }], hubIsLeft);
      const hash = createSettlementHashWithNonce(
        { leftEntity, rightEntity },
        diffs,
        forgiveTokenIds,
        { chainId: 11155111, depositoryAddress: sourceContract },
        8,
      );
      const sig =
        wrongHanko === 'user'
          ? buildSingleSignerHanko(hub.entityId, hash, payer.privateKey)
          : buildSingleSignerHanko(user.entityId, hash, userKey);
      const batch = createEmptyBatch();
      batch.collateralToReserve.push({ counterparty: user.entityId, tokenId: 1, amount: requested, nonce: 8, sig });
      if (extraOperation) batch.reserveToReserve.push({ receivingEntity: user.entityId, tokenId: 1, amount: 1n });
      const signed =
        wrongHanko === 'hub'
          ? prepareSignedBatch(batch, user.entityId, userKey, 11155111n, sourceContract, prevNonce)
          : prepareSignedBatch(batch, hub.entityId, payer.privateKey, 11155111n, sourceContract, prevNonce);
      const data = depository.interface.encodeFunctionData('processBatch', [
        signed.encodedBatch,
        signed.hankoData,
        signed.nextNonce,
      ]);
      return payer.signTransaction({
        chainId: 11155111,
        type: 2,
        to: sourceContract,
        data,
        nonce: firstNonce,
        value: 0n,
        gasLimit: 600_000n,
        maxFeePerGas: 4_000_000_000n,
        maxPriorityFeePerGas: 500_000_000n,
      });
    };
    fixture.closeGateway();
    const args = ['--source-c2r-authority-file', manifest];
    const gateway = await start('source-c2r-gateway', args);
    const raw = await signedWire();
    const transaction = Transaction.from(raw);
    const sourceCall = (wire: string) => rpc('/rpc', 'eth_sendRawTransaction', wire);
    expect((await rpc('/rpc', 'xln_executionAuthority'))['result']).toMatch(/^[0-9a-f]{64}$/);
    expect((await rpc('/rpc2', 'xln_executionAuthority'))['error']).toBeDefined();
    expect((await rpc('/history/rpc', 'xln_executionAuthority'))['error']).toBeDefined();
    for (const [route, wire] of [
      ['/rpc2', raw],
      ['/history/rpc', raw],
      ['/rpc', await signedWire(amount - 1n)],
      ['/rpc', await signedWire(amount, 'user')],
      ['/rpc', await signedWire(amount, 'hub')],
      ['/rpc', await signedWire(amount, undefined, true)],
      ['/rpc', await payer.signTransaction({ ...transaction.toJSON(), gasLimit: 25_000n })],
      ['/rpc', await payer.signTransaction({ ...transaction.toJSON(), maxFeePerGas: 5_000_000_001n })],
    ] as const) {
      expect((await rpc(route, 'eth_sendRawTransaction', wire))['error']).toBeDefined();
    }
    expect(await provider.getTransactionCount(payer.address)).toBe(firstNonce);
    expect((await depository._collaterals(key, 1)).collateral).toBe(amount);
    await provider.send('evm_setIntervalMining', [0]);
    await provider.send('evm_setAutomine', [false]);
    const [one, two] = await Promise.all([sourceCall(raw), sourceCall(raw)]);
    expect(one['result'], readFileSync(join(root, 'source-c2r-gateway.log'), 'utf8')).toBe(transaction.hash!);
    expect(two['result']).toBe(transaction.hash!);
    const replacement = await payer.signTransaction({
      ...transaction.toJSON(),
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    expect((await sourceCall(replacement))['error']).toBeDefined();
    expect(await provider.getTransactionCount(payer.address, 'latest')).toBe(firstNonce);
    expect(await provider.getTransactionCount(payer.address, 'pending')).toBe(firstNonce + 1);
    await provider.send('evm_mine', []);
    const receipt = await provider.waitForTransaction(transaction.hash!);
    expect(receipt?.status).toBe(1);
    expect((await depository._collaterals(key, 1)).collateral).toBe(0n);
    expect(await depository._reserves(hub.entityId, 1)).toBe(1_000_001n);
    expect(await depository._reserves(user.entityId, 1)).toBe(0n);
    expect(await targetReserve._reserves(targetHub.entityId, 1)).toBe(1_000_000n);

    await stopFixtureChildren([gateway]);
    await start('source-c2r-restarted', args);
    expect((await sourceCall(raw))['result']).toBe(transaction.hash!);
    const extra = await payer.signTransaction({ ...transaction.toJSON(), nonce: firstNonce + 1 });
    expect((await sourceCall(replacement))['error']).toBeDefined();
    expect((await sourceCall(extra))['error']).toBeDefined();
    expect(await provider.getTransactionCount(payer.address)).toBe(firstNonce + 1);
    console.log(`USDC_SOURCE_C2R_LOCAL_EVIDENCE:${root}:${transaction.hash}`);
  } finally {
    provider.destroy();
    targetProvider.destroy();
    await fixture.close();
  }
}, 90_000);
