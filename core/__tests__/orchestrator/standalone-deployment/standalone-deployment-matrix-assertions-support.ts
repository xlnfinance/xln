import { expect } from 'bun:test';
import { getCreateAddress, toBeHex, zeroPadValue } from 'ethers';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EntityProvider__factory } from '../../../../jurisdictions/typechain-types/factories/EntityProvider__factory';
import { Depository__factory } from '../../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { launchDeployment } from './standalone-deployment-process-support';
import { journalMessages, readJson, type Fixture } from './standalone-deployment-transactions-support';

export const intendedOperations = [
  'account', 'hankoVerifier', 'entityProvider', 'deltaTransformer', 'depositoryBounds',
  'hashLadderRegistry', 'nftCustody', 'depository', 'bindTransformer', 'bindShares', 'registerStablecoin',
] as const;
export const poisonCatalog = '{catalog-must-not-be-read:ticket-07';

export const verifyMatrixCompletion = async (fixture: Fixture, result: any, initialBalance: bigint) => {
  const messages = await journalMessages(fixture);
  const sends = messages.filter(message => message.type === 'TRANSACTION_SEND');
  const confirmations = messages.filter(message => message.type === 'TRANSACTION_CONFIRM');
  expect(sends.map(message => message.futureId.split('#').at(-1))).toEqual([...intendedOperations]);
  expect(new Set(sends.map(message => message.transaction.hash)).size).toBe(11);
  expect(sends.map(message => message.nonce)).toEqual(intendedOperations.map((_, index) => fixture.initialNonce + index));
  expect(confirmations).toHaveLength(11);
  expect(new Set(confirmations.map(message => message.hash)).size).toBe(11);
  const receipts = [];
  let fees = 0n;
  for (const send of sends) {
    const transaction = await fixture.provider.getTransaction(send.transaction.hash);
    const receipt = await fixture.provider.getTransactionReceipt(send.transaction.hash);
    expect(transaction!.nonce).toBe(send.nonce);
    expect(receipt!.status).toBe(1);
    fees += receipt!.fee;
    receipts.push(receipt!.toJSON());
  }
  expect(result.manifest.deploymentId).toBe('resume-usdc');
  expect(result.manifest.chainId).toBe(31337);
  expect(Object.values(result.manifest.evmContracts).map((entry: any) => entry.transactionHash).sort()).toEqual(
    sends.map(message => message.transaction.hash).sort());
  expect(result.expenses.broadcasts).toBe(11);
  expect(result.expenses.mined).toBe(11);
  expect(BigInt(result.expenses.attemptTransactionFeesWei)).toBe(fees);
  expect(initialBalance - await fixture.provider.getBalance(fixture.signer.address)).toBe(fees);
  expect(result.expenses.balance.deltaWei).toBe(fees.toString());
  expect(result.expenses.balance.unaccountedDeltaWei).toBe('0');
  const entityProvider = result.manifest.contracts.entityProvider;
  expect(entityProvider).toBe(getCreateAddress({ from: fixture.signer.address, nonce: fixture.initialNonce + 2 }));
  if (fixture.initialNonce !== 1) {
    expect(entityProvider).not.toBe(getCreateAddress({ from: fixture.signer.address, nonce: 3 }));
  }
  const ep = EntityProvider__factory.connect(entityProvider, fixture.provider);
  expect(await ep.entityActionNonces(zeroPadValue(toBeHex(1), 32))).toBe(1n);
  const depository = Depository__factory.connect(result.manifest.contracts.depository, fixture.provider);
  expect(await depository.getTokensLength()).toBe(2n);
  expect((await depository._tokens(1)).contractAddress).toBe(fixture.request.stablecoin.address);
  expect(result.manifest.registeredTokens).toEqual({ USDC: { address: fixture.request.stablecoin.address, tokenId: 1, decimals: 6 } });
  expect(result.verification).toMatchObject({ exactBytecode: true, constructorsAndBindings: true, foundationAndToken: true, confirmations: 12 });
  expect(await readFile(fixture.catalog, 'utf8')).toBe(poisonCatalog);
  return { sends, confirmations, receipts, feesWei: fees.toString() };
};

export const verifyCompletedReruns = async (fixture: Fixture, result: any, interruptedPath: string) => {
  const journal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
  const interrupted = await readFile(interruptedPath, 'utf8');
  const before = fixture.submissions();
  const outcomes = [];
  for (const reconstruct of [false, true]) {
    if (reconstruct) {
      await rm(join(fixture.nativeDirectory, 'manifest.json'));
      await rm(join(fixture.nativeDirectory, 'result.json'));
    }
    const session = launchDeployment(fixture, reconstruct ? 'matrix-reconstructed' : 'matrix-completed-rerun', { mode: 'resume' });
    try {
      expect(await session.exited).toBe(0);
      const repeated = await readJson(join(fixture.nativeDirectory, 'result.json'));
      expect(repeated.manifest).toEqual(result.manifest);
      expect(repeated.expenses).toEqual(result.expenses);
      expect(repeated.verification).toEqual(result.verification);
      expect(await readJson(join(fixture.nativeDirectory, 'manifest.json'))).toEqual(result.manifest);
      expect(await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8')).toBe(journal);
      expect(await readFile(interruptedPath, 'utf8')).toBe(interrupted);
      expect(await readFile(fixture.catalog, 'utf8')).toBe(poisonCatalog);
      expect(fixture.submissions()).toBe(before);
      outcomes.push({ reconstruct, result: repeated, additionalSends: fixture.submissions() - before });
    } finally { await session.stop(); }
  }
  return outcomes;
};
